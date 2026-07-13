import { nowUtcIso } from "@citera/domain";
import { strToU8, zipSync } from "fflate";
import { all, first, type Row } from "./db";
import { enrichPaper, rebuildSearchIndex } from "./metadata";
import { jobIdempotencyKey } from "./idempotency";
import type { Env, JobMessage, JobResult } from "./types";
import { JobError } from "./types";

function keyBelongsToUser(key: string, userId: string): boolean {
  return key.startsWith(`users/${userId}/`) && !key.includes("..") && !key.includes("//");
}

function bufferToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyPdf(env: Env, job: JobMessage): Promise<JobResult> {
  if (!job.fileId || !job.paperId)
    throw new JobError("FILE_ID_REQUIRED", "PDF verification requires fileId and paperId", false);
  const file = await first<Row>(
    env.DB,
    "SELECT * FROM files WHERE id=? AND user_id=? AND paper_id=? AND deleted_at IS NULL",
    job.fileId,
    job.userId,
    job.paperId,
  );
  if (!file) throw new JobError("FILE_NOT_FOUND", "File was not found", false);
  if (file.upload_state === "verified") return { state: "verified", duplicate: true };
  const key = String(file.r2_key);
  if (!keyBelongsToUser(key, job.userId))
    throw new JobError("OBJECT_SCOPE_INVALID", "Object key is outside the user's prefix", false);
  const head = await env.FILES.head(key);
  if (!head) throw new JobError("OBJECT_NOT_FOUND", "Uploaded object does not exist yet", true);
  if (head.size !== Number(file.size_bytes)) {
    await env.FILES.delete(key);
    throw new JobError(
      "FILE_SIZE_MISMATCH",
      "Uploaded object size differs from declaration",
      false,
    );
  }
  const checksum = head.checksums.sha256;
  if (!checksum || bufferToHex(checksum) !== file.sha256) {
    await env.FILES.delete(key);
    throw new JobError(
      "FILE_CHECKSUM_MISMATCH",
      "Uploaded checksum differs from declaration",
      false,
    );
  }
  const object = await env.FILES.get(key, { range: { offset: 0, length: 5 } });
  if (!object) throw new JobError("OBJECT_NOT_FOUND", "Uploaded object does not exist yet", true);
  if (new TextDecoder().decode(await object.arrayBuffer()) !== "%PDF-") {
    await env.FILES.delete(key);
    throw new JobError("PDF_MAGIC_INVALID", "Uploaded object is not a PDF", false);
  }
  const now = nowUtcIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE files SET upload_state='verified' WHERE id=? AND user_id=?").bind(
      job.fileId,
      job.userId,
    ),
    env.DB.prepare(
      `INSERT INTO changes (user_id,entity_type,entity_id,operation,version,data_json,changed_at)
       VALUES (?,'file',?,'create',1,?,?)`,
    ).bind(
      job.userId,
      job.fileId,
      JSON.stringify({ id: job.fileId, paperId: job.paperId, uploadState: "verified" }),
      now,
    ),
  ]);
  return { state: "verified", bytes: head.size };
}

async function delegatedPdfExtraction(env: Env, job: JobMessage): Promise<JobResult> {
  if (!job.fileId) throw new JobError("FILE_ID_REQUIRED", "PDF extraction requires fileId", false);
  const file = await first<Row>(
    env.DB,
    "SELECT id,upload_state FROM files WHERE id=? AND user_id=?",
    job.fileId,
    job.userId,
  );
  if (!file) throw new JobError("FILE_NOT_FOUND", "File was not found", false);
  if (file.upload_state !== "verified")
    throw new JobError("FILE_NOT_VERIFIED", "PDF is not verified yet", true);
  // Citera intentionally keeps CPU-heavy PDF.js extraction in the authenticated browser.
  // A future client-uploaded extracted_text object can make this job validate/index that artifact.
  return { delegatedToClient: true, reason: "browser_pdfjs_pipeline" };
}

async function cleanupObject(env: Env, job: JobMessage): Promise<JobResult> {
  if (!job.fileId) throw new JobError("FILE_ID_REQUIRED", "Cleanup requires fileId", false);
  const file = await first<Row>(
    env.DB,
    "SELECT r2_key,deleted_at FROM files WHERE id=? AND user_id=?",
    job.fileId,
    job.userId,
  );
  if (!file) return { missing: true };
  if (!file.deleted_at)
    throw new JobError("FILE_NOT_DELETED", "Refusing cleanup for a live file", false);
  const key = String(file.r2_key);
  if (!keyBelongsToUser(key, job.userId))
    throw new JobError("OBJECT_SCOPE_INVALID", "Object key is outside the user's prefix", false);
  await env.FILES.delete(key);
  return { deleted: true, key };
}

async function deleteAccount(env: Env, job: JobMessage): Promise<JobResult> {
  const owner = await first<Row>(
    env.DB,
    "SELECT deletion_requested_at,deletion_generation FROM users WHERE id=?",
    job.userId,
  );
  if (!owner) return { deleted: false, missing: true };
  if (!owner.deletion_requested_at) {
    throw new JobError(
      "ACCOUNT_DELETION_NOT_REQUESTED",
      "Refusing to delete an account without a durable deletion request",
      false,
    );
  }
  if (Number(owner.deletion_generation) !== job.sourceVersion) {
    return {
      deleted: false,
      stale: true,
      currentGeneration: Number(owner.deletion_generation),
    };
  }
  const currentJobKey = jobIdempotencyKey(job);
  const otherRunning = await first<Row>(
    env.DB,
    `SELECT COUNT(*) AS count FROM job_runs
     WHERE user_id=? AND state='running' AND idempotency_key<>?`,
    job.userId,
    currentJobKey,
  );
  if (Number(otherRunning?.count ?? 0) > 0) {
    throw new JobError(
      "ACCOUNT_DELETION_JOBS_RUNNING",
      "Account deletion is waiting for already-running jobs to finish",
      true,
    );
  }
  const prefix = `users/${job.userId}/`;
  let cursor: string | undefined;
  let deletedObjects = 0;
  do {
    const page = await env.FILES.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1_000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) {
      await env.FILES.delete(keys);
      deletedObjects += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM job_outbox WHERE json_extract(job_json,'$.userId')=?").bind(
      job.userId,
    ),
    env.DB.prepare("DELETE FROM job_runs WHERE user_id=? AND idempotency_key<>?").bind(
      job.userId,
      currentJobKey,
    ),
  ]);
  const deleted = await env.DB.prepare(
    "DELETE FROM users WHERE id=? AND deletion_generation=? AND deletion_requested_at IS NOT NULL",
  )
    .bind(job.userId, job.sourceVersion)
    .run();
  return { deleted: deleted.meta.changes === 1, deletedObjects };
}

async function generateBackup(env: Env, job: JobMessage): Promise<JobResult> {
  if (!job.exportId)
    throw new JobError("EXPORT_ID_REQUIRED", "Export generation requires exportId", false);
  const exportRow = await first<Row>(
    env.DB,
    "SELECT * FROM export_jobs WHERE id=? AND user_id=?",
    job.exportId,
    job.userId,
  );
  if (!exportRow) throw new JobError("EXPORT_NOT_FOUND", "Export job was not found", false);
  if (exportRow.state === "complete") return { state: "complete", duplicate: true };
  if (exportRow.format !== "backup")
    throw new JobError("EXPORT_FORMAT_UNSUPPORTED", "Queued export format is not supported", false);
  await env.DB.prepare(
    "UPDATE export_jobs SET state='processing',error_message=NULL WHERE id=? AND user_id=?",
  )
    .bind(job.exportId, job.userId)
    .run();
  const [
    papers,
    notes,
    tags,
    collections,
    files,
    identifiers,
    paperAuthors,
    metadataValues,
    paperTags,
    collectionPapers,
    relations,
  ] = await Promise.all([
    all<Row>(env.DB, "SELECT * FROM papers WHERE user_id=? ORDER BY created_at", job.userId),
    all<Row>(env.DB, "SELECT * FROM notes WHERE user_id=? ORDER BY created_at", job.userId),
    all<Row>(env.DB, "SELECT * FROM tags WHERE user_id=? ORDER BY name", job.userId),
    all<Row>(env.DB, "SELECT * FROM collections WHERE user_id=? ORDER BY name", job.userId),
    all<Row>(
      env.DB,
      `SELECT id,paper_id,r2_key,sha256,media_type,size_bytes,original_name,kind,created_at
       FROM files WHERE user_id=? AND kind='original_pdf' AND upload_state='verified' AND deleted_at IS NULL`,
      job.userId,
    ),
    all<Row>(
      env.DB,
      `SELECT paper_id,identifier_type,normalized_value,original_value,identifier_version,created_at
       FROM paper_identifiers WHERE user_id=? ORDER BY paper_id,identifier_type`,
      job.userId,
    ),
    all<Row>(
      env.DB,
      `SELECT pa.paper_id,pa.position,pa.role,a.id,a.normalized_name,a.display_name,a.orcid,a.created_at,a.updated_at
       FROM paper_authors pa JOIN authors a ON a.id=pa.author_id AND a.user_id=pa.user_id
       WHERE pa.user_id=? ORDER BY pa.paper_id,pa.position`,
      job.userId,
    ),
    all<Row>(
      env.DB,
      `SELECT id,paper_id,field_name,value_json,source_type,source_reference,confidence,selected,created_at,updated_at
       FROM metadata_values WHERE user_id=? ORDER BY paper_id,field_name,created_at`,
      job.userId,
    ),
    all<Row>(
      env.DB,
      "SELECT paper_id,tag_id,created_at FROM paper_tags WHERE user_id=? ORDER BY paper_id,tag_id",
      job.userId,
    ),
    all<Row>(
      env.DB,
      "SELECT paper_id,collection_id,created_at FROM collection_papers WHERE user_id=? ORDER BY paper_id,collection_id",
      job.userId,
    ),
    all<Row>(
      env.DB,
      `SELECT source_paper_id,target_paper_id,relation_type,created_at
       FROM paper_relations WHERE user_id=? ORDER BY source_paper_id,target_paper_id,relation_type`,
      job.userId,
    ),
  ]);
  const maximum = Math.min(
    Math.max(Number(env.MAX_BACKUP_BYTES) || 26_214_400, 1_048_576),
    104_857_600,
  );
  const declaredBytes = files.reduce((total, file) => total + Number(file.size_bytes), 0);
  if (declaredBytes > maximum) {
    throw new JobError(
      "BACKUP_TOO_LARGE",
      `Backup source PDFs exceed the configured ${maximum} byte in-memory limit`,
      false,
    );
  }
  const backupPapers = papers.map((paper) => {
    const paperId = String(paper.id);
    return {
      ...paper,
      identifiers: identifiers.filter((row) => row.paper_id === paperId),
      authors: paperAuthors.filter((row) => row.paper_id === paperId),
      metadataValues: metadataValues.filter((row) => row.paper_id === paperId),
      tagIds: paperTags.filter((row) => row.paper_id === paperId).map((row) => row.tag_id),
      collectionIds: collectionPapers
        .filter((row) => row.paper_id === paperId)
        .map((row) => row.collection_id),
      relations: relations.filter((row) => row.source_paper_id === paperId),
      files: files
        .filter((row) => row.paper_id === paperId)
        .map((row) => ({
          id: row.id,
          paper_id: row.paper_id,
          sha256: row.sha256,
          media_type: row.media_type,
          size_bytes: row.size_bytes,
          original_name: row.original_name,
          kind: row.kind,
          created_at: row.created_at,
        })),
    };
  });
  const entries: Record<string, Uint8Array> = {
    "papers.json": strToU8(JSON.stringify(backupPapers, null, 2)),
    "notes.json": strToU8(JSON.stringify(notes, null, 2)),
    "tags.json": strToU8(JSON.stringify(tags, null, 2)),
    "collections.json": strToU8(JSON.stringify(collections, null, 2)),
  };
  const manifestFiles: Array<{
    paperId: string;
    path: string;
    sha256: string;
    fileId: string;
    originalName: string;
  }> = [];
  let loadedBytes = 0;
  for (const file of files) {
    const key = String(file.r2_key);
    if (!keyBelongsToUser(key, job.userId))
      throw new JobError("OBJECT_SCOPE_INVALID", "Object key is outside the user's prefix", false);
    const object = await env.FILES.get(key);
    if (!object)
      throw new JobError("BACKUP_OBJECT_MISSING", `Object ${String(file.id)} is missing`, false);
    const body = new Uint8Array(await object.arrayBuffer());
    loadedBytes += body.byteLength;
    if (loadedBytes > maximum)
      throw new JobError(
        "BACKUP_TOO_LARGE",
        "Backup exceeded its configured in-memory limit",
        false,
      );
    const path = `files/${String(file.paper_id)}/${String(file.id)}.pdf`;
    entries[path] = body;
    manifestFiles.push({
      paperId: String(file.paper_id),
      path,
      sha256: String(file.sha256),
      fileId: String(file.id),
      originalName: String(file.original_name),
    });
  }
  const now = nowUtcIso();
  entries["manifest.json"] = strToU8(
    JSON.stringify(
      { format: "paper-library-backup", version: 1, createdAt: now, files: manifestFiles },
      null,
      2,
    ),
  );
  const archive = zipSync(entries, { level: 6 });
  const key = `users/${job.userId}/exports/${job.exportId}/library.zip`;
  if (!keyBelongsToUser(key, job.userId))
    throw new JobError("OBJECT_SCOPE_INVALID", "Export key is outside the user's prefix", false);
  await env.FILES.put(key, archive, {
    httpMetadata: {
      contentType: "application/zip",
      contentDisposition: 'attachment; filename="citera-backup.zip"',
    },
    customMetadata: { userId: job.userId, exportId: job.exportId },
  });
  await env.DB.prepare(
    `UPDATE export_jobs SET state='complete',r2_key=?,media_type='application/zip',size_bytes=?,completed_at=?,error_message=NULL
     WHERE id=? AND user_id=?`,
  )
    .bind(key, archive.byteLength, now, job.exportId, job.userId)
    .run();
  return { state: "complete", bytes: archive.byteLength, files: manifestFiles.length };
}

export async function handleJob(env: Env, job: JobMessage): Promise<JobResult> {
  switch (job.type) {
    case "paper.enrich":
    case "metadata.refresh":
      return enrichPaper(env, job);
    case "pdf.verify":
      return verifyPdf(env, job);
    case "pdf.extract":
      return delegatedPdfExtraction(env, job);
    case "search.reindex":
      return rebuildSearchIndex(env, job);
    case "export.generate":
      return generateBackup(env, job);
    case "account.delete":
      return deleteAccount(env, job);
    case "object.cleanup":
      return cleanupObject(env, job);
  }
}
