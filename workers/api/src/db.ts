import { parseJson } from "./utils";

export type SqlRow = Record<string, unknown>;

export async function first<T extends SqlRow>(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): Promise<T | null> {
  return (
    (await db
      .prepare(sql)
      .bind(...bindings)
      .first<T>()) ?? null
  );
}

export async function all<T extends SqlRow>(
  db: D1Database,
  sql: string,
  ...bindings: unknown[]
): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .all<T>();
  return result.results;
}

export function changeStatement(
  db: D1Database,
  input: {
    userId: string;
    entityType: string;
    entityId: string;
    operation: "create" | "update" | "delete" | "restore";
    version: number;
    data: unknown;
    changedAt: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO changes
       (user_id, entity_type, entity_id, operation, version, data_json, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.userId,
      input.entityType,
      input.entityId,
      input.operation,
      input.version,
      JSON.stringify(input.data),
      input.changedAt,
    );
}

export function paperFromRow(row: SqlRow): Record<string, unknown> {
  const files = parseJson(row.files_json, []).map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) return file;
    const record = file as Record<string, unknown>;
    if (typeof record.label === "string" && record.label.trim()) return record;
    const kindLabels: Record<string, string> = {
      fulltext: "本文",
      translation: "翻訳版",
      bilingual: "対訳版",
      supplement: "補足資料",
      other: "その他",
    };
    const languageLabels: Record<string, string> = {
      ja: "日本語",
      en: "英語",
      de: "ドイツ語",
      fr: "フランス語",
      "zh-Hans": "中国語（簡体）",
      "zh-Hant": "中国語（繁体）",
    };
    const fileKind = typeof record.fileKind === "string" ? record.fileKind : "fulltext";
    const languageCode = typeof record.languageCode === "string" ? record.languageCode : null;
    return {
      ...record,
      label: `${kindLabels[fileKind] ?? "PDF"}${languageCode ? `（${languageLabels[languageCode] ?? languageCode}）` : ""}`,
    };
  });
  return {
    id: row.id,
    libraryId: row.library_id ?? null,
    title: row.title,
    abstract: row.abstract ?? null,
    summary: row.summary ?? null,
    publicationYear: row.publication_year ?? null,
    publicationDate: row.publication_date ?? null,
    venue: row.venue ?? null,
    volume: row.volume ?? null,
    issue: row.issue ?? null,
    pages: row.pages ?? null,
    publisher: row.publisher ?? null,
    language: row.language ?? null,
    paperType: row.paper_type,
    status: row.status,
    readingStatus:
      row.reading_status ??
      (row.status === "reading"
        ? "reading"
        : row.status === "read"
          ? "read"
          : row.status === "archived"
            ? "on_hold"
            : "unread"),
    priority: row.priority,
    rating: row.rating ?? null,
    readProgress: row.read_progress,
    sourceUrl: row.source_url ?? null,
    noteMarkdown: row.note_markdown ?? null,
    metadataState: row.metadata_state,
    version: row.version,
    lastOpenedAt: row.last_opened_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
    authors: parseJson(row.authors_json, []),
    identifiers: parseJson(row.identifiers_json, []),
    tags: parseJson(row.tags_json, []),
    collections: parseJson(row.collections_json, []),
    files,
    hasPdf: Boolean(row.has_pdf),
    hasNotes: Boolean(row.has_notes),
  };
}

export const PAPER_AGGREGATES_SQL = `
  COALESCE((
    SELECT json_group_array(json_object(
      'id', ordered_authors.id,
      'displayName', ordered_authors.display_name,
      'orcid', ordered_authors.orcid,
      'position', ordered_authors.position,
      'role', ordered_authors.role
    ))
    FROM (
      SELECT a.id, a.display_name, a.orcid, pa.position, pa.role
      FROM paper_authors pa
      JOIN authors a ON a.id = pa.author_id AND a.user_id = pa.user_id
      WHERE pa.user_id = p.user_id AND pa.paper_id = p.id
      ORDER BY pa.position ASC
    ) ordered_authors
  ), '[]') AS authors_json,
  COALESCE((
    SELECT json_group_array(json_object(
      'id', pi.id,
      'identifierType', pi.identifier_type,
      'normalizedValue', pi.normalized_value,
      'originalValue', pi.original_value,
      'version', pi.identifier_version
    ))
    FROM paper_identifiers pi
    WHERE pi.user_id = p.user_id AND pi.paper_id = p.id
  ), '[]') AS identifiers_json,
  COALESCE((
    SELECT json_group_array(json_object('id', t.id, 'name', t.name, 'color', t.color))
    FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id AND t.user_id = pt.user_id
    WHERE pt.user_id = p.user_id AND pt.paper_id = p.id
  ), '[]') AS tags_json,
  COALESCE((
    SELECT json_group_array(json_object('id', c.id, 'name', c.name))
    FROM collection_papers cp JOIN collections c ON c.id = cp.collection_id AND c.user_id = cp.user_id
    WHERE cp.user_id = p.user_id AND cp.paper_id = p.id AND c.deleted_at IS NULL
  ), '[]') AS collections_json,
  COALESCE((
    SELECT json_group_array(json_object(
      'id', f.id, 'kind', f.kind, 'fileKind', COALESCE(f.file_kind, 'fulltext'),
      'label', f.label, 'languageCode', f.language_code, 'isDefault', f.is_default,
      'sortOrder', f.sort_order, 'mediaType', f.media_type, 'sizeBytes', f.size_bytes,
      'originalName', f.original_name, 'uploadState', f.upload_state, 'sha256', f.sha256
    ))
    FROM files f
    WHERE f.user_id = p.user_id AND f.paper_id = p.id AND f.deleted_at IS NULL
  ), '[]') AS files_json,
  EXISTS(SELECT 1 FROM files f WHERE f.user_id = p.user_id AND f.paper_id = p.id AND f.upload_state = 'verified' AND f.deleted_at IS NULL) AS has_pdf,
  EXISTS(SELECT 1 FROM notes n WHERE n.user_id = p.user_id AND n.paper_id = p.id AND n.deleted_at IS NULL) AS has_notes`;
