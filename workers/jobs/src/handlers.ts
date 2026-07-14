import { createId, normalizeArxivId, nowUtcIso } from "@citera/domain";
import { strToU8, zipSync } from "fflate";
import { all, first, type Row } from "./db";
import { enrichPaper, rebuildSearchIndex } from "./metadata";
import { jobIdempotencyKey } from "./idempotency";
import type { Env, JobMessage, JobResult } from "./types";
import { JobError } from "./types";

function keyBelongsToUser(key: string, userId: string): boolean {
  return key.startsWith(`users/${userId}/`) && !key.includes("..") && !key.includes("//");
}

function bufferToHex(value: ArrayBufferLike): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

class StreamingSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
  ]);

  private readonly buffer = new Uint8Array(64);

  private bufferLength = 0;

  private bytesHashed = 0;

  update(bytes: Uint8Array): void {
    this.bytesHashed += bytes.byteLength;
    let offset = 0;

    if (this.bufferLength > 0) {
      const copied = Math.min(64 - this.bufferLength, bytes.byteLength);
      this.buffer.set(bytes.subarray(0, copied), this.bufferLength);
      this.bufferLength += copied;
      offset += copied;
      if (this.bufferLength === 64) {
        this.processBlock(this.buffer);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= bytes.byteLength) {
      this.processBlock(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.bufferLength = bytes.byteLength - offset;
    }
  }

  digest(): Uint8Array {
    const bitLength = this.bytesHashed * 8;
    this.buffer[this.bufferLength] = 0x80;
    this.bufferLength += 1;
    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this.processBlock(this.buffer);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);
    const high = Math.floor(bitLength / 2 ** 32);
    const low = bitLength >>> 0;
    this.buffer[56] = high >>> 24;
    this.buffer[57] = high >>> 16;
    this.buffer[58] = high >>> 8;
    this.buffer[59] = high;
    this.buffer[60] = low >>> 24;
    this.buffer[61] = low >>> 16;
    this.buffer[62] = low >>> 8;
    this.buffer[63] = low;
    this.processBlock(this.buffer);

    const output = new Uint8Array(32);
    for (let index = 0; index < this.state.length; index += 1) {
      const word = this.state[index]!;
      const offset = index * 4;
      output[offset] = word >>> 24;
      output[offset + 1] = word >>> 16;
      output[offset + 2] = word >>> 8;
      output[offset + 3] = word;
    }
    return output;
  }

  private processBlock(block: Uint8Array): void {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] =
        ((block[offset]! << 24) |
          (block[offset + 1]! << 16) |
          (block[offset + 2]! << 8) |
          block[offset + 3]!) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const value15 = words[index - 15]!;
      const value2 = words[index - 2]!;
      const smallSigma0 =
        ((value15 >>> 7) | (value15 << 25)) ^
        ((value15 >>> 18) | (value15 << 14)) ^
        (value15 >>> 3);
      const smallSigma1 =
        ((value2 >>> 17) | (value2 << 15)) ^
        ((value2 >>> 19) | (value2 << 13)) ^
        (value2 >>> 10);
      words[index] =
        (words[index - 16]! + smallSigma0 + words[index - 7]! + smallSigma1) >>> 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + bigSigma1 + choose + SHA256_K[index]! + words[index]!) >>> 0;
      const bigSigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

export async function sha256ForStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = new StreamingSha256();
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value) hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return bufferToHex(hash.digest().buffer);
}

async function checksumForStoredObject(
  env: Env,
  key: string,
  head: R2Object,
): Promise<string | null> {
  if (head.checksums.sha256) return bufferToHex(head.checksums.sha256);

  // R2 only exposes SHA-256 metadata when the uploader supplied it. Automatic imports
  // stream directly to R2, so hash the stored object when that metadata is unavailable.
  const object = await env.FILES.get(key);
  return object?.body
    ? sha256ForStream(object.body as ReadableStream<Uint8Array>)
    : null;
}

function maxPdfBytes(env: Env): number {
  const configured = Number(env.MAX_PDF_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 5 * 1024 * 1024 * 1024)
    : 100 * 1024 * 1024;
}

function maxUserStorageBytes(env: Env): number {
  const configured = Number(env.MAX_USER_STORAGE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 5 * 1024 * 1024 * 1024 * 1024)
    : 5 * 1024 * 1024 * 1024;
}

function normalizePdfSource(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (
      ["arxiv.org", "export.arxiv.org"].includes(url.hostname) &&
      url.pathname.startsWith("/pdf/")
    ) {
      const arxivId = normalizeArxivId(decodeURIComponent(url.pathname.slice("/pdf/".length)));
      return arxivId ? `https://arxiv.org/pdf/${arxivId}` : null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function readPdfPrefix(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const bytes: number[] = [];
  try {
    while (bytes.length < 5) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value) bytes.push(...chunk.value.slice(0, 5 - bytes.length));
    }
  } finally {
    reader.releaseLock();
  }
  return Uint8Array.from(bytes);
}

async function downloadPdf(env: Env, job: JobMessage): Promise<JobResult> {
  const rawPdfUrls = job.pdfUrls?.length ? job.pdfUrls : job.pdfUrl ? [job.pdfUrl] : [];
  const pdfUrls = [
    ...new Set(rawPdfUrls.map(normalizePdfSource).filter((url): url is string => Boolean(url))),
  ];
  if (!job.paperId || pdfUrls.length === 0) {
    throw new JobError(
      "PDF_SOURCE_REQUIRED",
      "Automatic PDF download requires a paper and at least one URL",
      false,
    );
  }
  const paper = await first<Row>(
    env.DB,
    "SELECT id FROM papers WHERE id=? AND user_id=? AND deleted_at IS NULL",
    job.paperId,
    job.userId,
  );
  if (!paper) throw new JobError("PAPER_NOT_FOUND", "Paper was not found", false);
  const existing = await first<Row>(
    env.DB,
    `SELECT id FROM files
     WHERE user_id=? AND paper_id=? AND kind='original_pdf' AND upload_state='verified' AND deleted_at IS NULL
     LIMIT 1`,
    job.userId,
    job.paperId,
  );
  if (existing) return { state: "verified", duplicate: true, fileId: existing.id };

  const maxBytes = maxPdfBytes(env);
  const storageLimit = maxUserStorageBytes(env);
  let selected: { stream: ReadableStream<Uint8Array>; sourceUrl: string } | null = null;
  let transientFailure = false;
  for (const sourceUrl of pdfUrls) {
    let response: Response;
    try {
      response = await fetch(sourceUrl, {
        headers: {
          Accept: "application/pdf, */*",
          "User-Agent": "Citera/0.1 (automatic PDF import)",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      transientFailure = true;
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      transientFailure = true;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      continue;
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      await response.body?.cancel();
      continue;
    }
    if (!response.body) {
      transientFailure = true;
      continue;
    }
    const [uploadStream, probeStream] = response.body.tee();
    const prefix = await readPdfPrefix(probeStream);
    await probeStream.cancel();
    if (new TextDecoder().decode(prefix) !== "%PDF-") {
      await uploadStream.cancel();
      continue;
    }
    selected = { stream: uploadStream, sourceUrl };
    break;
  }
  if (!selected) {
    throw new JobError(
      "PDF_NOT_FOUND",
      "None of the automatic PDF sources returned a PDF",
      transientFailure,
    );
  }

  const fileId = createId("fil");
  const key = `users/${job.userId}/papers/${job.paperId}/original/${fileId}.pdf`;
  const arxivId = normalizeArxivId(selected.sourceUrl);
  const originalName = arxivId
    ? `arxiv-${arxivId.replace(/[^a-z0-9._-]/giu, "-")}.pdf`
    : `automatic-${job.paperId}.pdf`;
  const label = arxivId ? `arXiv ${arxivId}` : "自動取得PDF";

  try {
    await env.FILES.put(key, selected.stream, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `inline; filename="${originalName}"`,
      },
      customMetadata: {
        userId: job.userId,
        paperId: job.paperId,
        sourceUrl: selected.sourceUrl,
      },
    });
  } catch (error) {
    await env.FILES.delete(key);
    throw new JobError(
      "PDF_STORAGE_ERROR",
      error instanceof Error ? error.message : "The PDF could not be stored",
      true,
    );
  }

  const head = await env.FILES.head(key);
  if (!head) {
    await env.FILES.delete(key);
    throw new JobError("PDF_OBJECT_MISSING", "The stored PDF could not be verified", true);
  }
  if (head.size > maxBytes) {
    await env.FILES.delete(key);
    throw new JobError("PDF_TOO_LARGE", "The arXiv PDF exceeds the configured size limit", false);
  }
  const storage = await first<Row>(
    env.DB,
    `SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM files
     WHERE user_id=? AND deleted_at IS NULL AND upload_state IN ('pending','uploaded','verified')`,
    job.userId,
  );
  if (Number(storage?.bytes ?? 0) + head.size > storageLimit) {
    await env.FILES.delete(key);
    throw new JobError(
      "STORAGE_QUOTA_EXCEEDED",
      "Automatic PDF download would exceed storage quota",
      false,
    );
  }
  const sha256 = await checksumForStoredObject(env, key, head);
  if (!sha256) {
    await env.FILES.delete(key);
    throw new JobError("PDF_CHECKSUM_MISSING", "The stored PDF has no SHA-256 checksum", true);
  }
  const now = nowUtcIso();
  const existingDefault = await first<Row>(
    env.DB,
    "SELECT id FROM files WHERE user_id=? AND paper_id=? AND is_default=1 AND deleted_at IS NULL LIMIT 1",
    job.userId,
    job.paperId,
  );
  const nextOrder = await first<Row>(
    env.DB,
    "SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM files WHERE user_id=? AND paper_id=? AND deleted_at IS NULL",
    job.userId,
    job.paperId,
  );
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files
          (id,user_id,paper_id,ingestion_id,r2_key,sha256,media_type,size_bytes,original_name,kind,
           label,file_kind,language_code,is_default,sort_order,upload_state,created_at,deleted_at)
         VALUES (?,?,?,NULL,?,?,?,?,?,'original_pdf',?,'fulltext',NULL,?,?,'verified',?,NULL)`,
      ).bind(
        fileId,
        job.userId,
        job.paperId,
        key,
        sha256,
        "application/pdf",
        head.size,
        originalName,
        label,
        existingDefault ? 0 : 1,
        Number(nextOrder?.next_order ?? 0),
        now,
      ),
      env.DB.prepare(
        `INSERT INTO changes (user_id,entity_type,entity_id,operation,version,data_json,changed_at)
         VALUES (?,'file',?,'create',1,?,?)`,
      ).bind(
        job.userId,
        fileId,
        JSON.stringify({
          id: fileId,
          paperId: job.paperId,
          uploadState: "verified",
          originalName,
        }),
        now,
      ),
    ]);
  } catch (error) {
    await env.FILES.delete(key);
    throw new JobError(
      "PDF_RECORD_ERROR",
      error instanceof Error ? error.message : "The downloaded PDF could not be registered",
      true,
    );
  }
  return { state: "verified", fileId, bytes: head.size, sourceUrl: selected.sourceUrl };
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
    case "pdf.download":
      return downloadPdf(env, job);
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
