import { SyncMutationBatchSchema, type SyncMutation, type SyncMutationResult } from "@citera/sync";
import { Hono } from "hono";
import { z } from "zod";
import { all, changeStatement, first } from "../db";
import type { AppBindings } from "../types";
import { nowUtcIso, parseJson } from "../utils";

const syncQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

const paperColumns: Record<string, string> = {
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
};

interface StoredMutation extends Record<string, unknown> {
  result_json: string;
}

async function storeResult(
  db: D1Database,
  userId: string,
  mutationId: string,
  result: SyncMutationResult,
  now: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO client_mutations (user_id,client_mutation_id,result_json,created_at) VALUES (?,?,?,?)",
    )
    .bind(userId, mutationId, JSON.stringify(result), now)
    .run();
}

async function applyPaperMutation(
  db: D1Database,
  userId: string,
  mutation: SyncMutation,
  now: string,
): Promise<SyncMutationResult> {
  const paper = await first<Record<string, unknown>>(
    db,
    "SELECT * FROM papers WHERE id=? AND user_id=?",
    mutation.entityId,
    userId,
  );
  if (!paper) {
    return {
      clientMutationId: mutation.clientMutationId,
      status: "rejected",
      entityId: mutation.entityId,
      error: { code: "PAPER_NOT_FOUND", message: "Paper was not found." },
    };
  }
  const currentVersion = Number(paper.version);
  if (mutation.baseVersion !== currentVersion) {
    return {
      clientMutationId: mutation.clientMutationId,
      status: "conflict",
      entityId: mutation.entityId,
      version: currentVersion,
      error: { code: "VERSION_CONFLICT", message: "The paper was changed by another client." },
    };
  }
  const nextVersion = currentVersion + 1;
  let operation: "update" | "delete" | "restore" = "update";
  let result: D1Result;
  if (mutation.operation === "delete") {
    operation = "delete";
    result = await db
      .prepare(
        "UPDATE papers SET deleted_at=?,updated_at=?,version=? WHERE id=? AND user_id=? AND version=?",
      )
      .bind(now, now, nextVersion, mutation.entityId, userId, currentVersion)
      .run();
  } else if (mutation.operation === "restore") {
    operation = "restore";
    result = await db
      .prepare(
        "UPDATE papers SET deleted_at=NULL,updated_at=?,version=? WHERE id=? AND user_id=? AND version=?",
      )
      .bind(now, nextVersion, mutation.entityId, userId, currentVersion)
      .run();
  } else if (mutation.operation === "update") {
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of Object.entries(mutation.payload)) {
      const column = paperColumns[field];
      if (column) {
        assignments.push(`${column}=?`);
        values.push(value);
      }
    }
    if (assignments.length === 0) {
      return {
        clientMutationId: mutation.clientMutationId,
        status: "rejected",
        entityId: mutation.entityId,
        error: {
          code: "NO_MUTABLE_FIELDS",
          message: "The mutation has no supported paper fields.",
        },
      };
    }
    assignments.push("updated_at=?", "version=?");
    values.push(now, nextVersion);
    result = await db
      .prepare(`UPDATE papers SET ${assignments.join(",")} WHERE id=? AND user_id=? AND version=?`)
      .bind(...values, mutation.entityId, userId, currentVersion)
      .run();
  } else {
    return {
      clientMutationId: mutation.clientMutationId,
      status: "rejected",
      entityId: mutation.entityId,
      error: { code: "OPERATION_UNSUPPORTED", message: "The paper operation is not supported." },
    };
  }
  if (result.meta.changes !== 1) {
    return {
      clientMutationId: mutation.clientMutationId,
      status: "conflict",
      entityId: mutation.entityId,
      error: { code: "VERSION_CONFLICT", message: "The paper was changed by another client." },
    };
  }
  await changeStatement(db, {
    userId,
    entityType: "paper",
    entityId: mutation.entityId,
    operation,
    version: nextVersion,
    data: { ...mutation.payload, id: mutation.entityId, version: nextVersion, updatedAt: now },
    changedAt: now,
  }).run();
  return {
    clientMutationId: mutation.clientMutationId,
    status: "applied",
    entityId: mutation.entityId,
    version: nextVersion,
  };
}

async function applyRelationMutation(
  db: D1Database,
  userId: string,
  mutation: SyncMutation,
  now: string,
): Promise<SyncMutationResult> {
  const isTag = mutation.entityType === "paper_tag";
  const relatedId = isTag ? mutation.payload.tagId : mutation.payload.collectionId;
  const paperId = mutation.payload.paperId;
  if (typeof relatedId !== "string" || typeof paperId !== "string") {
    return {
      clientMutationId: mutation.clientMutationId,
      status: "rejected",
      entityId: mutation.entityId,
      error: { code: "RELATION_PAYLOAD_INVALID", message: "Relation IDs are required." },
    };
  }
  const paper = await first<Record<string, unknown>>(
    db,
    "SELECT id FROM papers WHERE id=? AND user_id=? AND deleted_at IS NULL",
    paperId,
    userId,
  );
  const related = await first<Record<string, unknown>>(
    db,
    `SELECT id FROM ${isTag ? "tags" : "collections"} WHERE id=? AND user_id=? ${isTag ? "" : "AND deleted_at IS NULL"}`,
    relatedId,
    userId,
  );
  if (!paper || !related) {
    return {
      clientMutationId: mutation.clientMutationId,
      status: "rejected",
      entityId: mutation.entityId,
      error: { code: "RELATED_ENTITY_NOT_FOUND", message: "A related entity was not found." },
    };
  }
  const add = mutation.operation === "add" || mutation.operation === "create";
  const remove = mutation.operation === "remove" || mutation.operation === "delete";
  if (!add && !remove) {
    return {
      clientMutationId: mutation.clientMutationId,
      status: "rejected",
      entityId: mutation.entityId,
      error: { code: "OPERATION_UNSUPPORTED", message: "The relation operation is not supported." },
    };
  }
  if (isTag) {
    if (add) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO paper_tags (user_id,paper_id,tag_id,created_at) VALUES (?,?,?,?)",
        )
        .bind(userId, paperId, relatedId, now)
        .run();
    } else {
      await db
        .prepare("DELETE FROM paper_tags WHERE user_id=? AND paper_id=? AND tag_id=?")
        .bind(userId, paperId, relatedId)
        .run();
    }
  } else if (add) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO collection_papers (user_id,collection_id,paper_id,created_at) VALUES (?,?,?,?)",
      )
      .bind(userId, relatedId, paperId, now)
      .run();
  } else {
    await db
      .prepare("DELETE FROM collection_papers WHERE user_id=? AND collection_id=? AND paper_id=?")
      .bind(userId, relatedId, paperId)
      .run();
  }
  await changeStatement(db, {
    userId,
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    operation: add ? "create" : "delete",
    version: 1,
    data: { ...mutation.payload, ...(remove ? { deletedAt: now } : { createdAt: now }) },
    changedAt: now,
  }).run();
  return {
    clientMutationId: mutation.clientMutationId,
    status: "applied",
    entityId: mutation.entityId,
    version: 1,
  };
}

async function applyMutation(
  db: D1Database,
  userId: string,
  mutation: SyncMutation,
): Promise<SyncMutationResult> {
  const stored = await first<StoredMutation>(
    db,
    "SELECT result_json FROM client_mutations WHERE user_id=? AND client_mutation_id=?",
    userId,
    mutation.clientMutationId,
  );
  if (stored) {
    const previous = parseJson<SyncMutationResult>(stored.result_json, {
      clientMutationId: mutation.clientMutationId,
      status: "duplicate",
      entityId: mutation.entityId,
    });
    return { ...previous, status: "duplicate" };
  }
  const now = nowUtcIso();
  let result: SyncMutationResult;
  if (mutation.entityType === "paper") result = await applyPaperMutation(db, userId, mutation, now);
  else if (mutation.entityType === "paper_tag" || mutation.entityType === "collection_paper") {
    result = await applyRelationMutation(db, userId, mutation, now);
  } else {
    result = {
      clientMutationId: mutation.clientMutationId,
      status: "rejected",
      entityId: mutation.entityId,
      error: {
        code: "ENTITY_UNSUPPORTED",
        message: "This entity type must use its REST endpoint.",
      },
    };
  }
  await storeResult(db, userId, mutation.clientMutationId, result, now);
  return result;
}

export const syncRoutes = new Hono<AppBindings>();

syncRoutes.get("/", async (c) => {
  const input = syncQuerySchema.parse(c.req.query());
  const rows = await all<Record<string, unknown>>(
    c.env.DB,
    `SELECT sequence,entity_type,entity_id,operation,version,data_json,changed_at
     FROM changes WHERE user_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?`,
    c.get("user").id,
    input.cursor,
    input.limit + 1,
  );
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const changes = page.map((row) => ({
    sequence: Number(row.sequence),
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation === "restore" ? "update" : row.operation,
    version: Number(row.version),
    changedAt: row.changed_at,
    data: parseJson(row.data_json, null),
  }));
  return c.json({
    changes,
    nextCursor: Number(page.at(-1)?.sequence ?? input.cursor),
    hasMore,
  });
});

syncRoutes.post("/mutations", async (c) => {
  const input = SyncMutationBatchSchema.parse(await c.req.json());
  const results: SyncMutationResult[] = [];
  for (const mutation of input.mutations) {
    results.push(await applyMutation(c.env.DB, c.get("user").id, mutation));
  }
  return c.json({ results });
});
