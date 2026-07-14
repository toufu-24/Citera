import {
  IdentifierTypeSchema,
  HttpUrlSchema,
  PaperStatusSchema,
  PaperTypeSchema,
  normalizeArxivId,
  normalizeComparableText,
  normalizeDoi,
  normalizeUrl,
  parseArxivId,
} from "@citera/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { all, changeStatement, first } from "../db";
import { ApiError } from "../errors";
import { dispatchOutboxJobs, jobIdempotencyKey, jobOutboxStatement } from "../jobs";
import { readUserPreferences } from "../preferences";
import { bufferToHex, keyBelongsToUser, objectKeyFor, presignR2 } from "../r2";
import type { AppBindings, JobMessage } from "../types";
import { createId, nowUtcIso, requirePositiveInt } from "../utils";

const uploadSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  mediaType: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive(),
  originalName: z.string().trim().min(1).max(500),
  kind: z.enum(["original_pdf", "supplement"]).default("original_pdf"),
  fileKind: z.enum(["fulltext", "translation", "bilingual", "supplement", "other"]).optional(),
  label: z.string().trim().max(200).nullable().optional(),
  languageCode: z.enum(["ja", "en", "de", "fr", "zh-Hans", "zh-Hant"]).nullable().optional(),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  ingestionId: z.string().min(1).optional(),
});

const filePatchSchema = z
  .object({
    label: z.string().trim().max(200).nullable().optional(),
    fileKind: z.enum(["fulltext", "translation", "bilingual", "supplement", "other"]).optional(),
    languageCode: z.enum(["ja", "en", "de", "fr", "zh-Hans", "zh-Hant"]).nullable().optional(),
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one file field is required");

const ingestionPaperSchema = z.object({
  title: z.string().trim().min(1).max(10_000),
  abstract: z.string().max(1_000_000).nullable().optional(),
  publicationYear: z.number().int().min(1000).max(9999).nullable().optional(),
  venue: z.string().max(2_000).nullable().optional(),
  paperType: PaperTypeSchema.default("article-journal"),
  status: PaperStatusSchema.default("inbox"),
  sourceUrl: HttpUrlSchema.nullable().optional(),
  authors: z
    .array(z.object({ displayName: z.string().trim().min(1).max(500) }))
    .max(200)
    .default([]),
  tagIds: z.array(z.string().min(1).max(100)).max(100).default([]),
  collectionIds: z.array(z.string().min(1).max(100)).max(100).default([]),
  identifiers: z
    .array(
      z.object({
        identifierType: IdentifierTypeSchema,
        originalValue: z.string().trim().min(1).max(2_048),
      }),
    )
    .max(30)
    .default([]),
  observedMetadata: z
    .object({
      publicationDate: z.string().date().nullable().optional(),
      pdfUrl: HttpUrlSchema.nullable().optional(),
      keywords: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
      detectedSources: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    })
    .strict()
    .optional(),
});

const ingestionSchema = z.object({
  clientMutationId: z.string().min(1).max(200),
  sourceType: z.enum(["manual", "extension", "web", "doi", "arxiv", "webpage", "import", "pdf"]),
  sourceUrl: HttpUrlSchema.nullable().optional(),
  paperId: z.string().min(1).optional(),
  paper: ingestionPaperSchema.optional(),
  includePdf: z.boolean().default(false),
});

interface FileRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  paper_id: string;
  ingestion_id: string | null;
  r2_key: string;
  sha256: string;
  media_type: string;
  size_bytes: number;
  original_name: string;
  kind: "original_pdf" | "supplement";
  label: string | null;
  file_kind: "fulltext" | "translation" | "bilingual" | "supplement" | "other" | null;
  language_code: string | null;
  is_default: number;
  sort_order: number;
  upload_state: "pending" | "uploaded" | "verified" | "failed";
  deleted_at: string | null;
}

interface IngestionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  paper_id: string | null;
  client_mutation_id: string;
  source_type: string;
  source_url: string | null;
  state: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_json: string | null;
}

function fileResponse(file: FileRow): Record<string, unknown> {
  const fileKind = file.file_kind ?? (file.kind === "supplement" ? "supplement" : "fulltext");
  const languageLabels: Record<string, string> = {
    ja: "日本語",
    en: "英語",
    de: "ドイツ語",
    fr: "フランス語",
    "zh-Hans": "中国語（簡体）",
    "zh-Hant": "中国語（繁体）",
  };
  const kindLabels: Record<string, string> = {
    fulltext: "本文",
    translation: "翻訳版",
    bilingual: "対訳版",
    supplement: "補足資料",
    other: "その他",
  };
  return {
    id: file.id,
    paperId: file.paper_id,
    ingestionId: file.ingestion_id,
    sha256: file.sha256,
    mediaType: file.media_type,
    sizeBytes: file.size_bytes,
    originalName: file.original_name,
    kind: file.kind,
    fileKind,
    label: file.label ?? `${kindLabels[fileKind] ?? "PDF"}${file.language_code ? `（${languageLabels[file.language_code] ?? file.language_code}）` : ""}`,
    languageCode: file.language_code,
    isDefault: file.is_default === 1,
    sortOrder: file.sort_order,
    uploadState: file.upload_state,
    deletedAt: file.deleted_at,
  };
}

function ingestionResponse(row: IngestionRow): Record<string, unknown> {
  return {
    id: row.id,
    ingestionId: row.id,
    paperId: row.paper_id,
    clientMutationId: row.client_mutation_id,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    state: row.state,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function normalizeIngestionIdentifier(input: {
  identifierType: z.infer<typeof IdentifierTypeSchema>;
  originalValue: string;
}): {
  identifierType: z.infer<typeof IdentifierTypeSchema>;
  normalizedValue: string;
  originalValue: string;
  version: string | null;
} {
  let normalizedValue: string | null;
  let version: string | null = null;
  if (input.identifierType === "doi") normalizedValue = normalizeDoi(input.originalValue);
  else if (input.identifierType === "arxiv") {
    normalizedValue = normalizeArxivId(input.originalValue);
    const parsed = parseArxivId(input.originalValue);
    version = parsed?.version == null ? null : `v${parsed.version}`;
  } else if (input.identifierType === "url") normalizedValue = normalizeUrl(input.originalValue);
  else normalizedValue = input.originalValue.normalize("NFKC").trim().toLowerCase();
  if (!normalizedValue) {
    throw new ApiError(
      422,
      "INVALID_IDENTIFIER",
      `The ${input.identifierType} identifier is invalid.`,
    );
  }
  return { ...input, normalizedValue, version };
}

async function requireFile(db: D1Database, userId: string, fileId: string): Promise<FileRow> {
  const file = await first<FileRow>(
    db,
    "SELECT * FROM files WHERE id=? AND user_id=?",
    fileId,
    userId,
  );
  if (!file) throw new ApiError(404, "FILE_NOT_FOUND", "File was not found.");
  if (!keyBelongsToUser(file.r2_key, userId)) {
    throw new ApiError(
      500,
      "FILE_KEY_SCOPE_INVALID",
      "Stored object key failed its tenant scope check.",
    );
  }
  return file;
}

async function requireIngestion(
  db: D1Database,
  userId: string,
  ingestionId: string,
): Promise<IngestionRow> {
  const row = await first<IngestionRow>(
    db,
    "SELECT * FROM ingestions WHERE id=? AND user_id=?",
    ingestionId,
    userId,
  );
  if (!row) throw new ApiError(404, "INGESTION_NOT_FOUND", "Ingestion was not found.");
  return row;
}

async function invalidateUploadedFile(env: AppBindings["Bindings"], file: FileRow): Promise<void> {
  await Promise.all([
    env.DB.prepare("UPDATE files SET upload_state='failed' WHERE id=? AND user_id=?")
      .bind(file.id, file.user_id)
      .run(),
    env.FILES.delete(file.r2_key),
  ]);
}

function paperJobs(input: {
  userId: string;
  paperId: string;
  fileId?: string;
  sourceVersion: number;
}): JobMessage[] {
  const common = {
    userId: input.userId,
    paperId: input.paperId,
    sourceVersion: input.sourceVersion,
    attempt: 1,
  };
  return [
    ...(input.fileId
      ? [{ ...common, jobId: createId("job"), type: "pdf.extract" as const, fileId: input.fileId }]
      : [{ ...common, jobId: createId("job"), type: "paper.enrich" as const }]),
    { ...common, jobId: createId("job"), type: "search.reindex" as const },
  ];
}

async function ingestionMaintenanceJobs(
  db: D1Database,
  input: { userId: string; paperId: string; ingestionId: string },
): Promise<JobMessage[]> {
  const paper = await first<{ version: number } & Record<string, unknown>>(
    db,
    "SELECT version FROM papers WHERE id=? AND user_id=?",
    input.paperId,
    input.userId,
  );
  const files = await all<{ id: string } & Record<string, unknown>>(
    db,
    `SELECT id FROM files
     WHERE ingestion_id=? AND user_id=? AND paper_id=? AND upload_state='verified' AND deleted_at IS NULL`,
    input.ingestionId,
    input.userId,
    input.paperId,
  );
  const sourceVersion = Number(paper?.version ?? 1);
  const jobs = [
    ...paperJobs({ userId: input.userId, paperId: input.paperId, sourceVersion }),
    ...files.flatMap((file) =>
      paperJobs({ userId: input.userId, paperId: input.paperId, fileId: file.id, sourceVersion }),
    ),
  ];
  return [...new Map(jobs.map((job) => [jobIdempotencyKey(job), job])).values()];
}

export const ingestionsRoutes = new Hono<AppBindings>();

ingestionsRoutes.post("/", async (c) => {
  const rawInput: unknown = await c.req.json();
  const parsedInput = ingestionSchema.parse(rawInput);
  const userId = c.get("user").id;
  let input: z.infer<typeof ingestionSchema> = parsedInput;
  if (parsedInput.paper) {
    const rawPaper =
      rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>).paper
        : null;
    const suppliedPaperFields =
      rawPaper && typeof rawPaper === "object" && !Array.isArray(rawPaper)
        ? (rawPaper as Record<string, unknown>)
        : {};
    const preferences = await readUserPreferences(c.env.DB, userId);
    input = {
      ...parsedInput,
      paper: {
        ...parsedInput.paper,
        status: Object.hasOwn(suppliedPaperFields, "status")
          ? parsedInput.paper.status
          : preferences.defaultStatus,
        tagIds: Object.hasOwn(suppliedPaperFields, "tagIds")
          ? parsedInput.paper.tagIds
          : preferences.defaultTagIds,
        collectionIds: Object.hasOwn(suppliedPaperFields, "collectionIds")
          ? parsedInput.paper.collectionIds
          : preferences.defaultCollectionId
            ? [preferences.defaultCollectionId]
            : [],
      },
    };
  }
  const duplicate = await first<IngestionRow>(
    c.env.DB,
    "SELECT * FROM ingestions WHERE user_id=? AND client_mutation_id=?",
    userId,
    input.clientMutationId,
  );
  if (duplicate) {
    if (duplicate.result_json) {
      try {
        return c.json(JSON.parse(duplicate.result_json) as Record<string, unknown>);
      } catch {
        // Fall back to the canonical row representation for old/corrupt local data.
      }
    }
    return c.json(ingestionResponse(duplicate));
  }
  let paperId = input.paperId;
  if (paperId) {
    const paper = await first<Record<string, unknown>>(
      c.env.DB,
      "SELECT id FROM papers WHERE id=? AND user_id=? AND deleted_at IS NULL",
      paperId,
      userId,
    );
    if (!paper) throw new ApiError(404, "PAPER_NOT_FOUND", "Paper was not found.");
  } else if (input.paper) {
    const identifiers = input.paper.identifiers.map(normalizeIngestionIdentifier);
    const seenIdentifiers = new Set<string>();
    for (const identifier of identifiers) {
      const key = `${identifier.identifierType}:${identifier.normalizedValue}`;
      if (seenIdentifiers.has(key)) {
        throw new ApiError(422, "DUPLICATE_IDENTIFIER_INPUT", "An identifier was repeated.");
      }
      seenIdentifiers.add(key);
      const existing = await first<{ paper_id: string; title: string } & Record<string, unknown>>(
        c.env.DB,
        `SELECT pi.paper_id,p.title FROM paper_identifiers pi
           JOIN papers p ON p.id=pi.paper_id AND p.user_id=pi.user_id
           WHERE pi.user_id=? AND pi.identifier_type=? AND pi.normalized_value=? AND p.deleted_at IS NULL`,
        userId,
        identifier.identifierType,
        identifier.normalizedValue,
      );
      if (existing) {
        const id = createId("ing");
        const now = nowUtcIso();
        const result = {
          id,
          ingestionId: id,
          paperId: existing.paper_id,
          state: "complete",
          duplicate: {
            paperId: existing.paper_id,
            title: existing.title,
            reason: identifier.identifierType,
          },
        };
        await c.env.DB.prepare(
          `INSERT INTO ingestions
            (id,user_id,paper_id,client_mutation_id,source_type,source_url,state,result_json,created_at,updated_at,completed_at)
           VALUES (?,?,?,?,?,?,'complete',?,?,?,?)`,
        )
          .bind(
            id,
            userId,
            existing.paper_id,
            input.clientMutationId,
            input.sourceType,
            input.sourceUrl ?? null,
            JSON.stringify(result),
            now,
            now,
            now,
          )
          .run();
        return c.json(result);
      }
    }
    for (const [table, ids] of [
      ["tags", input.paper.tagIds],
      ["collections", input.paper.collectionIds],
    ] as const) {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length) {
        const owned = await first<{ count: number } & Record<string, unknown>>(
          c.env.DB,
          `SELECT COUNT(*) AS count FROM ${table} WHERE user_id=? AND id IN (${uniqueIds.map(() => "?").join(",")}) ${table === "collections" ? "AND deleted_at IS NULL" : ""
          }`,
          userId,
          ...uniqueIds,
        );
        if (Number(owned?.count ?? 0) !== uniqueIds.length) {
          throw new ApiError(422, "RELATED_ENTITY_NOT_FOUND", `One or more ${table} do not exist.`);
        }
      }
    }
    paperId = createId("pap");
    const now = nowUtcIso();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO papers
          (id,user_id,library_id,title,abstract,publication_year,venue,paper_type,status,reading_status,
           source_url,metadata_state,search_text,version,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,1,?,?)`,
      ).bind(
        paperId,
        userId,
        c.get("libraryId"),
        input.paper.title,
        input.paper.abstract ?? null,
        input.paper.publicationYear ?? null,
        input.paper.venue ?? null,
        input.paper.paperType,
        input.paper.status,
        input.paper.status === "reading"
          ? "reading"
          : input.paper.status === "read"
            ? "read"
            : input.paper.status === "archived"
              ? "on_hold"
              : "unread",
        input.paper.sourceUrl ?? input.sourceUrl ?? null,
        normalizeComparableText(
          [
            input.paper.title,
            input.paper.abstract,
            input.paper.venue,
            ...input.paper.authors.map((author) => author.displayName),
          ]
            .filter(Boolean)
            .join(" "),
        ),
        now,
        now,
      ),
    ];
    for (const identifier of identifiers) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO paper_identifiers
            (id,user_id,paper_id,identifier_type,normalized_value,original_value,identifier_version,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).bind(
          createId("pid"),
          userId,
          paperId,
          identifier.identifierType,
          identifier.normalizedValue,
          identifier.originalValue,
          identifier.version,
          now,
        ),
      );
    }
    for (const [position, author] of input.paper.authors.entries()) {
      const normalized = normalizeComparableText(author.displayName);
      const saved = await first<{ id: string } & Record<string, unknown>>(
        c.env.DB,
        "SELECT id FROM authors WHERE user_id=? AND normalized_name=? AND orcid IS NULL LIMIT 1",
        userId,
        normalized,
      );
      const authorId = saved?.id ?? createId("aut");
      if (!saved) {
        statements.push(
          c.env.DB.prepare(
            "INSERT INTO authors (id,user_id,normalized_name,display_name,orcid,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?)",
          ).bind(authorId, userId, normalized, author.displayName, now, now),
        );
      }
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO paper_authors (user_id,paper_id,author_id,position,role) VALUES (?,?,?,?,'author')",
        ).bind(userId, paperId, authorId, position),
      );
    }
    for (const tagId of new Set(input.paper.tagIds)) {
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO paper_tags (user_id,paper_id,tag_id,library_id,created_at) VALUES (?,?,?,?,?)",
        ).bind(userId, paperId, tagId, c.get("libraryId"), now),
      );
    }
    for (const collectionId of new Set(input.paper.collectionIds)) {
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO collection_papers (user_id,collection_id,paper_id,created_at) VALUES (?,?,?,?)",
        ).bind(userId, collectionId, paperId, now),
      );
    }
    const observedMetadata: Record<string, unknown> = {
      title: input.paper.title,
      ...(input.paper.abstract == null ? {} : { abstract: input.paper.abstract }),
      ...(input.paper.publicationYear == null
        ? {}
        : { publicationYear: input.paper.publicationYear }),
      ...(input.paper.venue == null ? {} : { venue: input.paper.venue }),
      ...(input.paper.sourceUrl == null && input.sourceUrl == null
        ? {}
        : { url: input.paper.sourceUrl ?? input.sourceUrl }),
      ...(input.paper.authors.length === 0 ? {} : { authors: input.paper.authors }),
      ...input.paper.observedMetadata,
    };
    const sourceType =
      input.sourceType === "manual"
        ? "user"
        : input.sourceType === "import"
          ? "import"
          : input.sourceType === "pdf"
            ? "pdf"
            : "webpage";
    for (const [field, value] of Object.entries(observedMetadata)) {
      if (value == null) continue;
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO metadata_values
            (id,user_id,paper_id,field_name,value_json,source_type,source_reference,confidence,selected,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          createId("mdv"),
          userId,
          paperId,
          field,
          JSON.stringify(value),
          sourceType,
          input.sourceUrl ?? null,
          sourceType === "user" ? 1 : 0.9,
          sourceType === "user" ? 1 : 0,
          now,
          now,
        ),
      );
    }
    statements.push(
      changeStatement(c.env.DB, {
        userId,
        entityType: "paper",
        entityId: paperId,
        operation: "create",
        version: 1,
        data: { id: paperId, ...input.paper, version: 1, createdAt: now, updatedAt: now },
        changedAt: now,
      }),
    );
    await c.env.DB.batch(statements);
  } else {
    throw new ApiError(422, "PAPER_REQUIRED", "paperId or paper metadata is required.");
  }
  const id = createId("ing");
  const now = nowUtcIso();
  const result = { id, ingestionId: id, paperId, state: "pending", includePdf: input.includePdf };
  await c.env.DB.prepare(
    `INSERT INTO ingestions
      (id,user_id,paper_id,client_mutation_id,source_type,source_url,state,result_json,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'pending',?,?,?)`,
  )
    .bind(
      id,
      userId,
      paperId,
      input.clientMutationId,
      input.sourceType,
      input.sourceUrl ?? null,
      JSON.stringify(result),
      now,
      now,
    )
    .run();
  return c.json(result, 201);
});

ingestionsRoutes.get("/:ingestionId", async (c) => {
  const row = await requireIngestion(c.env.DB, c.get("user").id, c.req.param("ingestionId"));
  const files = await all<FileRow>(
    c.env.DB,
    "SELECT * FROM files WHERE ingestion_id=? AND user_id=? AND deleted_at IS NULL",
    row.id,
    c.get("user").id,
  );
  return c.json({ ...ingestionResponse(row), files: files.map(fileResponse) });
});

ingestionsRoutes.post("/:ingestionId/complete", async (c) => {
  const userId = c.get("user").id;
  const row = await requireIngestion(c.env.DB, userId, c.req.param("ingestionId"));
  if (row.state === "complete") {
    const jobs = row.paper_id
      ? await ingestionMaintenanceJobs(c.env.DB, {
        userId,
        paperId: row.paper_id,
        ingestionId: row.id,
      })
      : [];
    if (jobs.length) {
      await c.env.DB.batch(jobs.map((job) => jobOutboxStatement(c.env.DB, job)));
      c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, jobs));
    }
    return c.json(ingestionResponse(row));
  }
  const pending = await first<{ count: number } & Record<string, unknown>>(
    c.env.DB,
    "SELECT COUNT(*) AS count FROM files WHERE ingestion_id=? AND user_id=? AND deleted_at IS NULL AND upload_state<>'verified'",
    row.id,
    userId,
  );
  if (Number(pending?.count ?? 0) > 0) {
    throw new ApiError(
      409,
      "FILES_NOT_VERIFIED",
      "All uploaded files must be verified before completing ingestion.",
    );
  }
  const now = nowUtcIso();
  const completedResult = {
    ...ingestionResponse(row),
    state: "complete",
    updatedAt: now,
    completedAt: now,
  };
  const jobs = row.paper_id
    ? await ingestionMaintenanceJobs(c.env.DB, {
      userId,
      paperId: row.paper_id,
      ingestionId: row.id,
    })
    : [];
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE ingestions SET state='complete',result_json=?,updated_at=?,completed_at=?,error_code=NULL,error_message=NULL WHERE id=? AND user_id=?",
    ).bind(JSON.stringify(completedResult), now, now, row.id, userId),
    ...jobs.map((job) => jobOutboxStatement(c.env.DB, job, now)),
  ]);
  if (jobs.length) c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, jobs));
  return c.json(completedResult);
});

ingestionsRoutes.post("/:ingestionId/retry", async (c) => {
  const userId = c.get("user").id;
  const row = await requireIngestion(c.env.DB, userId, c.req.param("ingestionId"));
  if (row.state !== "failed")
    throw new ApiError(409, "INGESTION_NOT_FAILED", "Only failed ingestions can be retried.");
  const now = nowUtcIso();
  const jobs = row.paper_id
    ? await ingestionMaintenanceJobs(c.env.DB, {
      userId,
      paperId: row.paper_id,
      ingestionId: row.id,
    })
    : [];
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE ingestions SET state='processing',error_code=NULL,error_message=NULL,updated_at=? WHERE id=? AND user_id=?",
    ).bind(now, row.id, userId),
    ...jobs.map((job) => jobOutboxStatement(c.env.DB, job, now)),
  ]);
  if (jobs.length) c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, jobs));
  return c.json({ ...ingestionResponse(row), state: "processing", updatedAt: now }, 202);
});

export const filesRoutes = new Hono<AppBindings>();

const createUploadTicket = async (c: Context<AppBindings>): Promise<Response> => {
  const input = uploadSchema.parse(await c.req.json());
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId") ?? c.req.param("itemId");
  const maxBytes = requirePositiveInt(
    c.env.MAX_PDF_BYTES,
    100 * 1024 * 1024,
    5 * 1024 * 1024 * 1024,
  );
  if (input.sizeBytes > maxBytes) {
    throw new ApiError(
      413,
      "FILE_TOO_LARGE",
      "The PDF exceeds this Citera instance's configured size limit.",
      {
        maxBytes,
      },
    );
  }
  if (input.mediaType.toLowerCase() !== "application/pdf") {
    throw new ApiError(422, "FILE_NOT_PDF", "PDF uploads must use application/pdf.");
  }
  const storageLimit = requirePositiveInt(
    c.env.MAX_USER_STORAGE_BYTES,
    5 * 1024 * 1024 * 1024,
    5 * 1024 * 1024 * 1024 * 1024,
  );
  const storage = await first<{ bytes: number } & Record<string, unknown>>(
    c.env.DB,
    `SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM files
     WHERE user_id=? AND deleted_at IS NULL AND upload_state IN ('pending','uploaded','verified')`,
    userId,
  );
  if (Number(storage?.bytes ?? 0) + input.sizeBytes > storageLimit) {
    throw new ApiError(
      413,
      "STORAGE_QUOTA_EXCEEDED",
      "This upload would exceed the configured storage quota.",
      {
        storageLimit,
        storageBytes: Number(storage?.bytes ?? 0),
      },
    );
  }
  const paper = await first<{ version: number } & Record<string, unknown>>(
    c.env.DB,
    "SELECT version FROM papers WHERE id=? AND user_id=? AND deleted_at IS NULL",
    paperId,
    userId,
  );
  if (!paper) throw new ApiError(404, "PAPER_NOT_FOUND", "Paper was not found.");
  if (!paperId) throw new ApiError(404, "PAPER_NOT_FOUND", "Paper was not found.");
  if (input.ingestionId) await requireIngestion(c.env.DB, userId, input.ingestionId);
  const fileKind = input.fileKind ?? (input.kind === "supplement" ? "supplement" : "fulltext");
  const storageKind = fileKind === "supplement" ? "supplement" : "original_pdf";
  const duplicate = await first<FileRow>(
    c.env.DB,
    `SELECT * FROM files
     WHERE user_id=? AND paper_id=? AND sha256=? AND deleted_at IS NULL
     ORDER BY created_at LIMIT 1`,
    userId,
    paperId,
    input.sha256,
  );
  if (duplicate?.upload_state === "verified" || duplicate?.upload_state === "uploaded") {
    return c.json({ file: fileResponse(duplicate), upload: null, duplicate: true });
  }
  const fileId = duplicate?.id ?? createId("fil");
  const r2Key = duplicate?.r2_key ?? objectKeyFor({
    userId,
    paperId,
    fileId,
    kind: storageKind,
    extension: "pdf",
  });
  const now = nowUtcIso();
  if (input.isDefault) {
    await c.env.DB.prepare("UPDATE files SET is_default=0 WHERE paper_id=? AND deleted_at IS NULL")
      .bind(paperId)
      .run();
  }
  if (duplicate) {
    await c.env.DB.prepare(
      `UPDATE files SET ingestion_id=?,media_type=?,size_bytes=?,original_name=?,kind=?,
       label=?,file_kind=?,language_code=?,is_default=?,sort_order=?,upload_state='pending',deleted_at=NULL
       WHERE id=? AND user_id=? AND paper_id=?`,
    )
      .bind(
        input.ingestionId ?? duplicate.ingestion_id,
        input.mediaType,
        input.sizeBytes,
        input.originalName,
        storageKind,
        input.label ?? duplicate.label,
        fileKind,
        input.languageCode ?? duplicate.language_code,
        input.isDefault ? 1 : duplicate.is_default,
        input.sortOrder,
        fileId,
        userId,
        paperId,
      )
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO files
        (id,user_id,paper_id,ingestion_id,r2_key,sha256,media_type,size_bytes,original_name,kind,
         label,file_kind,language_code,is_default,sort_order,upload_state,created_at,deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,NULL)`,
    )
      .bind(
        fileId,
        userId,
        paperId,
        input.ingestionId ?? null,
        r2Key,
        input.sha256,
        input.mediaType,
        input.sizeBytes,
        input.originalName,
        storageKind,
        input.label ?? null,
        fileKind,
        input.languageCode ?? null,
        input.isDefault ? 1 : 0,
        input.sortOrder,
        now,
      )
      .run();
  }
  const ttl = requirePositiveInt(c.env.PRESIGN_TTL_SECONDS, 300, 900);
  const upload =
    c.env.ENVIRONMENT === "production"
      ? await presignR2(c.env, {
        key: r2Key,
        method: "PUT",
        contentType: input.mediaType,
        contentLength: input.sizeBytes,
        sha256: input.sha256,
        expiresIn: ttl,
      })
      : {
        url: new URL(`${c.req.path.startsWith("/api/v1") ? "/api/v1" : "/v1"}/files/${fileId}/content`, c.env.APP_ORIGIN).toString(),
        headers: { "Content-Type": input.mediaType, "If-None-Match": "*" },
        expiresIn: ttl,
      };
  const file = await requireFile(c.env.DB, userId, fileId);
  return c.json({ file: fileResponse(file), upload, duplicate: Boolean(duplicate) }, duplicate ? 200 : 201);
};

filesRoutes.post("/papers/:paperId/files/upload-url", createUploadTicket);
filesRoutes.post("/items/:itemId/files/upload-ticket", createUploadTicket);

filesRoutes.put("/files/:fileId/content", async (c) => {
  if (c.env.ENVIRONMENT === "production") throw new ApiError(404, "NOT_FOUND", "Route not found.");
  const file = await requireFile(c.env.DB, c.get("user").id, c.req.param("fileId"));
  if (file.deleted_at) throw new ApiError(404, "FILE_NOT_FOUND", "File was not found.");
  if (file.upload_state === "verified") return c.body(null, 204);
  const contentLengthHeader = c.req.header("Content-Length");
  const contentLength = Number(contentLengthHeader);
  if (contentLengthHeader && (!Number.isSafeInteger(contentLength) || contentLength < 0)) {
    throw new ApiError(
      400,
      "CONTENT_LENGTH_INVALID",
      "Content-Length must be a non-negative integer.",
    );
  }
  if (Number.isFinite(contentLength) && contentLength !== file.size_bytes) {
    throw new ApiError(
      422,
      "FILE_SIZE_MISMATCH",
      "The uploaded file size does not match the declaration.",
    );
  }
  const body = c.req.raw.body;
  if (!body) {
    throw new ApiError(422, "FILE_BODY_REQUIRED", "A file body is required.");
  }

  const { readable, writable } = new FixedLengthStream(file.size_bytes);

  try {
    const putPromise = c.env.FILES.put(file.r2_key, readable, {
      httpMetadata: { contentType: file.media_type },
      customMetadata: {
        userId: file.user_id,
        paperId: file.paper_id,
        fileId: file.id,
      },
      sha256: file.sha256,
      onlyIf: { etagDoesNotMatch: "*" },
    });

    const pipePromise = body.pipeTo(writable);

    await Promise.all([putPromise, pipePromise]);
  } catch (error) {
    console.error("PDF upload failed", {
      fileId: file.id,
      expectedSize: file.size_bytes,
      error,
    });

    await invalidateUploadedFile(c.env, file);

    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      "FILE_UPLOAD_FAILED",
      error instanceof Error ? error.message : "The PDF upload failed.",
    );
  }
  await c.env.DB.prepare(
    "UPDATE files SET upload_state='uploaded' WHERE id=? AND user_id=? AND upload_state='pending'",
  )
    .bind(file.id, file.user_id)
    .run();
  return c.body(null, 204);
});

filesRoutes.post("/files/:fileId/complete", async (c) => {
  const userId = c.get("user").id;
  const file = await requireFile(c.env.DB, userId, c.req.param("fileId"));
  if (file.deleted_at) throw new ApiError(404, "FILE_NOT_FOUND", "File was not found.");
  if (file.upload_state === "verified") {
    const paper = await first<{ version: number } & Record<string, unknown>>(
      c.env.DB,
      "SELECT version FROM papers WHERE id=? AND user_id=?",
      file.paper_id,
      userId,
    );
    const jobs = paperJobs({
      userId,
      paperId: file.paper_id,
      fileId: file.id,
      sourceVersion: Number(paper?.version ?? 1),
    });
    await c.env.DB.batch(jobs.map((job) => jobOutboxStatement(c.env.DB, job)));
    c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, jobs));
    return c.json(fileResponse(file));
  }
  if (file.upload_state === "pending") {
    throw new ApiError(409, "FILE_UPLOAD_PENDING", "The file has not finished uploading.");
  }
  if (file.upload_state === "failed") {
    throw new ApiError(409, "FILE_UPLOAD_FAILED", "The file upload failed and must be retried.");
  }
  const head = await c.env.FILES.head(file.r2_key);
  if (!head) throw new ApiError(409, "UPLOAD_NOT_FOUND", "The uploaded R2 object was not found.");
  if (head.size !== file.size_bytes) {
    await invalidateUploadedFile(c.env, file);
    throw new ApiError(
      422,
      "FILE_SIZE_MISMATCH",
      "The uploaded file size does not match the declaration.",
      {
        expected: file.size_bytes,
        actual: head.size,
      },
    );
  }
  const checksum = head.checksums.sha256;
  if (!checksum || bufferToHex(checksum) !== file.sha256) {
    await invalidateUploadedFile(c.env, file);
    throw new ApiError(
      422,
      "FILE_CHECKSUM_MISMATCH",
      "The uploaded file checksum does not match the declaration.",
    );
  }
  const prefixObject = await c.env.FILES.get(file.r2_key, { range: { offset: 0, length: 5 } });
  if (!prefixObject)
    throw new ApiError(409, "UPLOAD_NOT_FOUND", "The uploaded R2 object was not found.");
  const prefix = new TextDecoder().decode(await prefixObject.arrayBuffer());
  if (prefix !== "%PDF-") {
    await invalidateUploadedFile(c.env, file);
    throw new ApiError(422, "FILE_NOT_PDF", "The uploaded object is not a PDF.");
  }
  const now = nowUtcIso();
  const paper = await first<{ version: number } & Record<string, unknown>>(
    c.env.DB,
    "SELECT version FROM papers WHERE id=? AND user_id=?",
    file.paper_id,
    userId,
  );
  const jobs = paperJobs({
    userId,
    paperId: file.paper_id,
    fileId: file.id,
    sourceVersion: Number(paper?.version ?? 1),
  });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE files SET upload_state='verified' WHERE id=? AND user_id=?").bind(
      file.id,
      userId,
    ),
    changeStatement(c.env.DB, {
      userId,
      entityType: "file",
      entityId: file.id,
      operation: "create",
      version: 1,
      data: { ...fileResponse(file), uploadState: "verified", verifiedAt: now },
      changedAt: now,
    }),
    ...jobs.map((job) => jobOutboxStatement(c.env.DB, job, now)),
  ]);
  const hasDefault = await first<{ count: number } & Record<string, unknown>>(
    c.env.DB,
    "SELECT COUNT(*) AS count FROM files WHERE paper_id=? AND is_default=1 AND deleted_at IS NULL",
    file.paper_id,
  );
  if (Number(hasDefault?.count ?? 0) === 0) {
    await c.env.DB.prepare(
      "UPDATE files SET is_default=1 WHERE id=? AND user_id=? AND deleted_at IS NULL",
    )
      .bind(file.id, userId)
      .run();
  }
  c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, jobs));
  const verified = await requireFile(c.env.DB, userId, file.id);
  return c.json(fileResponse(verified));
});

filesRoutes.get("/items/:itemId/files", async (c) => {
  const userId = c.get("user").id;
  const paperId = c.req.param("itemId");
  const paper = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT id FROM papers WHERE id=? AND user_id=?",
    paperId,
    userId,
  );
  if (!paper) throw new ApiError(404, "PAPER_NOT_FOUND", "Paper was not found.");
  const files = await all<FileRow>(
    c.env.DB,
    "SELECT * FROM files WHERE paper_id=? AND user_id=? AND deleted_at IS NULL ORDER BY is_default DESC, sort_order, created_at",
    paperId,
    userId,
  );
  return c.json({ items: files.map(fileResponse) });
});

filesRoutes.get("/files/:fileId/download-url", async (c) => {
  const file = await requireFile(c.env.DB, c.get("user").id, c.req.param("fileId"));
  if (file.deleted_at || file.upload_state !== "verified") {
    throw new ApiError(409, "FILE_NOT_VERIFIED", "Only verified files can be downloaded.");
  }
  const ttl = requirePositiveInt(c.env.PRESIGN_TTL_SECONDS, 300, 900);
  const download =
    c.env.ENVIRONMENT === "production"
      ? await presignR2(c.env, { key: file.r2_key, method: "GET", expiresIn: ttl })
      : {
        url: new URL(`${c.req.path.startsWith("/api/v1") ? "/api/v1" : "/v1"}/files/${file.id}/content`, c.env.APP_ORIGIN).toString(),
        headers: {},
        expiresIn: ttl,
      };
  return c.json({ ...download, fileName: file.original_name, mediaType: file.media_type });
});

filesRoutes.get("/files/:fileId/download-ticket", async (c) => {
  const file = await requireFile(c.env.DB, c.get("user").id, c.req.param("fileId"));
  if (file.deleted_at || file.upload_state !== "verified") {
    throw new ApiError(409, "FILE_NOT_VERIFIED", "Only verified files can be downloaded.");
  }
  const ttl = requirePositiveInt(c.env.PRESIGN_TTL_SECONDS, 300, 900);
  const download =
    c.env.ENVIRONMENT === "production"
      ? await presignR2(c.env, { key: file.r2_key, method: "GET", expiresIn: ttl })
      : {
        url: new URL(`${c.req.path.startsWith("/api/v1") ? "/api/v1" : "/v1"}/files/${file.id}/content`, c.env.APP_ORIGIN).toString(),
        headers: {},
        expiresIn: ttl,
      };
  return c.json({ ...download, fileName: file.original_name, mediaType: file.media_type });
});

filesRoutes.patch("/files/:fileId", async (c) => {
  const input = filePatchSchema.parse(await c.req.json());
  const userId = c.get("user").id;
  const file = await requireFile(c.env.DB, userId, c.req.param("fileId"));
  if (file.deleted_at) throw new ApiError(404, "FILE_NOT_FOUND", "File was not found.");
  const fileKind = input.fileKind ?? file.file_kind ?? (file.kind === "supplement" ? "supplement" : "fulltext");
  const storageKind = fileKind === "supplement" ? "supplement" : "original_pdf";
  const isDefault = input.isDefault === undefined ? file.is_default : input.isDefault ? 1 : 0;
  const now = nowUtcIso();
  const statements: D1PreparedStatement[] = [];
  if (isDefault === 1) {
    statements.push(
      c.env.DB.prepare("UPDATE files SET is_default=0 WHERE paper_id=? AND user_id=? AND id<>? AND deleted_at IS NULL").bind(
        file.paper_id,
        userId,
        file.id,
      ),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `UPDATE files SET label=?,file_kind=?,language_code=?,kind=?,is_default=?,sort_order=?
       WHERE id=? AND user_id=? AND deleted_at IS NULL`,
    ).bind(
      input.label === undefined ? file.label : input.label,
      fileKind,
      input.languageCode === undefined ? file.language_code : input.languageCode,
      storageKind,
      isDefault,
      input.sortOrder === undefined ? file.sort_order : input.sortOrder,
      file.id,
      userId,
    ),
    changeStatement(c.env.DB, {
      userId,
      entityType: "file",
      entityId: file.id,
      operation: "update",
      version: 1,
      data: { id: file.id, paperId: file.paper_id, fileKind, isDefault: Boolean(isDefault), updatedAt: now },
      changedAt: now,
    }),
  );
  await c.env.DB.batch(statements);
  return c.json(fileResponse(await requireFile(c.env.DB, userId, file.id)));
});

filesRoutes.post("/files/:fileId/retry", async (c) => {
  const userId = c.get("user").id;
  const file = await requireFile(c.env.DB, userId, c.req.param("fileId"));
  if (file.deleted_at) throw new ApiError(404, "FILE_NOT_FOUND", "File was not found.");
  if (file.upload_state !== "failed") {
    throw new ApiError(409, "FILE_UPLOAD_NOT_FAILED", "Only failed uploads can be retried.");
  }
  await c.env.FILES.delete(file.r2_key);
  await c.env.DB.prepare("UPDATE files SET upload_state='pending' WHERE id=? AND user_id=?")
    .bind(file.id, userId)
    .run();
  const ttl = requirePositiveInt(c.env.PRESIGN_TTL_SECONDS, 300, 900);
  const upload =
    c.env.ENVIRONMENT === "production"
      ? await presignR2(c.env, {
        key: file.r2_key,
        method: "PUT",
        contentType: file.media_type,
        contentLength: file.size_bytes,
        sha256: file.sha256,
        expiresIn: ttl,
      })
      : {
        url: new URL(`${c.req.path.startsWith("/api/v1") ? "/api/v1" : "/v1"}/files/${file.id}/content`, c.env.APP_ORIGIN).toString(),
        headers: { "Content-Type": file.media_type, "If-None-Match": "*" },
        expiresIn: ttl,
      };
  return c.json({ file: fileResponse(await requireFile(c.env.DB, userId, file.id)), upload }, 202);
});

filesRoutes.get("/files/:fileId/content", async (c) => {
  if (c.env.ENVIRONMENT === "production") throw new ApiError(404, "NOT_FOUND", "Route not found.");
  const file = await requireFile(c.env.DB, c.get("user").id, c.req.param("fileId"));
  if (file.deleted_at || file.upload_state !== "verified") {
    throw new ApiError(409, "FILE_NOT_VERIFIED", "Only verified files can be downloaded.");
  }
  const object = await c.env.FILES.get(file.r2_key, { range: c.req.raw.headers });
  if (!object) throw new ApiError(404, "OBJECT_NOT_FOUND", "The R2 object was not found.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  );
  if (c.req.header("Range") && "range" in object && object.range) {
    const range = object.range as { offset: number; length: number };
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
});

filesRoutes.delete("/files/:fileId", async (c) => {
  const userId = c.get("user").id;
  const file = await requireFile(c.env.DB, userId, c.req.param("fileId"));
  if (file.deleted_at) return c.body(null, 204);
  const now = nowUtcIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE files SET deleted_at=? WHERE id=? AND user_id=?").bind(
      now,
      file.id,
      userId,
    ),
    changeStatement(c.env.DB, {
      userId,
      entityType: "file",
      entityId: file.id,
      operation: "delete",
      version: 1,
      data: { id: file.id, paperId: file.paper_id, deletedAt: now },
      changedAt: now,
    }),
  ]);
  if (file.is_default === 1) {
    const replacement = await first<{ id: string } & Record<string, unknown>>(
      c.env.DB,
      `SELECT id FROM files
       WHERE paper_id=? AND user_id=? AND deleted_at IS NULL
       ORDER BY (upload_state='verified') DESC, (file_kind='fulltext') DESC, sort_order, created_at
       LIMIT 1`,
      file.paper_id,
      userId,
    );
    if (replacement) {
      await c.env.DB.prepare("UPDATE files SET is_default=1 WHERE id=? AND user_id=?")
        .bind(replacement.id, userId)
        .run();
    }
  }
  return c.body(null, 204);
});

filesRoutes.post("/files/:fileId/restore", async (c) => {
  const userId = c.get("user").id;
  const file = await requireFile(c.env.DB, userId, c.req.param("fileId"));
  if (!file.deleted_at) return c.json(fileResponse(file));
  const now = nowUtcIso();
  const activeDefault = await first<{ id: string } & Record<string, unknown>>(
    c.env.DB,
    "SELECT id FROM files WHERE paper_id=? AND is_default=1 AND deleted_at IS NULL LIMIT 1",
    file.paper_id,
  );
  await c.env.DB.prepare(
    "UPDATE files SET deleted_at=NULL,is_default=? WHERE id=? AND user_id=?",
  )
    .bind(activeDefault ? 0 : 1, file.id, userId)
    .run();
  await changeStatement(c.env.DB, {
    userId,
    entityType: "file",
    entityId: file.id,
    operation: "restore",
    version: 1,
    data: { id: file.id, paperId: file.paper_id, restoredAt: now },
    changedAt: now,
  }).run();
  return c.json(fileResponse(await requireFile(c.env.DB, userId, file.id)));
});
