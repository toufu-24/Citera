import { z } from "zod";

export const SyncEntityTypeSchema = z.enum([
  "paper",
  "tag",
  "collection",
  "note",
  "file",
  "paper_tag",
  "collection_paper",
]);
export type SyncEntityType = z.infer<typeof SyncEntityTypeSchema>;

export const SyncOperationSchema = z.enum([
  "create",
  "update",
  "delete",
  "restore",
  "add",
  "remove",
]);
export type SyncOperation = z.infer<typeof SyncOperationSchema>;

const UtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Sync timestamps must be UTC");

const httpUrlSchema = z
  .string()
  .url()
  .max(8_192)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }, "Only credential-free HTTP(S) URLs without fragments are accepted");

const paperPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(10_000).optional(),
    abstract: z.string().max(1_000_000).nullable().optional(),
    publicationYear: z.number().int().min(1000).max(9999).nullable().optional(),
    publicationDate: z.string().date().nullable().optional(),
    venue: z.string().max(2_000).nullable().optional(),
    volume: z.string().max(100).nullable().optional(),
    issue: z.string().max(100).nullable().optional(),
    pages: z.string().max(100).nullable().optional(),
    publisher: z.string().max(2_000).nullable().optional(),
    language: z.string().max(35).nullable().optional(),
    paperType: z
      .enum([
        "article-journal",
        "paper-conference",
        "chapter",
        "book",
        "thesis",
        "preprint",
        "report",
        "dataset",
        "software",
        "other",
      ])
      .optional(),
    status: z.enum(["inbox", "reading", "read", "archived"]).optional(),
    priority: z.number().int().min(0).max(5).optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    readProgress: z.number().min(0).max(100).optional(),
    sourceUrl: httpUrlSchema.nullable().optional(),
  })
  .strict();

const SyncMutationBaseSchema = z.object({
  clientMutationId: z.string().min(1).max(200),
  entityType: SyncEntityTypeSchema,
  entityId: z.string().min(1).max(200),
  operation: SyncOperationSchema,
  baseVersion: z.number().int().nonnegative().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: UtcTimestampSchema,
});

function validateMutation(
  mutation: z.infer<typeof SyncMutationBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (mutation.entityType === "paper") {
    if (
      !(["update", "delete", "restore"] as const).includes(
        mutation.operation as "update" | "delete" | "restore",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: "Unsupported paper operation.",
      });
    }
    if (mutation.baseVersion == null) {
      context.addIssue({
        code: "custom",
        path: ["baseVersion"],
        message: "Paper mutations require a base version.",
      });
    }
    const parsed = paperPayloadSchema.safeParse(mutation.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.addIssue({ ...issue, path: ["payload", ...issue.path] });
    } else if (mutation.operation === "update" && Object.keys(parsed.data).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Paper updates require at least one field.",
      });
    } else if (mutation.operation !== "update" && Object.keys(parsed.data).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Delete and restore payloads must be empty.",
      });
    }
    return;
  }

  if (mutation.entityType === "paper_tag" || mutation.entityType === "collection_paper") {
    if (
      !(["add", "remove", "create", "delete"] as const).includes(
        mutation.operation as "add" | "remove" | "create" | "delete",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: "Unsupported relation operation.",
      });
    }
    const relatedField = mutation.entityType === "paper_tag" ? "tagId" : "collectionId";
    const parsed = z
      .object({ paperId: z.string().min(1).max(200), [relatedField]: z.string().min(1).max(200) })
      .strict()
      .safeParse(mutation.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.addIssue({ ...issue, path: ["payload", ...issue.path] });
    }
    return;
  }

  context.addIssue({
    code: "custom",
    path: ["entityType"],
    message: "This entity type must use its validated REST endpoint.",
  });
}

export const SyncMutationSchema = SyncMutationBaseSchema.superRefine(validateMutation);
export type SyncMutation = z.infer<typeof SyncMutationSchema>;

export const OutboxMutationSchema = SyncMutationBaseSchema.extend({
  status: z.enum(["pending", "in_flight", "failed"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: UtcTimestampSchema.nullable(),
  lastError: z.string().max(10_000).nullable(),
}).superRefine(validateMutation);
export type OutboxMutation = z.infer<typeof OutboxMutationSchema>;

export const SyncMutationBatchSchema = z.object({
  mutations: z.array(SyncMutationSchema).min(1).max(100),
});
export type SyncMutationBatch = z.infer<typeof SyncMutationBatchSchema>;

export const SyncMutationResultSchema = z.object({
  clientMutationId: z.string().min(1),
  status: z.enum(["applied", "duplicate", "conflict", "rejected"]),
  entityId: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
});
export type SyncMutationResult = z.infer<typeof SyncMutationResultSchema>;

export const SyncChangeSchema = z.object({
  sequence: z.number().int().positive(),
  entityType: SyncEntityTypeSchema,
  entityId: z.string().min(1),
  operation: z.enum(["create", "update", "delete"]),
  version: z.number().int().positive(),
  changedAt: UtcTimestampSchema,
  data: z.record(z.string(), z.unknown()).nullable(),
});
export type SyncChange = z.infer<typeof SyncChangeSchema>;

export const SyncResponseSchema = z.object({
  changes: z.array(SyncChangeSchema),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;
