import { nowUtcIso } from "@citera/domain";
import { handleJob } from "./handlers";
import { jobIdempotencyKey, retryDelaySeconds, shouldRetry } from "./idempotency";
import { all, first, type Row } from "./db";
import { JobError, JobMessageSchema, type Env, type JobMessage } from "./types";

interface JobRun extends Record<string, unknown> {
  state: "running" | "retrying" | "complete" | "failed";
  attempts: number;
  updated_at: string;
}

interface OwnerDeletionState extends Record<string, unknown> {
  deletion_requested_at: string | null;
}

interface DeletingUser extends Record<string, unknown> {
  id: string;
  deletion_generation: number;
}

type ClaimResult =
  | { state: "claimed"; attempts: number }
  | { state: "busy"; retryAfterSeconds: number }
  | { state: "terminal" };

const CLAIM_STALE_MS = 15 * 60_000;
const ACCOUNT_DELETE_GRACE_MS = 20 * 60_000;
const ACCOUNT_DELETE_RECOVERY_MS = 2 * 60 * 60_000;

async function claimJob(env: Env, job: JobMessage, key: string): Promise<ClaimResult> {
  const now = nowUtcIso();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO job_runs
      (idempotency_key,job_id,type,user_id,paper_id,source_version,state,attempts,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'running',1,?,?)`,
  )
    .bind(key, job.jobId, job.type, job.userId, job.paperId ?? null, job.sourceVersion, now, now)
    .run();
  if (inserted.meta.changes === 1) return { state: "claimed", attempts: 1 };
  const existing = await first<JobRun>(
    env.DB,
    "SELECT state,attempts,updated_at FROM job_runs WHERE idempotency_key=?",
    key,
  );
  if (!existing || existing.state === "complete" || existing.state === "failed") {
    return { state: "terminal" };
  }
  if (existing.state === "running") {
    const claimedAt = new Date(existing.updated_at).getTime();
    const staleAt = claimedAt + CLAIM_STALE_MS;
    if (Number.isFinite(claimedAt) && staleAt > Date.now()) {
      return {
        state: "busy",
        retryAfterSeconds: Math.max(1, Math.ceil((staleAt - Date.now()) / 1_000) + 1),
      };
    }
    const reclaimed = await env.DB.prepare(
      `UPDATE job_runs SET attempts=attempts+1,job_id=?,updated_at=?
       WHERE idempotency_key=? AND state='running' AND updated_at=?`,
    )
      .bind(job.jobId, now, key, existing.updated_at)
      .run();
    return reclaimed.meta.changes === 1
      ? { state: "claimed", attempts: Number(existing.attempts) + 1 }
      : { state: "busy", retryAfterSeconds: 5 };
  }
  const claimed = await env.DB.prepare(
    `UPDATE job_runs SET state='running',attempts=attempts+1,job_id=?,updated_at=?,error_code=NULL,error_message=NULL
     WHERE idempotency_key=? AND state='retrying'`,
  )
    .bind(job.jobId, now, key)
    .run();
  return claimed.meta.changes === 1
    ? { state: "claimed", attempts: Number(existing.attempts) + 1 }
    : { state: "busy", retryAfterSeconds: 5 };
}

async function finishJob(env: Env, key: string, result: Record<string, unknown>): Promise<void> {
  const now = nowUtcIso();
  await env.DB.prepare(
    `UPDATE job_runs SET state='complete',result_json=?,updated_at=?,completed_at=?,error_code=NULL,error_message=NULL
     WHERE idempotency_key=?`,
  )
    .bind(JSON.stringify(result), now, now, key)
    .run();
}

async function failJob(
  env: Env,
  job: JobMessage,
  key: string,
  error: JobError,
  retrying: boolean,
): Promise<void> {
  const now = nowUtcIso();
  await env.DB.prepare(
    `UPDATE job_runs SET state=?,error_code=?,error_message=?,updated_at=?,completed_at=? WHERE idempotency_key=?`,
  )
    .bind(
      retrying ? "retrying" : "failed",
      error.code,
      error.message.slice(0, 2_000),
      now,
      retrying ? null : now,
      key,
    )
    .run();
  if (
    !retrying &&
    (job.type === "metadata.refresh" || job.type === "paper.enrich") &&
    job.paperId
  ) {
    await env.DB.prepare(
      "UPDATE papers SET metadata_state='failed',updated_at=? WHERE id=? AND user_id=?",
    )
      .bind(now, job.paperId, job.userId)
      .run();
  }
  if (!retrying && job.type === "export.generate" && job.exportId) {
    await env.DB.prepare(
      "UPDATE export_jobs SET state='failed',error_message=? WHERE id=? AND user_id=?",
    )
      .bind(error.message.slice(0, 2_000), job.exportId, job.userId)
      .run();
  }
}

async function processMessage(message: Message<unknown>, env: Env): Promise<void> {
  const parsed = JobMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    console.error("Discarding invalid Citera queue message", { issues: parsed.error.issues });
    message.ack();
    return;
  }
  const job = parsed.data;
  const owner = await first<OwnerDeletionState>(
    env.DB,
    "SELECT deletion_requested_at FROM users WHERE id=?",
    job.userId,
  );
  if (job.type === "account.delete") {
    if (owner?.deletion_requested_at) {
      const requestedAt = new Date(owner.deletion_requested_at).getTime();
      const readyAt = requestedAt + ACCOUNT_DELETE_GRACE_MS;
      if (Number.isFinite(requestedAt) && readyAt > Date.now()) {
        message.retry({
          delaySeconds: Math.max(1, Math.ceil((readyAt - Date.now()) / 1_000) + 1),
        });
        return;
      }
    }
  } else if (!owner || owner.deletion_requested_at) {
    // A deletion tombstone fences every new job before it can write D1 or R2.
    message.ack();
    return;
  }
  const key = jobIdempotencyKey(job);
  const claim = await claimJob(env, job, key);
  if (claim.state === "terminal") {
    message.ack();
    return;
  }
  if (claim.state === "busy") {
    message.retry({ delaySeconds: claim.retryAfterSeconds });
    return;
  }
  const attempts = claim.attempts;
  try {
    const result = await handleJob(env, job);
    await finishJob(env, key, result);
    message.ack();
  } catch (unknownError) {
    const error =
      unknownError instanceof JobError
        ? unknownError
        : new JobError(
            "UNEXPECTED_JOB_ERROR",
            unknownError instanceof Error ? unknownError.message : "Unexpected job error",
            true,
          );
    const maximum = Math.min(Math.max(Number(env.MAX_JOB_ATTEMPTS) || 5, 1), 10);
    const retrying = shouldRetry(error.transient, attempts, maximum);
    await failJob(env, job, key, error, retrying);
    if (retrying) message.retry({ delaySeconds: retryDelaySeconds(attempts) });
    else message.ack();
  }
}

function keyBelongsToUser(key: string, userId: string): boolean {
  return key.startsWith(`users/${userId}/`) && !key.includes("..") && !key.includes("//");
}

async function cleanupExpiredObjects(env: Env): Promise<void> {
  const now = nowUtcIso();
  const configuredTtl = Number(env.PENDING_UPLOAD_TTL_SECONDS);
  const ttlSeconds = Number.isSafeInteger(configuredTtl)
    ? Math.min(Math.max(configuredTtl, 3_600), 7 * 24 * 60 * 60)
    : 24 * 60 * 60;
  const pendingCutoff = new Date(Date.now() - ttlSeconds * 1_000).toISOString();
  const staleFiles = await all<Row>(
    env.DB,
    `SELECT id,user_id,r2_key FROM files
     WHERE deleted_at IS NULL AND upload_state IN ('pending','uploaded','failed') AND created_at<?
     ORDER BY created_at LIMIT 200`,
    pendingCutoff,
  );
  for (const file of staleFiles) {
    const key = String(file.r2_key);
    const userId = String(file.user_id);
    if (!keyBelongsToUser(key, userId)) {
      console.error("Refusing to clean an unscoped Citera object", { fileId: file.id });
      continue;
    }
    await env.FILES.delete(key);
    await env.DB.prepare(
      "UPDATE files SET upload_state='failed',deleted_at=? WHERE id=? AND user_id=? AND upload_state<>'verified'",
    )
      .bind(now, file.id, userId)
      .run();
  }

  const expiredExports = await all<Row>(
    env.DB,
    `SELECT id,user_id,r2_key FROM export_jobs
     WHERE r2_key IS NOT NULL AND expires_at<? AND state IN ('complete','failed')
     ORDER BY expires_at LIMIT 100`,
    now,
  );
  for (const exported of expiredExports) {
    const key = String(exported.r2_key);
    const userId = String(exported.user_id);
    if (!keyBelongsToUser(key, userId)) {
      console.error("Refusing to clean an unscoped Citera export", { exportId: exported.id });
      continue;
    }
    await env.FILES.delete(key);
    await env.DB.prepare(
      "UPDATE export_jobs SET state='expired',r2_key=NULL WHERE id=? AND user_id=?",
    )
      .bind(exported.id, userId)
      .run();
  }

  const oldMutationCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM authorization_codes WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM metadata_cache WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM client_mutations WHERE created_at<?").bind(oldMutationCutoff),
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start<?").bind(
      Math.floor(Date.now() / 1_000) - 24 * 60 * 60,
    ),
    env.DB.prepare("DELETE FROM job_outbox WHERE state='dispatched' AND dispatched_at<?").bind(
      oldMutationCutoff,
    ),
    env.DB.prepare(
      "DELETE FROM job_runs WHERE state IN ('complete','failed') AND completed_at<?",
    ).bind(oldMutationCutoff),
  ]);
}

async function dispatchPendingOutbox(env: Env): Promise<void> {
  const now = nowUtcIso();
  const rows = await all<Row>(
    env.DB,
    `SELECT id,job_json,attempts FROM job_outbox
     WHERE state='pending' AND available_at<=? ORDER BY created_at LIMIT 100`,
    now,
  );
  for (const row of rows) {
    const parsed = JobMessageSchema.safeParse(JSON.parse(String(row.job_json)));
    if (!parsed.success) {
      await env.DB.prepare("UPDATE job_outbox SET state='failed',last_error=? WHERE id=?")
        .bind("Stored Queue message failed schema validation", row.id)
        .run();
      continue;
    }
    try {
      await env.JOBS.send(parsed.data);
      await env.DB.prepare(
        "UPDATE job_outbox SET state='dispatched',attempts=attempts+1,dispatched_at=?,last_error=NULL WHERE id=?",
      )
        .bind(nowUtcIso(), row.id)
        .run();
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      const delaySeconds = retryDelaySeconds(attempts);
      const availableAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();
      const message = error instanceof Error ? error.message : "Queue dispatch failed";
      await env.DB.prepare(
        "UPDATE job_outbox SET attempts=?,available_at=?,last_error=? WHERE id=? AND state='pending'",
      )
        .bind(attempts, availableAt, message.slice(0, 2_000), row.id)
        .run();
    }
  }
}

async function resumePendingAccountDeletions(env: Env): Promise<void> {
  const now = nowUtcIso();
  const staleCutoff = new Date(Date.now() - ACCOUNT_DELETE_RECOVERY_MS).toISOString();
  const users = await all<DeletingUser>(
    env.DB,
    `SELECT id,deletion_generation FROM users
     WHERE deletion_requested_at IS NOT NULL ORDER BY deletion_requested_at LIMIT 50`,
  );
  for (const user of users) {
    const userId = user.id;
    const generation = Number(user.deletion_generation);
    await env.DB.prepare(
      `UPDATE job_runs SET state='failed',error_code='STALE_DELETION_DEPENDENCY',
           error_message='Recovered stale job while account deletion was pending',updated_at=?,completed_at=?
         WHERE user_id=? AND state IN ('running','retrying') AND updated_at<?`,
    )
      .bind(now, now, userId, staleCutoff)
      .run();

    const currentJob: JobMessage = {
      jobId: `job_${crypto.randomUUID()}`,
      type: "account.delete",
      userId,
      sourceVersion: generation,
      attempt: 1,
    };
    const currentKey = jobIdempotencyKey(currentJob);
    const [run, outbox] = await Promise.all([
      first<Row>(
        env.DB,
        "SELECT state,updated_at FROM job_runs WHERE idempotency_key=?",
        currentKey,
      ),
      first<Row>(
        env.DB,
        "SELECT state,created_at FROM job_outbox WHERE idempotency_key=?",
        currentKey,
      ),
    ]);
    if (run && (run.state === "running" || run.state === "retrying")) continue;
    if (outbox?.state === "pending") continue;
    if (!run && outbox?.state === "dispatched" && String(outbox.created_at) >= staleCutoff) {
      continue;
    }

    const nextGeneration = generation + 1;
    const advanced = await env.DB.prepare(
      `UPDATE users SET deletion_generation=?,updated_at=?
         WHERE id=? AND deletion_generation=? AND deletion_requested_at IS NOT NULL`,
    )
      .bind(nextGeneration, now, userId, generation)
      .run();
    if (advanced.meta.changes !== 1) continue;
    const nextJob: JobMessage = {
      ...currentJob,
      jobId: `job_${crypto.randomUUID()}`,
      sourceVersion: nextGeneration,
    };
    await env.DB.prepare(
      `INSERT INTO job_outbox
          (id,idempotency_key,job_json,state,attempts,available_at,created_at)
         VALUES (?,?,?,'pending',0,?,?)`,
    )
      .bind(
        `out_${crypto.randomUUID()}`,
        jobIdempotencyKey(nextJob),
        JSON.stringify(nextJob),
        now,
        now,
      )
      .run();
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await Promise.all(batch.messages.map((message) => processMessage(message, env)));
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await resumePendingAccountDeletions(env);
    await dispatchPendingOutbox(env);
    await cleanupExpiredObjects(env);
  },
} satisfies ExportedHandler<Env>;

export { jobIdempotencyKey, retryDelaySeconds, shouldRetry } from "./idempotency";
export { JobMessageSchema } from "./types";
