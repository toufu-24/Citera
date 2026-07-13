import { createId, nowUtcIso } from "./utils";
import type { AppBindings, JobMessage } from "./types";

export function jobIdempotencyKey(job: JobMessage): string {
  const entity = job.exportId ?? job.fileId ?? job.paperId ?? job.userId;
  return `${job.type}:${entity}:${job.sourceVersion}`;
}

export function jobOutboxStatement(
  db: D1Database,
  job: JobMessage,
  createdAt = nowUtcIso(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO job_outbox
       (id,idempotency_key,job_json,state,attempts,available_at,created_at)
       VALUES (?,?,?,'pending',0,?,?)`,
    )
    .bind(createId("out"), jobIdempotencyKey(job), JSON.stringify(job), createdAt, createdAt);
}

export async function dispatchOutboxJobs(
  env: AppBindings["Bindings"],
  jobs: readonly JobMessage[],
): Promise<void> {
  for (const job of jobs) {
    const key = jobIdempotencyKey(job);
    try {
      await env.JOBS.send(job);
      await env.DB.prepare(
        "UPDATE job_outbox SET state='dispatched',attempts=attempts+1,dispatched_at=?,last_error=NULL WHERE idempotency_key=?",
      )
        .bind(nowUtcIso(), key)
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Queue dispatch failed";
      await env.DB.prepare(
        "UPDATE job_outbox SET attempts=attempts+1,last_error=? WHERE idempotency_key=? AND state='pending'",
      )
        .bind(message.slice(0, 2_000), key)
        .run();
      console.error("Citera Queue dispatch deferred to the outbox scheduler", { key, message });
    }
  }
}
