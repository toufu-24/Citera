import { NoteAnchorSchema, NoteTypeSchema, normalizeTag } from "@citera/domain";
import { Hono } from "hono";
import { z } from "zod";
import { all, changeStatement, first } from "../db";
import { ApiError } from "../errors";
import type { AppBindings } from "../types";
import { createId, nowUtcIso, parseJson } from "../utils";

const colorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/iu)
  .nullable()
  .optional();
const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: colorSchema,
});
const collectionInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
});
const noteInputSchema = z
  .object({
    parentNoteId: z.string().min(1).nullable().optional(),
    noteType: NoteTypeSchema,
    pageNumber: z.number().int().positive().nullable().optional(),
    anchor: NoteAnchorSchema.nullable().optional(),
    contentMarkdown: z.string().max(1_000_000),
  })
  .superRefine((note, context) => {
    if ((note.noteType === "page" || note.noteType === "highlight") && note.pageNumber == null) {
      context.addIssue({
        code: "custom",
        path: ["pageNumber"],
        message: "A page number is required.",
      });
    }
    if (note.anchor && note.pageNumber && note.anchor.page !== note.pageNumber) {
      context.addIssue({
        code: "custom",
        path: ["anchor", "page"],
        message: "Anchor page must match pageNumber.",
      });
    }
  });

function parseIfMatch(value: string | undefined): number {
  if (!value) throw new ApiError(428, "IF_MATCH_REQUIRED", "If-Match is required for this update.");
  const parsed = Number(value.replace(/^W\//u, "").replaceAll('"', ""));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiError(400, "IF_MATCH_INVALID", "If-Match must contain a positive version number.");
  }
  return parsed;
}

async function requirePaper(db: D1Database, userId: string, paperId: string): Promise<void> {
  const row = await first<Record<string, unknown>>(
    db,
    "SELECT id FROM papers WHERE id=? AND user_id=? AND deleted_at IS NULL",
    paperId,
    userId,
  );
  if (!row) throw new ApiError(404, "PAPER_NOT_FOUND", "Paper was not found.");
}

async function nextEntityVersion(
  db: D1Database,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<number> {
  const row = await first<{ version: number } & Record<string, unknown>>(
    db,
    "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM changes WHERE user_id=? AND entity_type=? AND entity_id=?",
    userId,
    entityType,
    entityId,
  );
  return Number(row?.version ?? 1);
}

function tagResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    color: row.color ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function collectionResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    parentId: row.parent_id ?? null,
    paperCount: Number(row.paper_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

function noteResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    paperId: row.paper_id,
    parentNoteId: row.parent_note_id ?? null,
    noteType: row.note_type,
    pageNumber: row.page_number ?? null,
    anchor: parseJson(row.anchor_json, null),
    contentMarkdown: row.content_markdown,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

export const tagsRoutes = new Hono<AppBindings>();

tagsRoutes.get("/", async (c) => {
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT t.*, COUNT(pt.paper_id) AS paper_count
     FROM tags t LEFT JOIN paper_tags pt ON pt.tag_id=t.id AND pt.user_id=t.user_id
     WHERE t.user_id=? GROUP BY t.id ORDER BY lower(t.name)`,
    c.get("user").id,
  );
  return c.json({
    items: rows.map((row) => ({ ...tagResponse(row), paperCount: Number(row.paper_count) })),
  });
});

tagsRoutes.post("/", async (c) => {
  const input = tagInputSchema.parse(await c.req.json());
  const normalized = normalizeTag(input.name);
  if (!normalized) throw new ApiError(422, "TAG_NAME_INVALID", "Tag name is invalid.");
  const userId = c.get("user").id;
  const existing = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM tags WHERE user_id=? AND normalized_name=?",
    userId,
    normalized,
  );
  if (existing) return c.json(tagResponse(existing), 200);
  const id = createId("tag");
  const now = nowUtcIso();
  const snapshot = {
    id,
    name: input.name,
    normalizedName: normalized,
    color: input.color ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO tags (id,user_id,library_id,name,normalized_name,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(id, userId, c.get("libraryId"), input.name, normalized, input.color ?? null, now, now),
    changeStatement(c.env.DB, {
      userId,
      entityType: "tag",
      entityId: id,
      operation: "create",
      version: 1,
      data: snapshot,
      changedAt: now,
    }),
  ]);
  return c.json(snapshot, 201);
});

tagsRoutes.patch("/:tagId", async (c) => {
  const input = tagInputSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0)
    .parse(await c.req.json());
  const userId = c.get("user").id;
  const tagId = c.req.param("tagId");
  const existing = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM tags WHERE id=? AND user_id=?",
    tagId,
    userId,
  );
  if (!existing) throw new ApiError(404, "TAG_NOT_FOUND", "Tag was not found.");
  const normalized = input.name ? normalizeTag(input.name) : String(existing.normalized_name);
  if (!normalized) throw new ApiError(422, "TAG_NAME_INVALID", "Tag name is invalid.");
  const now = nowUtcIso();
  await c.env.DB.prepare(
    "UPDATE tags SET name=?,normalized_name=?,color=?,updated_at=? WHERE id=? AND user_id=?",
  )
    .bind(
      input.name ?? existing.name,
      normalized,
      input.color === undefined ? existing.color : input.color,
      now,
      tagId,
      userId,
    )
    .run();
  const updated = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM tags WHERE id=? AND user_id=?",
    tagId,
    userId,
  );
  const version = await nextEntityVersion(c.env.DB, userId, "tag", tagId);
  await changeStatement(c.env.DB, {
    userId,
    entityType: "tag",
    entityId: tagId,
    operation: "update",
    version,
    data: tagResponse(updated ?? existing),
    changedAt: now,
  }).run();
  return c.json(tagResponse(updated ?? existing));
});

tagsRoutes.delete("/:tagId", async (c) => {
  const userId = c.get("user").id;
  const tagId = c.req.param("tagId");
  const existing = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT id FROM tags WHERE id=? AND user_id=?",
    tagId,
    userId,
  );
  if (!existing) throw new ApiError(404, "TAG_NOT_FOUND", "Tag was not found.");
  const version = await nextEntityVersion(c.env.DB, userId, "tag", tagId);
  const now = nowUtcIso();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM tags WHERE id=? AND user_id=?").bind(tagId, userId),
    changeStatement(c.env.DB, {
      userId,
      entityType: "tag",
      entityId: tagId,
      operation: "delete",
      version,
      data: { id: tagId, deletedAt: now },
      changedAt: now,
    }),
  ]);
  return c.body(null, 204);
});

export const paperTagsRoutes = new Hono<AppBindings>();

paperTagsRoutes.put("/:paperId/tags/:tagId", async (c) => {
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId");
  const tagId = c.req.param("tagId");
  await requirePaper(c.env.DB, userId, paperId);
  const tag = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT id FROM tags WHERE id=? AND user_id=?",
    tagId,
    userId,
  );
  if (!tag) throw new ApiError(404, "TAG_NOT_FOUND", "Tag was not found.");
  const now = nowUtcIso();
  const result = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO paper_tags (user_id,paper_id,tag_id,library_id,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(userId, paperId, tagId, c.get("libraryId"), now)
    .run();
  if (result.meta.changes === 1) {
    await changeStatement(c.env.DB, {
      userId,
      entityType: "paper_tag",
      entityId: `${paperId}:${tagId}`,
      operation: "create",
      version: 1,
      data: { paperId, tagId, createdAt: now },
      changedAt: now,
    }).run();
  }
  return c.body(null, 204);
});

paperTagsRoutes.delete("/:paperId/tags/:tagId", async (c) => {
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId");
  const tagId = c.req.param("tagId");
  await requirePaper(c.env.DB, userId, paperId);
  const result = await c.env.DB.prepare(
    "DELETE FROM paper_tags WHERE user_id=? AND paper_id=? AND tag_id=?",
  )
    .bind(userId, paperId, tagId)
    .run();
  if (result.meta.changes === 1) {
    const now = nowUtcIso();
    await changeStatement(c.env.DB, {
      userId,
      entityType: "paper_tag",
      entityId: `${paperId}:${tagId}`,
      operation: "delete",
      version: 1,
      data: { paperId, tagId, deletedAt: now },
      changedAt: now,
    }).run();
  }
  return c.body(null, 204);
});

export const collectionsRoutes = new Hono<AppBindings>();

collectionsRoutes.get("/", async (c) => {
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    `WITH RECURSIVE collection_tree(root_id, collection_id, user_id) AS (
       SELECT c.id, c.id, c.user_id
       FROM collections c
       WHERE c.user_id=? AND c.deleted_at IS NULL
       UNION ALL
       SELECT tree.root_id, child.id, child.user_id
       FROM collection_tree tree
       JOIN collections child
         ON child.parent_id=tree.collection_id
        AND child.user_id=tree.user_id
        AND child.deleted_at IS NULL
     )
     SELECT c.*, COUNT(DISTINCT p.id) AS paper_count
     FROM collections c
     LEFT JOIN collection_tree tree ON tree.root_id=c.id
     LEFT JOIN collection_papers cp ON cp.collection_id=tree.collection_id AND cp.user_id=c.user_id
     LEFT JOIN papers p ON p.id=cp.paper_id AND p.user_id=c.user_id AND p.deleted_at IS NULL
     WHERE c.user_id=? AND c.deleted_at IS NULL GROUP BY c.id ORDER BY lower(c.name)`,
    c.get("user").id,
    c.get("user").id,
  );
  return c.json({ items: rows.map(collectionResponse) });
});

async function ensureParent(
  db: D1Database,
  userId: string,
  parentId: string | null | undefined,
  selfId?: string,
): Promise<void> {
  if (!parentId) return;
  if (parentId === selfId)
    throw new ApiError(422, "COLLECTION_CYCLE", "A collection cannot be its own parent.");
  const parent = await first<Record<string, unknown>>(
    db,
    "SELECT id,parent_id FROM collections WHERE id=? AND user_id=? AND deleted_at IS NULL",
    parentId,
    userId,
  );
  if (!parent)
    throw new ApiError(422, "PARENT_COLLECTION_NOT_FOUND", "Parent collection was not found.");
  let ancestor: unknown = parent.parent_id;
  let depth = 0;
  while (typeof ancestor === "string" && depth < 100) {
    if (ancestor === selfId)
      throw new ApiError(
        422,
        "COLLECTION_CYCLE",
        "The collection hierarchy would contain a cycle.",
      );
    const next = await first<Record<string, unknown>>(
      db,
      "SELECT parent_id FROM collections WHERE id=? AND user_id=?",
      ancestor,
      userId,
    );
    ancestor = next?.parent_id;
    depth += 1;
  }
}

collectionsRoutes.post("/", async (c) => {
  const input = collectionInputSchema.parse(await c.req.json());
  const userId = c.get("user").id;
  await ensureParent(c.env.DB, userId, input.parentId);
  const id = createId("col");
  const now = nowUtcIso();
  const snapshot = {
    id,
    name: input.name,
    description: input.description ?? null,
    parentId: input.parentId ?? null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO collections (id,user_id,name,description,parent_id,created_at,updated_at,deleted_at)
       VALUES (?,?,?,?,?,?,?,NULL)`,
    ).bind(id, userId, input.name, input.description ?? null, input.parentId ?? null, now, now),
    changeStatement(c.env.DB, {
      userId,
      entityType: "collection",
      entityId: id,
      operation: "create",
      version: 1,
      data: snapshot,
      changedAt: now,
    }),
  ]);
  return c.json(snapshot, 201);
});

collectionsRoutes.patch("/:collectionId", async (c) => {
  const input = collectionInputSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0)
    .parse(await c.req.json());
  const userId = c.get("user").id;
  const collectionId = c.req.param("collectionId");
  const existing = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM collections WHERE id=? AND user_id=? AND deleted_at IS NULL",
    collectionId,
    userId,
  );
  if (!existing) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Collection was not found.");
  await ensureParent(c.env.DB, userId, input.parentId, collectionId);
  const now = nowUtcIso();
  await c.env.DB.prepare(
    "UPDATE collections SET name=?,description=?,parent_id=?,updated_at=? WHERE id=? AND user_id=?",
  )
    .bind(
      input.name ?? existing.name,
      input.description === undefined ? existing.description : input.description,
      input.parentId === undefined ? existing.parent_id : input.parentId,
      now,
      collectionId,
      userId,
    )
    .run();
  const updated = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM collections WHERE id=? AND user_id=?",
    collectionId,
    userId,
  );
  await changeStatement(c.env.DB, {
    userId,
    entityType: "collection",
    entityId: collectionId,
    operation: "update",
    version: await nextEntityVersion(c.env.DB, userId, "collection", collectionId),
    data: collectionResponse(updated ?? existing),
    changedAt: now,
  }).run();
  return c.json(collectionResponse(updated ?? existing));
});

collectionsRoutes.delete("/:collectionId", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("collectionId");
  const existing = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT id FROM collections WHERE id=? AND user_id=? AND deleted_at IS NULL",
    id,
    userId,
  );
  if (!existing) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Collection was not found.");
  const childCount = await first<{ count: number } & Record<string, unknown>>(
    c.env.DB,
    "SELECT COUNT(*) AS count FROM collections WHERE user_id=? AND parent_id=? AND deleted_at IS NULL",
    userId,
    id,
  );
  if (Number(childCount?.count ?? 0) > 0) {
    throw new ApiError(
      409,
      "COLLECTION_HAS_CHILDREN",
      "Move or delete child collections before deleting this collection.",
    );
  }
  const now = nowUtcIso();
  const update = await c.env.DB.prepare(
    "UPDATE collections SET deleted_at=?,updated_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL",
  )
    .bind(now, now, id, userId)
    .run();
  if (update.meta.changes !== 1)
    throw new ApiError(404, "COLLECTION_NOT_FOUND", "Collection was not found.");
  await changeStatement(c.env.DB, {
    userId,
    entityType: "collection",
    entityId: id,
    operation: "delete",
    version: await nextEntityVersion(c.env.DB, userId, "collection", id),
    data: { id, deletedAt: now },
    changedAt: now,
  }).run();
  return c.body(null, 204);
});

collectionsRoutes.put("/:collectionId/papers/:paperId", async (c) => {
  const userId = c.get("user").id;
  const collectionId = c.req.param("collectionId");
  const paperId = c.req.param("paperId");
  await requirePaper(c.env.DB, userId, paperId);
  const collection = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT id FROM collections WHERE id=? AND user_id=? AND deleted_at IS NULL",
    collectionId,
    userId,
  );
  if (!collection) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Collection was not found.");
  const now = nowUtcIso();
  const result = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO collection_papers (user_id,collection_id,paper_id,created_at) VALUES (?,?,?,?)",
  )
    .bind(userId, collectionId, paperId, now)
    .run();
  if (result.meta.changes === 1) {
    await changeStatement(c.env.DB, {
      userId,
      entityType: "collection_paper",
      entityId: `${collectionId}:${paperId}`,
      operation: "create",
      version: 1,
      data: { collectionId, paperId, createdAt: now },
      changedAt: now,
    }).run();
  }
  return c.body(null, 204);
});

collectionsRoutes.delete("/:collectionId/papers/:paperId", async (c) => {
  const userId = c.get("user").id;
  const collectionId = c.req.param("collectionId");
  const paperId = c.req.param("paperId");
  const result = await c.env.DB.prepare(
    "DELETE FROM collection_papers WHERE user_id=? AND collection_id=? AND paper_id=?",
  )
    .bind(userId, collectionId, paperId)
    .run();
  if (result.meta.changes === 1) {
    const now = nowUtcIso();
    await changeStatement(c.env.DB, {
      userId,
      entityType: "collection_paper",
      entityId: `${collectionId}:${paperId}`,
      operation: "delete",
      version: 1,
      data: { collectionId, paperId, deletedAt: now },
      changedAt: now,
    }).run();
  }
  return c.body(null, 204);
});

export const notesRoutes = new Hono<AppBindings>();

notesRoutes.get("/papers/:paperId/notes", async (c) => {
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId");
  await requirePaper(c.env.DB, userId, paperId);
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM notes WHERE user_id=? AND paper_id=? AND deleted_at IS NULL ORDER BY page_number,updated_at DESC",
    userId,
    paperId,
  );
  return c.json({ items: rows.map(noteResponse) });
});

notesRoutes.post("/papers/:paperId/notes", async (c) => {
  const input = noteInputSchema.parse(await c.req.json());
  const userId = c.get("user").id;
  const paperId = c.req.param("paperId");
  await requirePaper(c.env.DB, userId, paperId);
  if (input.parentNoteId) {
    const parent = await first<Record<string, unknown>>(
      c.env.DB,
      "SELECT id FROM notes WHERE id=? AND user_id=? AND paper_id=? AND deleted_at IS NULL",
      input.parentNoteId,
      userId,
      paperId,
    );
    if (!parent) throw new ApiError(422, "PARENT_NOTE_NOT_FOUND", "Parent note was not found.");
  }
  const id = createId("not");
  const now = nowUtcIso();
  const snapshot = {
    id,
    paperId,
    parentNoteId: input.parentNoteId ?? null,
    noteType: input.noteType,
    pageNumber: input.pageNumber ?? null,
    anchor: input.anchor ?? null,
    contentMarkdown: input.contentMarkdown,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO notes
        (id,user_id,paper_id,library_id,parent_note_id,note_type,page_number,anchor_json,content_markdown,version,created_at,updated_at,deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?,NULL)`,
    ).bind(
      id,
      userId,
      paperId,
      c.get("libraryId"),
      input.parentNoteId ?? null,
      input.noteType,
      input.pageNumber ?? null,
      input.anchor ? JSON.stringify(input.anchor) : null,
      input.contentMarkdown,
      now,
      now,
    ),
    changeStatement(c.env.DB, {
      userId,
      entityType: "note",
      entityId: id,
      operation: "create",
      version: 1,
      data: snapshot,
      changedAt: now,
    }),
  ]);
  return c.json(snapshot, 201, { ETag: '"1"' });
});

notesRoutes.patch("/notes/:noteId", async (c) => {
  const input = noteInputSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0)
    .parse(await c.req.json());
  const userId = c.get("user").id;
  const noteId = c.req.param("noteId");
  const expectedVersion = parseIfMatch(c.req.header("If-Match"));
  const existing = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM notes WHERE id=? AND user_id=? AND deleted_at IS NULL",
    noteId,
    userId,
  );
  if (!existing) throw new ApiError(404, "NOTE_NOT_FOUND", "Note was not found.");
  if (Number(existing.version) !== expectedVersion) {
    throw new ApiError(409, "VERSION_CONFLICT", "The note was changed by another client.", {
      current: noteResponse(existing),
    });
  }
  const parentNoteId =
    input.parentNoteId === undefined ? existing.parent_note_id : input.parentNoteId;
  if (parentNoteId != null) {
    if (parentNoteId === noteId) {
      throw new ApiError(422, "PARENT_NOTE_CYCLE", "A note cannot be its own parent.");
    }
    const parent = await first<Record<string, unknown>>(
      c.env.DB,
      "SELECT id FROM notes WHERE id=? AND user_id=? AND paper_id=? AND deleted_at IS NULL",
      parentNoteId,
      userId,
      existing.paper_id,
    );
    if (!parent) throw new ApiError(422, "PARENT_NOTE_NOT_FOUND", "Parent note was not found.");
    const cycle = await first<Record<string, unknown>>(
      c.env.DB,
      `WITH RECURSIVE lineage(id,parent_note_id) AS (
         SELECT id,parent_note_id FROM notes WHERE id=? AND user_id=? AND paper_id=?
         UNION ALL
         SELECT n.id,n.parent_note_id FROM notes n JOIN lineage l ON n.id=l.parent_note_id
         WHERE n.user_id=? AND n.paper_id=?
       )
       SELECT id FROM lineage WHERE id=? LIMIT 1`,
      parentNoteId,
      userId,
      existing.paper_id,
      userId,
      existing.paper_id,
      noteId,
    );
    if (cycle)
      throw new ApiError(422, "PARENT_NOTE_CYCLE", "The parent note would create a cycle.");
  }
  const noteType = input.noteType ?? existing.note_type;
  const pageNumber = input.pageNumber === undefined ? existing.page_number : input.pageNumber;
  if ((noteType === "page" || noteType === "highlight") && pageNumber == null) {
    throw new ApiError(
      422,
      "PAGE_NUMBER_REQUIRED",
      "Page and highlight notes require a page number.",
    );
  }
  const now = nowUtcIso();
  const nextVersion = expectedVersion + 1;
  const update = await c.env.DB.prepare(
    `UPDATE notes SET parent_note_id=?,note_type=?,page_number=?,anchor_json=?,content_markdown=?,version=?,updated_at=?
     WHERE id=? AND user_id=? AND version=? AND deleted_at IS NULL`,
  )
    .bind(
      parentNoteId,
      noteType,
      pageNumber,
      input.anchor === undefined
        ? existing.anchor_json
        : input.anchor
          ? JSON.stringify(input.anchor)
          : null,
      input.contentMarkdown ?? existing.content_markdown,
      nextVersion,
      now,
      noteId,
      userId,
      expectedVersion,
    )
    .run();
  if (update.meta.changes !== 1)
    throw new ApiError(409, "VERSION_CONFLICT", "The note was changed by another client.");
  const updated = await first<Record<string, unknown>>(
    c.env.DB,
    "SELECT * FROM notes WHERE id=? AND user_id=?",
    noteId,
    userId,
  );
  await changeStatement(c.env.DB, {
    userId,
    entityType: "note",
    entityId: noteId,
    operation: "update",
    version: nextVersion,
    data: updated ? noteResponse(updated) : {},
    changedAt: now,
  }).run();
  return c.json(noteResponse(updated ?? existing), 200, { ETag: `"${nextVersion}"` });
});

notesRoutes.delete("/notes/:noteId", async (c) => {
  const userId = c.get("user").id;
  const noteId = c.req.param("noteId");
  const expectedVersion = parseIfMatch(c.req.header("If-Match"));
  const now = nowUtcIso();
  const nextVersion = expectedVersion + 1;
  const update = await c.env.DB.prepare(
    "UPDATE notes SET deleted_at=?,updated_at=?,version=? WHERE id=? AND user_id=? AND version=? AND deleted_at IS NULL",
  )
    .bind(now, now, nextVersion, noteId, userId, expectedVersion)
    .run();
  if (update.meta.changes !== 1) {
    const exists = await first<Record<string, unknown>>(
      c.env.DB,
      "SELECT id,version FROM notes WHERE id=? AND user_id=?",
      noteId,
      userId,
    );
    if (!exists) throw new ApiError(404, "NOTE_NOT_FOUND", "Note was not found.");
    throw new ApiError(409, "VERSION_CONFLICT", "The note was changed by another client.", {
      currentVersion: exists.version,
    });
  }
  await changeStatement(c.env.DB, {
    userId,
    entityType: "note",
    entityId: noteId,
    operation: "delete",
    version: nextVersion,
    data: { id: noteId, deletedAt: now, version: nextVersion },
    changedAt: now,
  }).run();
  return c.body(null, 204);
});
