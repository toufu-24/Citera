import { PaperStatusSchema } from "@citera/domain";
import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import { first } from "../db";
import { ApiError } from "../errors";
import { dispatchOutboxJobs, jobIdempotencyKey, jobOutboxStatement } from "../jobs";
import { readUserPreferences } from "../preferences";
import type { AppBindings, JobMessage } from "../types";
import { createId, nowUtcIso } from "../utils";

const exportFormatSchema = z.enum(["bibtex", "csl-json", "ris", "csv", "json"]);
const preferencesPatchSchema = z
  .object({
    defaultCollectionId: z.string().min(1).max(200).nullable().optional(),
    defaultTagIds: z.array(z.string().min(1).max(200)).max(100).optional(),
    defaultStatus: PaperStatusSchema.optional(),
    defaultExportFormat: exportFormatSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one preference is required.");

export const preferencesRoutes = new Hono<AppBindings>();

preferencesRoutes.get("/", async (c) => {
  return c.json(await readUserPreferences(c.env.DB, c.get("user").id));
});

preferencesRoutes.patch("/", async (c) => {
  const input = preferencesPatchSchema.parse(await c.req.json());
  const userId = c.get("user").id;
  const current = await readUserPreferences(c.env.DB, userId);
  const next = { ...current, ...input };
  if (next.defaultCollectionId) {
    const collection = await first<Record<string, unknown>>(
      c.env.DB,
      "SELECT id FROM collections WHERE id=? AND user_id=? AND deleted_at IS NULL",
      next.defaultCollectionId,
      userId,
    );
    if (!collection)
      throw new ApiError(422, "DEFAULT_COLLECTION_NOT_FOUND", "Default collection was not found.");
  }
  const tagIds = [...new Set(next.defaultTagIds)];
  if (tagIds.length) {
    const tags = await first<{ count: number } & Record<string, unknown>>(
      c.env.DB,
      `SELECT COUNT(*) AS count FROM tags WHERE user_id=? AND id IN (${tagIds.map(() => "?").join(",")})`,
      userId,
      ...tagIds,
    );
    if (Number(tags?.count ?? 0) !== tagIds.length) {
      throw new ApiError(422, "DEFAULT_TAG_NOT_FOUND", "One or more default tags were not found.");
    }
  }
  const now = nowUtcIso();
  await c.env.DB.prepare(
    `INSERT INTO user_preferences
      (user_id,default_collection_id,default_tag_ids_json,default_status,default_export_format,updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       default_collection_id=excluded.default_collection_id,
       default_tag_ids_json=excluded.default_tag_ids_json,
       default_status=excluded.default_status,
       default_export_format=excluded.default_export_format,
       updated_at=excluded.updated_at`,
  )
    .bind(
      userId,
      next.defaultCollectionId,
      JSON.stringify(tagIds),
      next.defaultStatus,
      next.defaultExportFormat,
      now,
    )
    .run();
  return c.json({ ...next, defaultTagIds: tagIds, updatedAt: now });
});

const deleteAccountSchema = z.object({ confirmation: z.string().email() }).strict();
export const accountRoutes = new Hono<AppBindings>();

accountRoutes.delete("/", async (c) => {
  const input = deleteAccountSchema.parse(await c.req.json());
  const user = c.get("user");
  if (input.confirmation.toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(
      422,
      "ACCOUNT_CONFIRMATION_INVALID",
      "Enter the signed-in email address to confirm deletion.",
    );
  }
  const now = nowUtcIso();
  const job: JobMessage = {
    jobId: createId("job"),
    type: "account.delete",
    userId: user.id,
    sourceVersion: 1,
    attempt: 1,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users SET deletion_requested_at=?,deletion_generation=1,updated_at=?
         WHERE id=? AND deletion_requested_at IS NULL`,
    ).bind(now, now, user.id),
    c.env.DB.prepare(
      "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
    ).bind(now, user.id),
    c.env.DB.prepare(
      "UPDATE session_families SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
    ).bind(now, user.id),
    jobOutboxStatement(c.env.DB, job, now),
  ]);
  c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, [job]));
  deleteCookie(c, "citera_session", { path: "/" });
  const stored = await first<{ job_json: string } & Record<string, unknown>>(
    c.env.DB,
    "SELECT job_json FROM job_outbox WHERE idempotency_key=?",
    jobIdempotencyKey(job),
  );
  const storedJob = stored ? (JSON.parse(stored.job_json) as { jobId?: unknown }) : null;
  return c.json(
    { state: "queued", jobId: typeof storedJob?.jobId === "string" ? storedJob.jobId : job.jobId },
    202,
  );
});
