import { z } from "zod";

import { PREFIXED_ULID_PATTERN } from "./ids";

export const UtcIsoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Date-time must be represented in UTC with Z");

export const HttpUrlSchema = z
  .string()
  .url()
  .max(8_192)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      context.addIssue({ code: "custom", message: "Only HTTP and HTTPS URLs are accepted." });
    }
    if (url.username || url.password) {
      context.addIssue({ code: "custom", message: "URLs must not contain credentials." });
    }
    if (url.hash) {
      context.addIssue({ code: "custom", message: "Source URLs must not contain fragments." });
    }
    for (const key of url.searchParams.keys()) {
      if (/(?:token|auth|signature|credential|api[_-]?key|x-amz)/iu.test(key)) {
        context.addIssue({
          code: "custom",
          message: "Source URLs must not contain credential-like query parameters.",
        });
        break;
      }
    }
  });

export const PrefixedIdSchema = z.string().regex(PREFIXED_ULID_PATTERN);
export const UserIdSchema = PrefixedIdSchema.refine((value) => value.startsWith("usr_"));
export const PaperIdSchema = PrefixedIdSchema.refine((value) => value.startsWith("pap_"));
export const TagIdSchema = PrefixedIdSchema.refine((value) => value.startsWith("tag_"));
export const CollectionIdSchema = PrefixedIdSchema.refine((value) => value.startsWith("col_"));
export const NoteIdSchema = PrefixedIdSchema.refine((value) => value.startsWith("not_"));

export const PaperStatusSchema = z.enum(["inbox", "reading", "read", "archived"]);
export type PaperStatus = z.infer<typeof PaperStatusSchema>;

export const MetadataStateSchema = z.enum(["pending", "complete", "needs_review", "failed"]);
export type MetadataState = z.infer<typeof MetadataStateSchema>;

export const PaperTypeSchema = z.enum([
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
]);
export type PaperType = z.infer<typeof PaperTypeSchema>;

export const IdentifierTypeSchema = z.enum(["doi", "arxiv", "pmid", "openalex", "isbn", "url"]);
export type IdentifierType = z.infer<typeof IdentifierTypeSchema>;

export const AuthorSchema = z.object({
  id: PrefixedIdSchema.optional(),
  displayName: z.string().trim().min(1).max(500),
  givenName: z.string().trim().min(1).max(250).nullable().optional(),
  familyName: z.string().trim().min(1).max(250).nullable().optional(),
  orcid: z
    .string()
    .regex(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/u)
    .nullable()
    .optional(),
  position: z.number().int().nonnegative().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const TagSchema = z.object({
  id: TagIdSchema,
  userId: UserIdSchema,
  name: z.string().trim().min(1).max(100),
  normalizedName: z.string().trim().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/iu)
    .nullable(),
  createdAt: UtcIsoDateTimeSchema,
  updatedAt: UtcIsoDateTimeSchema,
});
export type Tag = z.infer<typeof TagSchema>;

export const TagReferenceSchema = z.object({
  id: TagIdSchema,
  name: z.string().trim().min(1).max(100),
  normalizedName: z.string().trim().min(1).max(100).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/iu)
    .nullable(),
});
export type TagReference = z.infer<typeof TagReferenceSchema>;

export const CollectionSchema = z.object({
  id: CollectionIdSchema,
  userId: UserIdSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).nullable(),
  parentId: CollectionIdSchema.nullable(),
  createdAt: UtcIsoDateTimeSchema,
  updatedAt: UtcIsoDateTimeSchema,
  deletedAt: UtcIsoDateTimeSchema.nullable(),
});
export type Collection = z.infer<typeof CollectionSchema>;

export const CollectionReferenceSchema = z.object({
  id: CollectionIdSchema,
  name: z.string().trim().min(1).max(200),
});
export type CollectionReference = z.infer<typeof CollectionReferenceSchema>;

export const NoteTypeSchema = z.enum(["general", "page", "highlight", "summary", "todo"]);
export type NoteType = z.infer<typeof NoteTypeSchema>;

export const HighlightRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
});

export const NoteAnchorSchema = z.object({
  page: z.number().int().positive(),
  selectedText: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  rects: z.array(HighlightRectSchema).optional(),
});
export type NoteAnchor = z.infer<typeof NoteAnchorSchema>;

const NoteBaseSchema = z.object({
  id: NoteIdSchema,
  userId: UserIdSchema,
  paperId: PaperIdSchema,
  parentNoteId: NoteIdSchema.nullable(),
  noteType: NoteTypeSchema,
  pageNumber: z.number().int().positive().nullable(),
  anchor: NoteAnchorSchema.nullable(),
  contentMarkdown: z.string().max(1_000_000),
  version: z.number().int().positive(),
  createdAt: UtcIsoDateTimeSchema,
  updatedAt: UtcIsoDateTimeSchema,
  deletedAt: UtcIsoDateTimeSchema.nullable(),
});

function requirePageNumber(
  note: { noteType: NoteType; pageNumber: number | null },
  context: z.RefinementCtx,
): void {
  if ((note.noteType === "page" || note.noteType === "highlight") && note.pageNumber == null) {
    context.addIssue({
      code: "custom",
      message: "Page and highlight notes require a page number",
      path: ["pageNumber"],
    });
  }
}

export const NoteSchema = NoteBaseSchema.superRefine(requirePageNumber);
export type Note = z.infer<typeof NoteSchema>;

export const NoteResponseSchema = NoteBaseSchema.omit({ userId: true }).superRefine(
  requirePageNumber,
);
export type NoteResponse = z.infer<typeof NoteResponseSchema>;

export const PaperIdentifierSchema = z.object({
  id: PrefixedIdSchema,
  paperId: PaperIdSchema,
  identifierType: IdentifierTypeSchema,
  normalizedValue: z.string().min(1).max(2_048),
  originalValue: z.string().min(1).max(2_048),
  createdAt: UtcIsoDateTimeSchema,
});
export type PaperIdentifier = z.infer<typeof PaperIdentifierSchema>;

export const PaperIdentifierReferenceSchema = z.object({
  id: PrefixedIdSchema,
  identifierType: IdentifierTypeSchema,
  normalizedValue: z.string().min(1).max(2_048),
  originalValue: z.string().min(1).max(2_048),
  version: z.string().nullable().optional(),
});
export type PaperIdentifierReference = z.infer<typeof PaperIdentifierReferenceSchema>;

export const FileSummarySchema = z.object({
  id: PrefixedIdSchema,
  kind: z.enum(["original_pdf", "supplement", "thumbnail", "extracted_text", "export"]),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  originalName: z.string().min(1).max(1_024),
  uploadState: z.enum(["pending", "uploaded", "verified", "failed"]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

export const PaperSummarySchema = z.object({
  id: PaperIdSchema,
  title: z.string().trim().min(1).max(10_000),
  summary: z.string().max(240).nullable(),
  authors: z.array(AuthorSchema),
  publicationYear: z.number().int().min(1000).max(9999).nullable(),
  publicationDate: z.string().date().nullable(),
  venue: z.string().max(2_000).nullable(),
  paperType: PaperTypeSchema.nullable(),
  status: PaperStatusSchema,
  rating: z.number().int().min(1).max(5).nullable(),
  readProgress: z.number().min(0).max(100),
  metadataState: MetadataStateSchema,
  version: z.number().int().positive(),
  hasPdf: z.boolean(),
  hasNotes: z.boolean(),
  tags: z.array(TagReferenceSchema),
  createdAt: UtcIsoDateTimeSchema,
  updatedAt: UtcIsoDateTimeSchema,
  deletedAt: UtcIsoDateTimeSchema.nullable(),
});
export type PaperSummary = z.infer<typeof PaperSummarySchema>;

export const PaperDetailSchema = PaperSummarySchema.extend({
  abstract: z.string().max(1_000_000).nullable(),
  volume: z.string().max(100).nullable(),
  issue: z.string().max(100).nullable(),
  pages: z.string().max(100).nullable(),
  publisher: z.string().max(2_000).nullable(),
  language: z.string().max(35).nullable(),
  priority: z.number().int().min(0).max(5),
  sourceUrl: HttpUrlSchema.nullable(),
  metadataState: MetadataStateSchema,
  version: z.number().int().positive(),
  lastOpenedAt: UtcIsoDateTimeSchema.nullable(),
  identifiers: z.array(PaperIdentifierReferenceSchema),
  collections: z.array(CollectionReferenceSchema),
  notes: z.array(NoteResponseSchema),
  files: z.array(FileSummarySchema),
});
export type PaperDetail = z.infer<typeof PaperDetailSchema>;

export const ApiErrorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(2_000),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = z.object({
  error: ApiErrorSchema,
  requestId: z.string().min(1),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export function CursorPageSchema<const ItemSchema extends z.ZodTypeAny>(itemSchema: ItemSchema) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().min(1).nullable(),
    hasMore: z.boolean(),
  });
}

export type CursorPage<Item> = {
  items: Item[];
  nextCursor: string | null;
  hasMore: boolean;
};
