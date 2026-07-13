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
  return {
    id: row.id,
    title: row.title,
    abstract: row.abstract ?? null,
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
    priority: row.priority,
    rating: row.rating ?? null,
    readProgress: row.read_progress,
    sourceUrl: row.source_url ?? null,
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
    files: parseJson(row.files_json, []),
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
      'id', f.id, 'kind', f.kind, 'mediaType', f.media_type, 'sizeBytes', f.size_bytes,
      'originalName', f.original_name, 'uploadState', f.upload_state, 'sha256', f.sha256
    ))
    FROM files f
    WHERE f.user_id = p.user_id AND f.paper_id = p.id AND f.deleted_at IS NULL
  ), '[]') AS files_json,
  EXISTS(SELECT 1 FROM files f WHERE f.user_id = p.user_id AND f.paper_id = p.id AND f.kind = 'original_pdf' AND f.upload_state = 'verified' AND f.deleted_at IS NULL) AS has_pdf,
  EXISTS(SELECT 1 FROM notes n WHERE n.user_id = p.user_id AND n.paper_id = p.id AND n.deleted_at IS NULL) AS has_notes`;
