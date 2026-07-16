import { exportPapers, type ExportPaper } from "@citera/export";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { all, first, PAPER_AGGREGATES_SQL, paperFromRow, type SqlRow } from "../db";
import { ApiError } from "../errors";
import { dispatchOutboxJobs, jobOutboxStatement } from "../jobs";
import { keyBelongsToUser, objectKeyFor, presignR2 } from "../r2";
import type { AppBindings, JobMessage } from "../types";
import { addSeconds, createId, nowUtcIso, parseJson, requirePositiveInt } from "../utils";

const createExportSchema = z.object({
  format: z.enum(["bibtex", "csl-json", "ris", "csv", "json", "backup"]),
  paperIds: z.array(z.string().min(1)).max(1_000).optional(),
  all: z.boolean().default(false),
});

interface ExportRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  format: string;
  query_json: string;
  state: string;
  r2_key: string | null;
  media_type: string | null;
  size_bytes: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string;
}

function exportResponse(row: ExportRow): Record<string, unknown> {
  return {
    id: row.id,
    format: row.format,
    query: parseJson(row.query_json, {}),
    state: row.state,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

async function requireExport(db: D1Database, userId: string, exportId: string): Promise<ExportRow> {
  const row = await first<ExportRow>(
    db,
    "SELECT * FROM export_jobs WHERE id=? AND user_id=?",
    exportId,
    userId,
  );
  if (!row) throw new ApiError(404, "EXPORT_NOT_FOUND", "Export was not found.");
  return row;
}

function toExportPaper(row: SqlRow): ExportPaper {
  const paper = paperFromRow(row);
  const identifiers = paper.identifiers as Array<{
    identifierType?: string;
    normalizedValue?: string;
  }>;
  return {
    id: String(paper.id),
    title: String(paper.title),
    authors: (paper.authors as Array<{ displayName: string; orcid?: string | null }>).map(
      (author) => ({
        displayName: author.displayName,
        orcid: author.orcid ?? null,
      }),
    ),
    publicationYear: paper.publicationYear as number | null,
    publicationDate: paper.publicationDate as string | null,
    venue: paper.venue as string | null,
    volume: paper.volume as string | null,
    issue: paper.issue as string | null,
    pages: paper.pages as string | null,
    publisher: paper.publisher as string | null,
    language: paper.language as string | null,
    paperType: paper.paperType as string,
    status: paper.status as string,
    readingStatus: paper.readingStatus as string,
    rating: paper.rating as number | null,
    doi:
      identifiers.find((identifier) => identifier.identifierType === "doi")?.normalizedValue ??
      null,
    arxivId:
      identifiers.find((identifier) => identifier.identifierType === "arxiv")?.normalizedValue ??
      null,
    sourceUrl: paper.sourceUrl as string | null,
    abstract: paper.abstract as string | null,
    noteMarkdown: paper.noteMarkdown as string | null,
    tags: (paper.tags as Array<{ name: string }>).map((tag) => tag.name),
    createdAt: String(paper.createdAt),
    updatedAt: String(paper.updatedAt),
  };
}

export const exportsRoutes = new Hono<AppBindings>();

async function createExport(
  c: Context<AppBindings>,
  forcedFormat?: z.infer<typeof createExportSchema>["format"],
): Promise<Response> {
  const rawInput: unknown = await c.req.json();
  const body =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const input = createExportSchema.parse(forcedFormat ? { ...body, format: forcedFormat } : body);
  if (!input.all && (!input.paperIds || input.paperIds.length === 0)) {
    throw new ApiError(422, "EXPORT_SELECTION_REQUIRED", "Select paperIds or set all to true.");
  }
  if (input.format === "backup" && (!input.all || (input.paperIds?.length ?? 0) > 0)) {
    throw new ApiError(
      422,
      "BACKUP_REQUIRES_FULL_LIBRARY",
      "A backup always requires all=true and no paperIds.",
    );
  }
  const userId = c.get("user").id;
  const exportId = createId("exp");
  const now = nowUtcIso();
  const expiresAt = addSeconds(now, 60 * 60 * 24);
  const query = { all: input.all, paperIds: input.paperIds ?? [] };
  if (input.format === "backup") {
    const job: JobMessage = {
      jobId: createId("job"),
      type: "export.generate",
      userId,
      exportId,
      sourceVersion: 1,
      attempt: 1,
    };
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO export_jobs
          (id,user_id,format,query_json,state,created_at,expires_at)
         VALUES (?,?,?,?,'pending',?,?)`,
      ).bind(exportId, userId, input.format, JSON.stringify(query), now, expiresAt),
      jobOutboxStatement(c.env.DB, job, now),
    ]);
    c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, [job]));
    return c.json(
      { id: exportId, format: input.format, state: "pending", createdAt: now, expiresAt },
      202,
    );
  }

  const bindings: unknown[] = [userId];
  let selection = "p.user_id=? AND p.deleted_at IS NULL";
  if (!input.all && input.paperIds) {
    selection += ` AND p.id IN (${input.paperIds.map(() => "?").join(",")})`;
    bindings.push(...input.paperIds);
  }
  const maximum = requirePositiveInt(c.env.MAX_EXPORT_BYTES, 25 * 1024 * 1024, 100 * 1024 * 1024);
  const estimate = await first<{ bytes: number } & Record<string, unknown>>(
    c.env.DB,
    `SELECT COALESCE(SUM(
       length(COALESCE(p.title,'')) + length(COALESCE(p.abstract,'')) + length(COALESCE(p.venue,'')) +
       length(COALESCE(p.publisher,'')) + length(COALESCE(p.source_url,'')) + 4096
     ),0) AS bytes FROM papers p WHERE ${selection}`,
    ...bindings,
  );
  if (Number(estimate?.bytes ?? 0) > maximum) {
    throw new ApiError(
      413,
      "EXPORT_TOO_LARGE",
      "The selected metadata exceeds the synchronous export limit.",
      {
        maximum,
      },
    );
  }
  const rows = await all<SqlRow>(
    c.env.DB,
    `SELECT p.*, ${PAPER_AGGREGATES_SQL} FROM papers p WHERE ${selection} ORDER BY p.created_at`,
    ...bindings,
  );
  if (!input.all && rows.length !== new Set(input.paperIds).size) {
    throw new ApiError(404, "PAPER_NOT_FOUND", "One or more selected papers were not found.");
  }
  const generated = exportPapers(rows.map(toExportPaper), input.format);
  const bytes = new TextEncoder().encode(generated.content).byteLength;
  if (bytes > maximum) {
    throw new ApiError(
      413,
      "EXPORT_TOO_LARGE",
      "The generated export exceeds the configured limit.",
      { maximum },
    );
  }
  const r2Key = objectKeyFor({
    userId,
    exportId,
    kind: "export",
    extension: generated.fileExtension,
  });
  await c.env.FILES.put(r2Key, generated.content, {
    httpMetadata: {
      contentType: generated.mediaType,
      contentDisposition: `attachment; filename="citera.${generated.fileExtension}"`,
    },
    customMetadata: { userId, exportId },
  });
  await c.env.DB.prepare(
    `INSERT INTO export_jobs
      (id,user_id,format,query_json,state,r2_key,media_type,size_bytes,created_at,completed_at,expires_at)
     VALUES (?,?,?,?,'complete',?,?,?,?,?,?)`,
  )
    .bind(
      exportId,
      userId,
      input.format,
      JSON.stringify(query),
      r2Key,
      generated.mediaType,
      bytes,
      now,
      now,
      expiresAt,
    )
    .run();
  return c.json(
    {
      id: exportId,
      format: input.format,
      state: "complete",
      mediaType: generated.mediaType,
      sizeBytes: bytes,
      createdAt: now,
      completedAt: now,
      expiresAt,
    },
    201,
  );
}

exportsRoutes.post("/", (c) => createExport(c));
for (const format of ["bibtex", "ris", "csv"] as const) {
  exportsRoutes.post(`/${format}`, (c) => createExport(c, format));
}

exportsRoutes.get("/:exportId", async (c) => {
  const row = await requireExport(c.env.DB, c.get("user").id, c.req.param("exportId"));
  return c.json(exportResponse(row));
});

exportsRoutes.get("/:exportId/download-url", async (c) => {
  const row = await requireExport(c.env.DB, c.get("user").id, c.req.param("exportId"));
  if (row.state !== "complete" || !row.r2_key || row.expires_at <= nowUtcIso()) {
    throw new ApiError(409, "EXPORT_NOT_READY", "The export is not ready or has expired.");
  }
  if (!keyBelongsToUser(row.r2_key, c.get("user").id)) {
    throw new ApiError(
      500,
      "EXPORT_KEY_SCOPE_INVALID",
      "Stored export key failed its tenant scope check.",
    );
  }
  const ttl = requirePositiveInt(c.env.PRESIGN_TTL_SECONDS, 300, 900);
  const download =
    c.env.ENVIRONMENT === "production"
      ? await presignR2(c.env, { key: row.r2_key, method: "GET", expiresIn: ttl })
      : {
          url: new URL(`/v1/exports/${row.id}/content`, c.req.url).toString(),
          headers: {},
          expiresIn: ttl,
        };
  return c.json({ ...download, mediaType: row.media_type, sizeBytes: row.size_bytes });
});

exportsRoutes.get("/:exportId/content", async (c) => {
  if (c.env.ENVIRONMENT === "production") throw new ApiError(404, "NOT_FOUND", "Route not found.");
  const row = await requireExport(c.env.DB, c.get("user").id, c.req.param("exportId"));
  if (row.state !== "complete" || !row.r2_key)
    throw new ApiError(409, "EXPORT_NOT_READY", "The export is not ready.");
  const object = await c.env.FILES.get(row.r2_key);
  if (!object) throw new ApiError(404, "OBJECT_NOT_FOUND", "The export object was not found.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
});

export const usageRoutes = new Hono<AppBindings>();

usageRoutes.get("/", async (c) => {
  const userId = c.get("user").id;
  const row = await first<Record<string, unknown>>(
    c.env.DB,
    `SELECT
      (SELECT COUNT(*) FROM papers WHERE user_id=? AND deleted_at IS NULL) AS papers,
      (SELECT COUNT(*) FROM notes WHERE user_id=? AND deleted_at IS NULL) AS notes,
      (SELECT COUNT(*) FROM tags WHERE user_id=?) AS tags,
      (SELECT COUNT(*) FROM collections WHERE user_id=? AND deleted_at IS NULL) AS collections,
      (SELECT COUNT(*) FROM files WHERE user_id=? AND upload_state='verified') AS files,
      (SELECT COALESCE(SUM(size_bytes),0) FROM files WHERE user_id=? AND upload_state='verified') AS bytes`,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
  );
  return c.json({
    papers: Number(row?.papers ?? 0),
    notes: Number(row?.notes ?? 0),
    tags: Number(row?.tags ?? 0),
    collections: Number(row?.collections ?? 0),
    files: Number(row?.files ?? 0),
    storageBytes: Number(row?.bytes ?? 0),
  });
});
