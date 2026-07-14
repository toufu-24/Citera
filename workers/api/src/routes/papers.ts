import {
  AuthorSchema,
  HttpUrlSchema,
  IdentifierTypeSchema,
  MetadataStateSchema,
  PaperStatusSchema,
  PaperTypeSchema,
  normalizeArxivId,
  normalizeComparableText,
  normalizeDoi,
  normalizeUrl,
  parseArxivId,
} from "@citera/domain";
import { exportBibTeX, type ExportPaper } from "@citera/export";
import { Hono } from "hono";
import { z } from "zod";
import {
  all,
  changeStatement,
  first,
  PAPER_AGGREGATES_SQL,
  paperFromRow,
  type SqlRow,
} from "../db";
import { ApiError } from "../errors";
import { dispatchOutboxJobs, jobOutboxStatement } from "../jobs";
import { readUserPreferences } from "../preferences";
import { resolveDoiMetadata } from "./metadata";
import type { AppBindings, JobMessage } from "../types";
import { createId, decodeCursor, encodeCursor, nowUtcIso, parseJson } from "../utils";

const identifierInputSchema = z.object({
  identifierType: IdentifierTypeSchema,
  value: z.string().trim().min(1).max(2_048),
});

const authorInputSchema = AuthorSchema.pick({
  displayName: true,
  givenName: true,
  familyName: true,
  orcid: true,
});

const readingStatusSchema = z.enum(["unread", "reading", "read", "on_hold"]);
type ReadingStatus = z.infer<typeof readingStatusSchema>;

function readingStatusFromLegacy(status: z.infer<typeof PaperStatusSchema>): ReadingStatus {
  return status === "reading" ? "reading" : status === "read" ? "read" : status === "archived" ? "on_hold" : "unread";
}

function legacyStatusFromReading(status: ReadingStatus): z.infer<typeof PaperStatusSchema> {
  return status === "reading" ? "reading" : status === "read" ? "read" : status === "on_hold" ? "archived" : "inbox";
}

const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();

const paperFieldsSchema = z.object({
  title: z.string().trim().min(1).max(10_000),
  abstract: nullableText(1_000_000),
  publicationYear: z.number().int().min(1000).max(9999).nullable().optional(),
  publicationDate: z.string().date().nullable().optional(),
  venue: nullableText(2_000),
  volume: nullableText(100),
  issue: nullableText(100),
  pages: nullableText(100),
  publisher: nullableText(2_000),
  language: nullableText(35),
  paperType: PaperTypeSchema.default("article-journal"),
  status: PaperStatusSchema.default("inbox"),
  readingStatus: readingStatusSchema.optional(),
  priority: z.number().int().min(0).max(5).default(0),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  readProgress: z.number().min(0).max(100).default(0),
  sourceUrl: HttpUrlSchema.nullable().optional(),
  metadataState: MetadataStateSchema.default("pending"),
  noteMarkdown: z.string().max(1_000_000).nullable().optional(),
});

const createPaperSchema = paperFieldsSchema.extend({
  identifiers: z.array(identifierInputSchema).max(30).default([]),
  authors: z.array(authorInputSchema).max(200).default([]),
  tagIds: z.array(z.string().min(1)).max(100).default([]),
  collectionIds: z.array(z.string().min(1)).max(100).default([]),
  clientMutationId: z.string().min(1).max(200).optional(),
});

const patchPaperSchema = paperFieldsSchema
  .partial()
  .extend({
    identifiers: z.array(identifierInputSchema).max(30).optional(),
    authors: z.array(authorInputSchema).max(200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

const listPapersSchema = z.object({
  q: z.string().trim().max(500).optional(),
  tags: z.string().max(2_000).optional(),
  collection: z.string().max(200).optional(),
  author: z.string().max(500).optional(),
  venue: z.string().max(2_000).optional(),
  status: PaperStatusSchema.optional(),
  readingStatus: readingStatusSchema.optional(),
  paperType: PaperTypeSchema.optional(),
  yearFrom: z.coerce.number().int().min(1000).max(9999).optional(),
  yearTo: z.coerce.number().int().min(1000).max(9999).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  hasPdf: z.enum(["true", "false"]).optional(),
  hasTranslation: z.enum(["true", "false"]).optional(),
  hasNotes: z.enum(["true", "false"]).optional(),
  createdFrom: z.string().datetime({ offset: true }).optional(),
  createdTo: z.string().datetime({ offset: true }).optional(),
  deleted: z.enum(["exclude", "only", "include"]).default("exclude"),
  recent: z.enum(["true", "false"]).optional(),
  sort: z.string().max(100).default("updated_at:desc"),
  cursor: z.string().max(2_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface NormalizedIdentifier {
  id: string;
  type: z.infer<typeof IdentifierTypeSchema>;
  normalized: string;
  original: string;
  version: string | null;
}

function normalizeIdentifier(input: z.infer<typeof identifierInputSchema>): NormalizedIdentifier {
  let normalized: string | null;
  let version: string | null = null;
  switch (input.identifierType) {
    case "doi":
      normalized = normalizeDoi(input.value);
      break;
    case "arxiv": {
      const parsed = parseArxivId(input.value);
      normalized = normalizeArxivId(input.value);
      version = parsed?.version == null ? null : `v${parsed.version}`;
      break;
    }
    case "url":
      normalized = normalizeUrl(input.value);
      break;
    default:
      normalized = input.value.normalize("NFKC").trim().toLowerCase();
  }
  if (!normalized) {
    throw new ApiError(
      422,
      "INVALID_IDENTIFIER",
      `The ${input.identifierType} identifier is invalid.`,
      {
        identifierType: input.identifierType,
      },
    );
  }
  return {
    id: createId("pid"),
    type: input.identifierType,
    normalized,
    original: input.value,
    version,
  };
}

function parseIfMatch(value: string | undefined): number {
  if (!value) throw new ApiError(428, "IF_MATCH_REQUIRED", "If-Match is required for this update.");
  const normalized = value.replace(/^W\//u, "").replaceAll('"', "");
  const version = Number(normalized);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(400, "IF_MATCH_INVALID", "If-Match must contain a positive version number.");
  }
  return version;
}

async function findPaper(db: D1Database, userId: string, paperId: string): Promise<SqlRow | null> {
  return first<SqlRow>(
    db,
    `SELECT p.*, ${PAPER_AGGREGATES_SQL} FROM papers p WHERE p.id = ? AND p.user_id = ?`,
    paperId,
    userId,
  );
}

async function requirePaper(db: D1Database, userId: string, paperId: string): Promise<SqlRow> {
  const paper = await findPaper(db, userId, paperId);
  if (!paper) throw new ApiError(404, "PAPER_NOT_FOUND", "Paper was not found.");
  return paper;
}

async function ensureOwnedIds(
  db: D1Database,
  table: "tags" | "collections",
  userId: string,
  ids: readonly string[],
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const placeholders = unique.map(() => "?").join(",");
  const row = await first<{ count: number } & Record<string, unknown>>(
    db,
    `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ? AND id IN (${placeholders}) AND ${
      table === "collections" ? "deleted_at IS NULL" : "1=1"
    }`,
    userId,
    ...unique,
  );
  if (Number(row?.count ?? 0) !== unique.length) {
    throw new ApiError(422, "RELATED_ENTITY_NOT_FOUND", `One or more ${table} do not exist.`);
  }
}

async function ensureIdentifiersAvailable(
  db: D1Database,
  userId: string,
  paperId: string | null,
  identifiers: readonly NormalizedIdentifier[],
): Promise<void> {
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    const key = `${identifier.type}:${identifier.normalized}`;
    if (seen.has(key))
      throw new ApiError(422, "DUPLICATE_IDENTIFIER_INPUT", "An identifier was repeated.");
    seen.add(key);
    const existing = await first<{
      paper_id: string;
      deleted_at: string | null;
      version: number;
    } & Record<string, unknown>>(
      db,
      `SELECT pi.paper_id,p.deleted_at,p.version
       FROM paper_identifiers pi
       JOIN papers p ON p.id=pi.paper_id AND p.user_id=pi.user_id
       WHERE pi.user_id = ? AND pi.identifier_type = ? AND pi.normalized_value = ?
         AND pi.deleted_at IS NULL AND p.deleted_at IS NULL`,
      userId,
      identifier.type,
      identifier.normalized,
    );
    if (existing && existing.paper_id !== paperId) {
      throw new ApiError(
        409,
        "DUPLICATE_IDENTIFIER",
        "This identifier is already in the library.",
        {
          paperId: existing.paper_id,
          identifierType: identifier.type,
          normalizedValue: identifier.normalized,
          deletedAt: existing.deleted_at,
          version: existing.version,
        },
      );
    }
  }
}

async function authorStatements(
  db: D1Database,
  userId: string,
  paperId: string,
  authors: readonly z.infer<typeof authorInputSchema>[],
  now: string,
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [];
  for (const [position, author] of authors.entries()) {
    const normalizedName = normalizeComparableText(author.displayName);
    let saved = await first<{ id: string } & Record<string, unknown>>(
      db,
      `SELECT id FROM authors WHERE user_id = ? AND normalized_name = ?
       AND COALESCE(orcid, '') = COALESCE(?, '') LIMIT 1`,
      userId,
      normalizedName,
      author.orcid ?? null,
    );
    if (!saved) {
      saved = { id: createId("aut") };
      statements.push(
        db
          .prepare(
            `INSERT INTO authors
              (id, user_id, normalized_name, display_name, orcid, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            saved.id,
            userId,
            normalizedName,
            author.displayName,
            author.orcid ?? null,
            now,
            now,
          ),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO paper_authors (user_id, paper_id, author_id, position, role)
           VALUES (?, ?, ?, ?, 'author')`,
        )
        .bind(userId, paperId, saved.id, position),
    );
  }
  return statements;
}

const fieldColumns: Record<string, string> = {
  title: "title",
  abstract: "abstract",
  publicationYear: "publication_year",
  publicationDate: "publication_date",
  venue: "venue",
  volume: "volume",
  issue: "issue",
  pages: "pages",
  publisher: "publisher",
  language: "language",
  paperType: "paper_type",
  status: "status",
  priority: "priority",
  rating: "rating",
  readProgress: "read_progress",
  sourceUrl: "source_url",
  metadataState: "metadata_state",
  noteMarkdown: "note_markdown",
};

const sortFields: Record<string, { expression: string; key: string }> = {
  added_at: { expression: "p.created_at", key: "created_at" },
  created_at: { expression: "p.created_at", key: "created_at" },
  updated_at: { expression: "p.updated_at", key: "updated_at" },
  publication_date: { expression: "COALESCE(p.publication_date, '')", key: "publication_date" },
  title: { expression: "lower(p.title)", key: "title" },
  first_author: {
    expression:
      "COALESCE((SELECT lower(a.display_name) FROM paper_authors pa JOIN authors a ON a.id=pa.author_id AND a.user_id=pa.user_id WHERE pa.user_id=p.user_id AND pa.paper_id=p.id ORDER BY pa.position LIMIT 1), '')",
    key: "first_author",
  },
  rating: { expression: "COALESCE(p.rating, -1)", key: "rating" },
  last_opened_at: { expression: "COALESCE(p.last_opened_at, '')", key: "last_opened_at" },
};

export const papersRoutes = new Hono<AppBindings>();

papersRoutes.get("/:paperId/bibtex", async (c) => {
  const paper = paperFromRow(await requirePaper(c.env.DB, c.get("user").id, c.req.param("paperId")));
  const identifiers = paper.identifiers as Array<{ identifierType?: string; normalizedValue?: string }>;
  const authors = paper.authors as Array<{ displayName: string; orcid?: string | null }>;
  const exportPaper: ExportPaper = {
    id: String(paper.id),
    title: String(paper.title),
    authors: authors.map((author) => ({ displayName: author.displayName, orcid: author.orcid ?? null })),
    publicationYear: paper.publicationYear as number | null,
    publicationDate: paper.publicationDate as string | null,
    venue: paper.venue as string | null,
    volume: paper.volume as string | null,
    issue: paper.issue as string | null,
    pages: paper.pages as string | null,
    publisher: paper.publisher as string | null,
    paperType: paper.paperType as string,
    doi: identifiers.find((identifier) => identifier.identifierType === "doi")?.normalizedValue ?? null,
    sourceUrl: paper.sourceUrl as string | null,
    abstract: paper.abstract as string | null,
    tags: (paper.tags as Array<{ name: string }>).map((tag) => tag.name),
  };
  return c.text(exportBibTeX([exportPaper]), 200, {
    "Content-Type": "application/x-bibtex; charset=utf-8",
    "Content-Disposition": `inline; filename="citera-${String(paper.id)}.bib"`,
  });
});

function paperMaintenanceJobs(input: {
  userId: string;
  paperId: string;
  sourceVersion: number;
  enrich: boolean;
}): JobMessage[] {
  const common = {
    userId: input.userId,
    paperId: input.paperId,
    sourceVersion: input.sourceVersion,
    attempt: 1,
  };
  return [
    ...(input.enrich ? [{ ...common, jobId: createId("job"), type: "paper.enrich" as const }] : []),
    { ...common, jobId: createId("job"), type: "search.reindex" as const },
  ];
}

papersRoutes.get("/", async (c) => {
  const input = listPapersSchema.parse(c.req.query());
  const userId = c.get("user").id;
  const [requestedSort, requestedDirection] = input.sort.split(":");
  const sort = sortFields[requestedSort ?? "updated_at"] ?? sortFields.updated_at;
  if (!sort) throw new ApiError(400, "SORT_INVALID", "The requested sort is not supported.");
  const direction =
    requestedDirection === "asc" ? "ASC" : requestedDirection === "desc" ? "DESC" : null;
  if (!direction) throw new ApiError(400, "SORT_INVALID", "Sort direction must be asc or desc.");

  const where: string[] = ["p.user_id = ?"];
  const bindings: unknown[] = [userId];
  if (input.deleted === "exclude") where.push("p.deleted_at IS NULL");
  if (input.deleted === "only") where.push("p.deleted_at IS NOT NULL");
  if (input.status) {
    where.push("p.status = ?");
    bindings.push(input.status);
  }
  if (input.readingStatus) {
    where.push("p.reading_status = ?");
    bindings.push(input.readingStatus);
  }
  if (input.paperType) {
    where.push("p.paper_type = ?");
    bindings.push(input.paperType);
  }
  if (input.yearFrom !== undefined) {
    where.push("p.publication_year >= ?");
    bindings.push(input.yearFrom);
  }
  if (input.yearTo !== undefined) {
    where.push("p.publication_year <= ?");
    bindings.push(input.yearTo);
  }
  if (input.rating !== undefined) {
    where.push("p.rating = ?");
    bindings.push(input.rating);
  }
  if (input.venue) {
    where.push("lower(COALESCE(p.venue, '')) LIKE ? ESCAPE '\\'");
    bindings.push(`%${input.venue.toLowerCase().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }
  if (input.author) {
    where.push(
      "EXISTS(SELECT 1 FROM paper_authors pa JOIN authors a ON a.id=pa.author_id AND a.user_id=pa.user_id WHERE pa.user_id=p.user_id AND pa.paper_id=p.id AND lower(a.display_name) LIKE ?)",
    );
    bindings.push(`%${input.author.toLowerCase()}%`);
  }
  if (input.collection) {
    where.push(
      "EXISTS(SELECT 1 FROM collection_papers cp JOIN collections c ON c.id=cp.collection_id AND c.user_id=cp.user_id WHERE cp.user_id=p.user_id AND cp.paper_id=p.id AND c.deleted_at IS NULL AND (c.id=? OR lower(c.name)=lower(?)))",
    );
    bindings.push(input.collection, input.collection);
  }
  if (input.tags) {
    for (const tag of input.tags
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      where.push(
        "EXISTS(SELECT 1 FROM paper_tags pt JOIN tags t ON t.id=pt.tag_id AND t.user_id=pt.user_id WHERE pt.user_id=p.user_id AND pt.paper_id=p.id AND (t.id=? OR t.normalized_name=?))",
      );
      bindings.push(tag, normalizeComparableText(tag));
    }
  }
  if (input.hasPdf !== undefined) {
    where.push(
      `${input.hasPdf === "true" ? "" : "NOT "}EXISTS(SELECT 1 FROM files f WHERE f.user_id=p.user_id AND f.paper_id=p.id AND f.upload_state='verified' AND f.deleted_at IS NULL)`,
    );
  }
  if (input.hasTranslation !== undefined) {
    where.push(
      `${input.hasTranslation === "true" ? "" : "NOT "}EXISTS(SELECT 1 FROM files f WHERE f.user_id=p.user_id AND f.paper_id=p.id AND f.file_kind='translation' AND f.upload_state='verified' AND f.deleted_at IS NULL)`,
    );
  }
  if (input.hasNotes !== undefined) {
    where.push(
      `${input.hasNotes === "true" ? "" : "NOT "}EXISTS(SELECT 1 FROM notes n WHERE n.user_id=p.user_id AND n.paper_id=p.id AND n.deleted_at IS NULL)`,
    );
  }
  if (input.createdFrom) {
    where.push("p.created_at >= ?");
    bindings.push(input.createdFrom);
  }
  if (input.createdTo) {
    where.push("p.created_at <= ?");
    bindings.push(input.createdTo);
  }
  if (input.recent === "true") {
    where.push("p.created_at >= datetime('now', '-30 days')");
  }
  if (input.q) {
    const query = `%${normalizeComparableText(input.q)}%`;
    where.push(`(
      p.search_text LIKE ? OR lower(p.title) LIKE ? OR lower(COALESCE(p.abstract,'')) LIKE ?
      OR lower(COALESCE(p.venue,'')) LIKE ?
      OR EXISTS(SELECT 1 FROM paper_identifiers pi WHERE pi.user_id=p.user_id AND pi.paper_id=p.id AND pi.deleted_at IS NULL AND pi.normalized_value LIKE ?)
      OR EXISTS(SELECT 1 FROM paper_authors pa JOIN authors a ON a.id=pa.author_id AND a.user_id=pa.user_id WHERE pa.user_id=p.user_id AND pa.paper_id=p.id AND a.normalized_name LIKE ?)
      OR EXISTS(SELECT 1 FROM paper_tags pt JOIN tags t ON t.id=pt.tag_id AND t.user_id=pt.user_id WHERE pt.user_id=p.user_id AND pt.paper_id=p.id AND t.normalized_name LIKE ?)
      OR EXISTS(SELECT 1 FROM notes n WHERE n.user_id=p.user_id AND n.paper_id=p.id AND n.deleted_at IS NULL AND lower(n.content_markdown) LIKE ?)
      OR lower(COALESCE(p.note_markdown,'')) LIKE ?
    )`);
    bindings.push(query, query, query, query, query, query, query, query, query);
  }
  if (input.cursor) {
    const cursor = decodeCursor<{
      sort?: unknown;
      direction?: unknown;
      value?: unknown;
      id?: unknown;
    }>(input.cursor);
    if (
      cursor.sort !== sort.key ||
      cursor.direction !== direction ||
      typeof cursor.id !== "string"
    ) {
      throw new ApiError(400, "INVALID_CURSOR", "The cursor does not match the requested sort.");
    }
    const comparator = direction === "ASC" ? ">" : "<";
    where.push(
      `(${sort.expression} ${comparator} ? OR (${sort.expression} = ? AND p.id ${comparator} ?))`,
    );
    bindings.push(cursor.value ?? "", cursor.value ?? "", cursor.id);
  }

  const rows = await all<SqlRow>(
    c.env.DB,
    `SELECT p.*, ${sort.expression} AS cursor_sort, ${PAPER_AGGREGATES_SQL}
     FROM papers p WHERE ${where.join(" AND ")}
     ORDER BY ${sort.expression} ${direction}, p.id ${direction} LIMIT ?`,
    ...bindings,
    input.limit + 1,
  );
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({ sort: sort.key, direction, value: last.cursor_sort ?? "", id: last.id })
      : null;
  return c.json({ items: page.map(paperFromRow), nextCursor, hasMore });
});

papersRoutes.post("/", async (c) => {
  const rawInput: unknown = await c.req.json();
  const userId = c.get("user").id;
  const rawRecord = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? (rawInput as Record<string, unknown>)
    : {};
  const rawIdentifiers: unknown[] = Array.isArray(rawRecord.identifiers) ? rawRecord.identifiers : [];
  const identifierDoi = rawIdentifiers.find(
    (identifier) => identifier && typeof identifier === "object" && (identifier as Record<string, unknown>).identifierType === "doi",
  );
  let suppliedDoi: string | null = null;
  if (typeof rawRecord.doi === "string") suppliedDoi = rawRecord.doi;
  else if (identifierDoi && typeof identifierDoi === "object") {
    const candidate = (identifierDoi as Record<string, unknown>).value;
    if (typeof candidate === "string") suppliedDoi = candidate;
  }
  let normalizedRaw = rawRecord;
  if (typeof rawRecord.title !== "string" || !rawRecord.title.trim()) {
    if (!suppliedDoi) throw new ApiError(422, "TITLE_REQUIRED", "A title or DOI is required.");
    const metadata = await resolveDoiMetadata(c.env, suppliedDoi);
    normalizedRaw = {
      ...rawRecord,
      title: metadata.title,
      identifiers: rawIdentifiers.length ? rawIdentifiers : [{ identifierType: "doi", value: metadata.doi }],
      authors: Array.isArray(rawRecord.authors) && rawRecord.authors.length > 0
        ? rawRecord.authors
        : metadata.authors,
      publicationDate: typeof rawRecord.publicationDate === "string" && rawRecord.publicationDate
        ? rawRecord.publicationDate
        : metadata.publicationDate,
      publicationYear: typeof rawRecord.publicationYear === "number"
        ? rawRecord.publicationYear
        : metadata.publicationYear,
      venue: typeof rawRecord.venue === "string" && rawRecord.venue.trim()
        ? rawRecord.venue
        : metadata.venue,
      volume: typeof rawRecord.volume === "string" && rawRecord.volume.trim()
        ? rawRecord.volume
        : metadata.volume,
      issue: typeof rawRecord.issue === "string" && rawRecord.issue.trim()
        ? rawRecord.issue
        : metadata.issue,
      pages: typeof rawRecord.pages === "string" && rawRecord.pages.trim()
        ? rawRecord.pages
        : metadata.pages,
      publisher: typeof rawRecord.publisher === "string" && rawRecord.publisher.trim()
        ? rawRecord.publisher
        : metadata.publisher,
      language: typeof rawRecord.language === "string" && rawRecord.language.trim()
        ? rawRecord.language
        : metadata.language,
      paperType: rawRecord.paperType ?? metadata.paperType,
      sourceUrl: typeof rawRecord.sourceUrl === "string" && rawRecord.sourceUrl.trim()
        ? rawRecord.sourceUrl
        : metadata.url,
    };
  }
  const parsedInput = createPaperSchema.parse(normalizedRaw);
  const suppliedFields =
    normalizedRaw && typeof normalizedRaw === "object" && !Array.isArray(normalizedRaw)
      ? normalizedRaw
      : {};
  const preferences = await readUserPreferences(c.env.DB, userId);
  const requestedReadingStatus = parsedInput.readingStatus;
  const input = {
    ...parsedInput,
    status: Object.hasOwn(suppliedFields, "status")
      ? parsedInput.status
      : requestedReadingStatus
        ? legacyStatusFromReading(requestedReadingStatus)
        : preferences.defaultStatus,
    readingStatus: Object.hasOwn(suppliedFields, "readingStatus")
      ? requestedReadingStatus ?? readingStatusFromLegacy(parsedInput.status)
      : readingStatusFromLegacy(
          Object.hasOwn(suppliedFields, "status") ? parsedInput.status : preferences.defaultStatus,
        ),
    tagIds: Object.hasOwn(suppliedFields, "tagIds")
      ? parsedInput.tagIds
      : preferences.defaultTagIds,
    collectionIds: Object.hasOwn(suppliedFields, "collectionIds")
      ? parsedInput.collectionIds
      : preferences.defaultCollectionId
        ? [preferences.defaultCollectionId]
        : [],
  };
  if (input.clientMutationId) {
    const duplicate = await first<{ result_json: string } & Record<string, unknown>>(
      c.env.DB,
      "SELECT result_json FROM client_mutations WHERE user_id = ? AND client_mutation_id = ?",
      userId,
      input.clientMutationId,
    );
    if (duplicate) {
      const saved = JSON.parse(duplicate.result_json) as { id?: unknown };
      if (typeof saved.id === "string") {
        const paper = await requirePaper(c.env.DB, userId, saved.id);
        const jobs = paperMaintenanceJobs({
          userId,
          paperId: saved.id,
          sourceVersion: Number(paper.version),
          enrich: paper.metadata_state === "pending",
        });
        await c.env.DB.batch(jobs.map((job) => jobOutboxStatement(c.env.DB, job)));
        c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, jobs));
        return c.json(paperFromRow(paper), 200, { ETag: `"${String(paper.version)}"` });
      }
      return c.json(saved as Record<string, unknown>, 200);
    }
  }
  const identifiers = input.identifiers.map(normalizeIdentifier);
  await ensureIdentifiersAvailable(c.env.DB, userId, null, identifiers);
  await ensureOwnedIds(c.env.DB, "tags", userId, input.tagIds);
  await ensureOwnedIds(c.env.DB, "collections", userId, input.collectionIds);

  const id = createId("pap");
  const now = nowUtcIso();
  const searchText = normalizeComparableText(
    [input.title, input.abstract, input.venue, ...input.authors.map((author) => author.displayName)]
      .filter(Boolean)
      .join(" "),
  );
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO papers (
        id,user_id,library_id,title,abstract,publication_year,publication_date,venue,volume,issue,pages,publisher,
        language,paper_type,status,reading_status,priority,rating,read_progress,source_url,metadata_state,search_text,
        note_markdown,version,last_opened_at,created_at,updated_at,deleted_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?,NULL)`,
    ).bind(
      id,
      userId,
      c.get("libraryId"),
      input.title,
      input.abstract ?? null,
      input.publicationYear ?? null,
      input.publicationDate ?? null,
      input.venue ?? null,
      input.volume ?? null,
      input.issue ?? null,
      input.pages ?? null,
      input.publisher ?? null,
      input.language ?? null,
      input.paperType,
      input.status,
      input.readingStatus,
      input.priority,
      input.rating ?? null,
      input.readProgress,
      input.sourceUrl ?? null,
      input.metadataState,
      searchText,
      input.noteMarkdown ?? null,
      now,
      now,
    ),
  ];
  const providedFields = new Set(Object.keys(suppliedFields));
  const userMetadata: Array<[string, string, unknown]> = [
    ["title", "title", input.title],
    ["abstract", "abstract", input.abstract],
    ["publicationYear", "publicationYear", input.publicationYear],
    ["publicationDate", "publicationDate", input.publicationDate],
    ["venue", "venue", input.venue],
    ["volume", "volume", input.volume],
    ["issue", "issue", input.issue],
    ["pages", "pages", input.pages],
    ["publisher", "publisher", input.publisher],
    ["language", "language", input.language],
    ["paperType", "paperType", input.paperType],
    ["sourceUrl", "url", input.sourceUrl],
  ];
  for (const [inputField, metadataField, value] of userMetadata) {
    if (inputField !== "title" && !providedFields.has(inputField)) continue;
    if (value == null || (typeof value === "string" && value.trim() === "")) continue;
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO metadata_values
          (id,user_id,paper_id,field_name,value_json,source_type,source_reference,confidence,selected,created_at,updated_at)
         VALUES (?,?,?,?,?,'user',NULL,1,1,?,?)`,
      ).bind(createId("mdv"), userId, id, metadataField, JSON.stringify(value), now, now),
    );
  }
  for (const identifier of identifiers) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO paper_identifiers
          (id,user_id,paper_id,identifier_type,normalized_value,original_value,identifier_version,created_at,deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(
        identifier.id,
        userId,
        id,
        identifier.type,
        identifier.normalized,
        identifier.original,
        identifier.version,
        now,
        null,
      ),
    );
  }
  statements.push(...(await authorStatements(c.env.DB, userId, id, input.authors, now)));
  for (const tagId of new Set(input.tagIds)) {
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO paper_tags (user_id,paper_id,tag_id,library_id,created_at) VALUES (?,?,?,?,?)",
      ).bind(userId, id, tagId, c.get("libraryId"), now),
    );
  }
  for (const collectionId of new Set(input.collectionIds)) {
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO collection_papers (user_id,collection_id,paper_id,created_at) VALUES (?,?,?,?)",
      ).bind(userId, collectionId, id, now),
    );
  }
  const snapshot = { ...input, id, version: 1, createdAt: now, updatedAt: now };
  statements.push(
    changeStatement(c.env.DB, {
      userId,
      entityType: "paper",
      entityId: id,
      operation: "create",
      version: 1,
      data: snapshot,
      changedAt: now,
    }),
  );
  if (input.clientMutationId) {
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO client_mutations (user_id,client_mutation_id,result_json,created_at) VALUES (?,?,?,?)",
      ).bind(userId, input.clientMutationId, JSON.stringify(snapshot), now),
    );
  }
  const jobs = paperMaintenanceJobs({ userId, paperId: id, sourceVersion: 1, enrich: true });
  statements.push(...jobs.map((job) => jobOutboxStatement(c.env.DB, job, now)));
  await c.env.DB.batch(statements);
  const created = await requirePaper(c.env.DB, userId, id);
  c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, jobs));
  return c.json(paperFromRow(created), 201, { ETag: `"1"` });
});

papersRoutes.get("/:paperId", async (c) => {
  const userId = c.get("user").id;
  const paper = await requirePaper(c.env.DB, userId, c.req.param("paperId"));
  const notes = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT id,paper_id,parent_note_id,note_type,page_number,anchor_json,content_markdown,
            version,created_at,updated_at,deleted_at
     FROM notes WHERE user_id=? AND paper_id=? AND deleted_at IS NULL ORDER BY page_number,updated_at DESC`,
    userId,
    paper.id,
  );
  return c.json(
    {
      ...paperFromRow(paper),
      notes: notes.map((note) => ({
        id: note.id,
        paperId: note.paper_id,
        parentNoteId: note.parent_note_id ?? null,
        noteType: note.note_type,
        pageNumber: note.page_number ?? null,
        anchor: parseJson(note.anchor_json, null),
        contentMarkdown: note.content_markdown,
        version: note.version,
        createdAt: note.created_at,
        updatedAt: note.updated_at,
        deletedAt: note.deleted_at ?? null,
      })),
    },
    200,
    { ETag: `"${String(paper.version)}"` },
  );
});

papersRoutes.patch("/:paperId", async (c) => {
  const input = patchPaperSchema.parse(await c.req.json());
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId");
  const expectedVersion = parseIfMatch(c.req.header("If-Match"));
  const existing = await requirePaper(c.env.DB, userId, paperId);
  if (Number(existing.version) !== expectedVersion) {
    throw new ApiError(409, "VERSION_CONFLICT", "The paper was changed by another client.", {
      expectedVersion,
      currentVersion: existing.version,
      current: paperFromRow(existing),
    });
  }
  const identifiers = input.identifiers?.map(normalizeIdentifier);
  if (identifiers) await ensureIdentifiersAvailable(c.env.DB, userId, paperId, identifiers);
  const now = nowUtcIso();
  const assignments: string[] = [];
  const values: unknown[] = [];
  if ("readingStatus" in input || "status" in input) {
    const nextReadingStatus = input.readingStatus ?? readingStatusFromLegacy(input.status ?? "inbox");
    const nextLegacyStatus = input.status ?? legacyStatusFromReading(nextReadingStatus);
    assignments.push("status = ?", "reading_status = ?");
    values.push(nextLegacyStatus, nextReadingStatus);
  }
  for (const [field, column] of Object.entries(fieldColumns)) {
    if (field in input && field !== "status") {
      assignments.push(`${column} = ?`);
      values.push(input[field as keyof typeof input] ?? null);
    }
  }
  if (
    "title" in input ||
    "abstract" in input ||
    "venue" in input ||
    "authors" in input ||
    "noteMarkdown" in input
  ) {
    const existingAuthors = (paperFromRow(existing).authors as Array<{ displayName?: string }>).map(
      (author) => author.displayName ?? "",
    );
    assignments.push("search_text = ?");
    values.push(
      normalizeComparableText(
        [
          input.title ?? existing.title,
          input.abstract ?? existing.abstract,
          input.venue ?? existing.venue,
          input.noteMarkdown ?? existing.note_markdown,
          ...(input.authors?.map((author) => author.displayName) ?? existingAuthors),
        ]
          .filter(Boolean)
          .join(" "),
      ),
    );
  }
  const nextVersion = expectedVersion + 1;
  assignments.push("version = ?", "updated_at = ?");
  values.push(nextVersion, now);
  const update = await c.env.DB.prepare(
    `UPDATE papers SET ${assignments.join(", ")} WHERE id = ? AND user_id = ? AND version = ?`,
  )
    .bind(...values, paperId, userId, expectedVersion)
    .run();
  if (update.meta.changes !== 1) {
    const current = await requirePaper(c.env.DB, userId, paperId);
    throw new ApiError(409, "VERSION_CONFLICT", "The paper was changed by another client.", {
      currentVersion: current.version,
      current: paperFromRow(current),
    });
  }

  const statements: D1PreparedStatement[] = [];
  if (identifiers) {
    statements.push(
      c.env.DB.prepare("DELETE FROM paper_identifiers WHERE user_id = ? AND paper_id = ?").bind(
        userId,
        paperId,
      ),
    );
    for (const identifier of identifiers) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO paper_identifiers
            (id,user_id,paper_id,identifier_type,normalized_value,original_value,identifier_version,created_at,deleted_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).bind(
          identifier.id,
          userId,
          paperId,
          identifier.type,
          identifier.normalized,
          identifier.original,
          identifier.version,
          now,
          existing.deleted_at ?? null,
        ),
      );
    }
  }
  if (input.authors) {
    statements.push(
      c.env.DB.prepare("DELETE FROM paper_authors WHERE user_id = ? AND paper_id = ?").bind(
        userId,
        paperId,
      ),
    );
    statements.push(...(await authorStatements(c.env.DB, userId, paperId, input.authors, now)));
  }
  for (const [field, value] of Object.entries(input)) {
    if (fieldColumns[field] && field !== "metadataState" && field !== "noteMarkdown") {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO metadata_values
            (id,user_id,paper_id,field_name,value_json,source_type,source_reference,confidence,selected,created_at,updated_at)
           VALUES (?,?,?,?,?,'user',NULL,1,1,?,?)`,
        ).bind(createId("mdv"), userId, paperId, field, JSON.stringify(value), now, now),
      );
    }
  }
  if ("noteMarkdown" in input) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO metadata_values
          (id,user_id,paper_id,field_name,value_json,source_type,source_reference,confidence,selected,created_at,updated_at)
         VALUES (?,?,?,?,?,'user',NULL,1,1,?,?)`,
      ).bind(createId("mdv"), userId, paperId, "noteMarkdown", JSON.stringify(input.noteMarkdown), now, now),
    );
  }
  const updatedSnapshot = {
    ...paperFromRow(existing),
    ...input,
    version: nextVersion,
    updatedAt: now,
  };
  statements.push(
    changeStatement(c.env.DB, {
      userId,
      entityType: "paper",
      entityId: paperId,
      operation: "update",
      version: nextVersion,
      data: updatedSnapshot,
      changedAt: now,
    }),
  );
  if (statements.length > 0) await c.env.DB.batch(statements);
  const updated = await requirePaper(c.env.DB, userId, paperId);
  return c.json(paperFromRow(updated), 200, { ETag: `"${nextVersion}"` });
});

papersRoutes.delete("/:paperId", async (c) => {
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId");
  const expectedVersion = parseIfMatch(c.req.header("If-Match"));
  const existing = await requirePaper(c.env.DB, userId, paperId);
  if (Number(existing.version) !== expectedVersion) {
    throw new ApiError(409, "VERSION_CONFLICT", "The paper was changed by another client.", {
      currentVersion: existing.version,
    });
  }
  if (existing.deleted_at) return c.body(null, 204);
  const now = nowUtcIso();
  const nextVersion = expectedVersion + 1;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE papers SET deleted_at=?,updated_at=?,version=? WHERE id=? AND user_id=? AND version=? AND deleted_at IS NULL",
    ).bind(now, now, nextVersion, paperId, userId, expectedVersion),
    c.env.DB.prepare(
      "UPDATE paper_identifiers SET deleted_at=? WHERE user_id=? AND paper_id=?",
    ).bind(now, userId, paperId),
  ]);
  const paperResult = results[0];
  if (!paperResult || paperResult.meta.changes !== 1)
    throw new ApiError(409, "VERSION_CONFLICT", "The paper was changed by another client.");
  await changeStatement(c.env.DB, {
    userId,
    entityType: "paper",
    entityId: paperId,
    operation: "delete",
    version: nextVersion,
    data: { id: paperId, deletedAt: now, version: nextVersion },
    changedAt: now,
  }).run();
  return c.body(null, 204);
});

papersRoutes.post("/:paperId/restore", async (c) => {
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId");
  const expectedVersion = parseIfMatch(c.req.header("If-Match"));
  const existing = await requirePaper(c.env.DB, userId, paperId);
  if (Number(existing.version) !== expectedVersion) {
    throw new ApiError(409, "VERSION_CONFLICT", "The paper was changed by another client.");
  }
  if (!existing.deleted_at)
    return c.json(paperFromRow(existing), 200, { ETag: `"${expectedVersion}"` });
  const conflictingIdentifier = await first<{
    paper_id: string;
    identifier_type: string;
    normalized_value: string;
    version: number;
  } & Record<string, unknown>>(
    c.env.DB,
    `SELECT active.paper_id,active.identifier_type,active.normalized_value,activePaper.version
     FROM paper_identifiers trashed
     JOIN paper_identifiers active
       ON active.user_id=trashed.user_id
      AND active.identifier_type=trashed.identifier_type
      AND active.normalized_value=trashed.normalized_value
      AND active.paper_id<>trashed.paper_id
      AND active.deleted_at IS NULL
     JOIN papers activePaper
       ON activePaper.id=active.paper_id
      AND activePaper.user_id=active.user_id
      AND activePaper.deleted_at IS NULL
     WHERE trashed.user_id=? AND trashed.paper_id=?
     LIMIT 1`,
    userId,
    paperId,
  );
  if (conflictingIdentifier) {
    throw new ApiError(
      409,
      "DUPLICATE_IDENTIFIER",
      "This paper cannot be restored because an active paper already uses the same identifier.",
      {
        paperId: conflictingIdentifier.paper_id,
        identifierType: conflictingIdentifier.identifier_type,
        normalizedValue: conflictingIdentifier.normalized_value,
        version: conflictingIdentifier.version,
      },
    );
  }
  const now = nowUtcIso();
  const nextVersion = expectedVersion + 1;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE papers SET deleted_at=NULL,updated_at=?,version=? WHERE id=? AND user_id=? AND version=?",
    ).bind(now, nextVersion, paperId, userId, expectedVersion),
    c.env.DB.prepare(
      "UPDATE paper_identifiers SET deleted_at=NULL WHERE user_id=? AND paper_id=?",
    ).bind(userId, paperId),
  ]);
  const paperResult = results[0];
  if (!paperResult || paperResult.meta.changes !== 1)
    throw new ApiError(409, "VERSION_CONFLICT", "The paper was changed by another client.");
  const updated = await requirePaper(c.env.DB, userId, paperId);
  await changeStatement(c.env.DB, {
    userId,
    entityType: "paper",
    entityId: paperId,
    operation: "restore",
    version: nextVersion,
    data: paperFromRow(updated),
    changedAt: now,
  }).run();
  return c.json(paperFromRow(updated), 200, { ETag: `"${nextVersion}"` });
});

papersRoutes.post("/:paperId/refresh-metadata", async (c) => {
  const userId = c.get("user").id;
  const paper = await requirePaper(c.env.DB, userId, c.req.param("paperId"));
  if (paper.deleted_at)
    throw new ApiError(409, "PAPER_DELETED", "Deleted papers cannot be refreshed.");
  const now = nowUtcIso();
  const sourceVersion = Number(paper.version) + 1;
  const job: JobMessage = {
    jobId: createId("job"),
    type: "metadata.refresh",
    userId,
    paperId: String(paper.id),
    sourceVersion,
    attempt: 1,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE papers SET metadata_state='pending',updated_at=?,version=? WHERE id=? AND user_id=? AND version=?",
    ).bind(now, sourceVersion, paper.id, userId, paper.version),
    changeStatement(c.env.DB, {
      userId,
      entityType: "paper",
      entityId: String(paper.id),
      operation: "update",
      version: sourceVersion,
      data: { id: paper.id, metadataState: "pending", version: sourceVersion, updatedAt: now },
      changedAt: now,
    }),
    jobOutboxStatement(c.env.DB, job, now),
  ]);
  c.executionCtx.waitUntil(dispatchOutboxJobs(c.env, [job]));
  return c.json({ jobId: job.jobId, state: "queued" }, 202);
});

papersRoutes.get("/:paperId/duplicate-candidates", async (c) => {
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId");
  const paper = await requirePaper(c.env.DB, userId, paperId);
  const rows = await all<SqlRow>(
    c.env.DB,
    `SELECT DISTINCT candidate.*, ${PAPER_AGGREGATES_SQL.replace(/\bp\./gu, "candidate.")}
     FROM papers candidate
     WHERE candidate.user_id=? AND candidate.id<>? AND candidate.deleted_at IS NULL AND (
       EXISTS(
         SELECT 1 FROM paper_identifiers mine
         JOIN paper_identifiers theirs
           ON theirs.user_id=mine.user_id AND theirs.identifier_type=mine.identifier_type
          AND theirs.normalized_value=mine.normalized_value
         WHERE mine.user_id=? AND mine.paper_id=? AND theirs.paper_id=candidate.id
           AND mine.deleted_at IS NULL AND theirs.deleted_at IS NULL
       )
       OR EXISTS(
         SELECT 1 FROM files mine JOIN files theirs
           ON theirs.user_id=mine.user_id AND theirs.sha256=mine.sha256 AND theirs.kind=mine.kind
         WHERE mine.user_id=? AND mine.paper_id=? AND theirs.paper_id=candidate.id
       )
       OR (lower(candidate.title)=lower(?) AND COALESCE(candidate.publication_year,0)=COALESCE(?,0))
     ) LIMIT 25`,
    userId,
    paperId,
    userId,
    paperId,
    userId,
    paperId,
    paper.title,
    paper.publication_year,
  );
  return c.json({
    candidates: rows.map((row) => ({
      paper: paperFromRow(row),
      reasons: row.title === paper.title ? ["title_year"] : ["identifier_or_file"],
    })),
  });
});
