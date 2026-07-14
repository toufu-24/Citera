import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    accessIssuer: text("access_issuer"),
    accessSubject: text("access_subject"),
    status: text("status").notNull().default("active"),
    deletionRequestedAt: text("deletion_requested_at"),
    deletionGeneration: integer("deletion_generation").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_email_uq").on(table.email),
    uniqueIndex("users_access_identity_uq")
      .on(table.accessIssuer, table.accessSubject)
      .where(sql`${table.accessIssuer} is not null and ${table.accessSubject} is not null`),
    index("users_status_idx").on(table.status),
    check("users_deletion_generation_ck", sql`${table.deletionGeneration} >= 0`),
  ],
);

export const libraries = sqliteTable(
  "libraries",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().default("personal"),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [check("libraries_kind_ck", sql`${table.kind} in ('personal','shared')`)],
);

export const libraryMembers = sqliteTable(
  "library_members",
  {
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.libraryId, table.userId] }),
    index("library_members_user_idx").on(table.userId, table.status),
  ],
);

export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    libraryId: text("library_id").references(() => libraries.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("oauth_accounts_provider_account_uq").on(table.provider, table.providerAccountId),
    index("oauth_accounts_user_idx").on(table.userId),
  ],
);

export const oauthStates = sqliteTable(
  "oauth_states",
  {
    stateHash: text("state_hash").primaryKey(),
    provider: text("provider").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    returnTo: text("return_to").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("oauth_states_expiry_idx").on(table.expiresAt)],
);

export const sessionFamilies = sqliteTable(
  "session_families",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [index("session_families_user_active_idx").on(table.userId, table.revokedAt)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    accessTokenHash: text("access_token_hash"),
    accessExpiresAt: text("access_expires_at"),
    familyId: text("family_id")
      .notNull()
      .references(() => sessionFamilies.id, { onDelete: "cascade" }),
    parentSessionId: text("parent_session_id"),
    replacedBySessionId: text("replaced_by_session_id"),
    deviceName: text("device_name").notNull(),
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    expiresAt: text("expires_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    uniqueIndex("sessions_access_token_hash_uq").on(table.accessTokenHash),
    index("sessions_user_active_idx").on(table.userId, table.revokedAt, table.expiresAt),
    index("sessions_family_idx").on(table.familyId, table.revokedAt),
  ],
);

export const authorizationCodes = sqliteTable(
  "authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [index("authorization_codes_expiry_idx").on(table.expiresAt)],
);

export const papers = sqliteTable(
  "papers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    libraryId: text("library_id").references(() => libraries.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    abstract: text("abstract"),
    publicationYear: integer("publication_year"),
    publicationDate: text("publication_date"),
    venue: text("venue"),
    volume: text("volume"),
    issue: text("issue"),
    pages: text("pages"),
    publisher: text("publisher"),
    language: text("language"),
    paperType: text("paper_type").notNull().default("article-journal"),
    status: text("status").notNull().default("inbox"),
    readingStatus: text("reading_status").notNull().default("unread"),
    priority: integer("priority").notNull().default(0),
    rating: integer("rating"),
    readProgress: real("read_progress").notNull().default(0),
    sourceUrl: text("source_url"),
    noteMarkdown: text("note_markdown"),
    metadataState: text("metadata_state").notNull().default("pending"),
    searchText: text("search_text").notNull().default(""),
    version: integer("version").notNull().default(1),
    lastOpenedAt: text("last_opened_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    check("papers_status_ck", sql`${table.status} in ('inbox','reading','read','archived')`),
    check("papers_reading_status_ck", sql`${table.readingStatus} in ('unread','reading','read','on_hold')`),
    check(
      "papers_metadata_state_ck",
      sql`${table.metadataState} in ('pending','complete','needs_review','failed')`,
    ),
    check(
      "papers_rating_ck",
      sql`${table.rating} is null or (${table.rating} >= 0 and ${table.rating} <= 5)`,
    ),
    check("papers_progress_ck", sql`${table.readProgress} >= 0 and ${table.readProgress} <= 100`),
    index("papers_user_created_idx").on(table.userId, table.createdAt),
    index("papers_user_updated_idx").on(table.userId, table.updatedAt),
    index("papers_user_publication_year_idx").on(table.userId, table.publicationYear),
    index("papers_user_status_updated_idx").on(table.userId, table.status, table.updatedAt),
    index("papers_library_created_idx").on(table.libraryId, table.createdAt),
    index("papers_library_status_idx").on(table.libraryId, table.readingStatus, table.updatedAt),
  ],
);

export const paperIdentifiers = sqliteTable(
  "paper_identifiers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    identifierType: text("identifier_type").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    originalValue: text("original_value").notNull(),
    version: text("identifier_version"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("paper_identifiers_user_type_value_uq").on(
      table.userId,
      table.identifierType,
      table.normalizedValue,
    ),
    index("paper_identifiers_paper_idx").on(table.userId, table.paperId),
  ],
);

export const authors = sqliteTable(
  "authors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    normalizedName: text("normalized_name").notNull(),
    displayName: text("display_name").notNull(),
    orcid: text("orcid"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("authors_user_name_orcid_uq").on(table.userId, table.normalizedName, table.orcid),
    index("authors_user_name_idx").on(table.userId, table.normalizedName),
  ],
);

export const paperAuthors = sqliteTable(
  "paper_authors",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => authors.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    role: text("role").notNull().default("author"),
  },
  (table) => [
    primaryKey({ columns: [table.paperId, table.authorId, table.role] }),
    uniqueIndex("paper_authors_position_uq").on(table.paperId, table.role, table.position),
    index("paper_authors_user_paper_idx").on(table.userId, table.paperId),
  ],
);

export const metadataValues = sqliteTable(
  "metadata_values",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    fieldName: text("field_name").notNull(),
    valueJson: text("value_json").notNull(),
    sourceType: text("source_type").notNull(),
    sourceReference: text("source_reference"),
    confidence: real("confidence").notNull(),
    selected: integer("selected", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check(
      "metadata_values_confidence_ck",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    index("metadata_values_user_paper_field_idx").on(table.userId, table.paperId, table.fieldName),
  ],
);

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    ingestionId: text("ingestion_id"),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    originalName: text("original_name").notNull(),
    kind: text("kind").notNull(),
    label: text("label"),
    fileKind: text("file_kind").notNull().default("fulltext"),
    languageCode: text("language_code"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    uploadState: text("upload_state").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("files_r2_key_uq").on(table.r2Key),
    index("files_user_sha_kind_idx").on(table.userId, table.sha256, table.kind),
    index("files_user_paper_idx").on(table.userId, table.paperId, table.deletedAt),
    index("files_paper_kind_order_idx").on(table.paperId, table.fileKind, table.sortOrder, table.createdAt),
    uniqueIndex("files_one_default_per_paper_uq")
      .on(table.paperId)
      .where(sql`${table.isDefault} = 1 and ${table.deletedAt} is null`),
    check(
      "files_kind_ck",
      sql`${table.kind} in ('original_pdf','supplement','thumbnail','extracted_text','export')`,
    ),
    check(
      "files_upload_state_ck",
      sql`${table.uploadState} in ('pending','uploaded','verified','failed')`,
    ),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    libraryId: text("library_id").references(() => libraries.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    color: text("color"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("tags_user_normalized_name_uq").on(table.userId, table.normalizedName),
    index("tags_user_name_idx").on(table.userId, table.name),
    index("tags_library_name_idx").on(table.libraryId, table.normalizedName),
  ],
);

export const paperTags = sqliteTable(
  "paper_tags",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    libraryId: text("library_id").references(() => libraries.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.paperId, table.tagId] }),
    index("paper_tags_user_tag_paper_idx").on(table.userId, table.tagId, table.paperId),
    index("paper_tags_library_tag_paper_idx").on(table.libraryId, table.tagId, table.paperId),
  ],
);

export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    parentId: text("parent_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("collections_user_parent_name_uq").on(table.userId, table.parentId, table.name),
    index("collections_user_parent_idx").on(table.userId, table.parentId, table.deletedAt),
  ],
);

export const userPreferences = sqliteTable(
  "user_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    defaultCollectionId: text("default_collection_id").references(() => collections.id, {
      onDelete: "set null",
    }),
    defaultTagIdsJson: text("default_tag_ids_json").notNull().default("[]"),
    defaultStatus: text("default_status").notNull().default("inbox"),
    defaultExportFormat: text("default_export_format").notNull().default("bibtex"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("user_preferences_tags_json_ck", sql`json_valid(${table.defaultTagIdsJson})`),
    check(
      "user_preferences_status_ck",
      sql`${table.defaultStatus} in ('inbox','reading','read','archived')`,
    ),
    check(
      "user_preferences_export_ck",
      sql`${table.defaultExportFormat} in ('bibtex','csl-json','ris','csv','json')`,
    ),
  ],
);

export const collectionPapers = sqliteTable(
  "collection_papers",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.paperId] }),
    index("collection_papers_user_paper_idx").on(table.userId, table.paperId),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    libraryId: text("library_id").references(() => libraries.id, { onDelete: "set null" }),
    parentNoteId: text("parent_note_id"),
    noteType: text("note_type").notNull(),
    pageNumber: integer("page_number"),
    anchorJson: text("anchor_json"),
    contentMarkdown: text("content_markdown").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    check(
      "notes_type_ck",
      sql`${table.noteType} in ('general','page','highlight','summary','todo')`,
    ),
    check(
      "notes_page_ck",
      sql`(${table.noteType} not in ('page','highlight')) or (${table.pageNumber} is not null and ${table.pageNumber} > 0)`,
    ),
    index("notes_user_paper_updated_idx").on(table.userId, table.paperId, table.updatedAt),
    index("notes_library_paper_idx").on(table.libraryId, table.paperId, table.updatedAt),
    uniqueIndex("notes_id_user_paper_uq").on(table.id, table.userId, table.paperId),
    foreignKey({
      columns: [table.parentNoteId],
      foreignColumns: [table.id],
      name: "notes_parent_note_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.parentNoteId, table.userId, table.paperId],
      foreignColumns: [table.id, table.userId, table.paperId],
      name: "notes_parent_tenant_paper_fk",
    }),
  ],
);

export const ingestions = sqliteTable(
  "ingestions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    paperId: text("paper_id").references(() => papers.id, { onDelete: "set null" }),
    clientMutationId: text("client_mutation_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceUrl: text("source_url"),
    state: text("state").notNull().default("pending"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("ingestions_user_mutation_uq").on(table.userId, table.clientMutationId),
    index("ingestions_user_state_idx").on(table.userId, table.state, table.updatedAt),
  ],
);

export const paperRelations = sqliteTable(
  "paper_relations",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourcePaperId: text("source_paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    targetPaperId: text("target_paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourcePaperId, table.targetPaperId, table.relationType] }),
    index("paper_relations_user_target_idx").on(table.userId, table.targetPaperId),
    check("paper_relations_self_ck", sql`${table.sourcePaperId} <> ${table.targetPaperId}`),
  ],
);

export const changes = sqliteTable(
  "changes",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    operation: text("operation").notNull(),
    version: integer("version").notNull(),
    dataJson: text("data_json").notNull(),
    changedAt: text("changed_at").notNull(),
  },
  (table) => [
    index("changes_user_sequence_idx").on(table.userId, table.sequence),
    uniqueIndex("changes_paper_version_uq")
      .on(table.userId, table.entityId, table.version)
      .where(sql`${table.entityType} = 'paper'`),
    check(
      "changes_operation_ck",
      sql`${table.operation} in ('create','update','delete','restore')`,
    ),
  ],
);

export const clientMutations = sqliteTable(
  "client_mutations",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientMutationId: text("client_mutation_id").notNull(),
    resultJson: text("result_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.clientMutationId] }),
    index("client_mutations_created_idx").on(table.createdAt),
  ],
);

export const jobOutbox = sqliteTable(
  "job_outbox",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    jobJson: text("job_json").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: text("available_at").notNull(),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    dispatchedAt: text("dispatched_at"),
  },
  (table) => [
    uniqueIndex("job_outbox_idempotency_uq").on(table.idempotencyKey),
    index("job_outbox_state_available_idx").on(table.state, table.availableAt, table.createdAt),
    check("job_outbox_state_ck", sql`${table.state} in ('pending','dispatched','failed')`),
    check("job_outbox_attempts_ck", sql`${table.attempts} >= 0`),
  ],
);

export const exportJobs = sqliteTable(
  "export_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    queryJson: text("query_json").notNull(),
    state: text("state").notNull().default("pending"),
    r2Key: text("r2_key"),
    mediaType: text("media_type"),
    sizeBytes: integer("size_bytes"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("export_jobs_user_created_idx").on(table.userId, table.createdAt),
    check(
      "export_jobs_format_ck",
      sql`${table.format} in ('bibtex','csl-json','ris','csv','json','backup')`,
    ),
    check(
      "export_jobs_state_ck",
      sql`${table.state} in ('pending','processing','complete','failed','expired')`,
    ),
  ],
);

export const metadataCache = sqliteTable(
  "metadata_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    provider: text("provider").notNull(),
    responseJson: text("response_json").notNull(),
    etag: text("etag"),
    fetchedAt: text("fetched_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("metadata_cache_expiry_idx").on(table.expiresAt)],
);

export const jobRuns = sqliteTable(
  "job_runs",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    jobId: text("job_id").notNull(),
    type: text("type").notNull(),
    userId: text("user_id").notNull(),
    paperId: text("paper_id"),
    sourceVersion: integer("source_version").notNull(),
    state: text("state").notNull(),
    attempts: integer("attempts").notNull().default(0),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("job_runs_user_state_idx").on(table.userId, table.state, table.updatedAt),
    check("job_runs_state_ck", sql`${table.state} in ('running','retrying','complete','failed')`),
  ],
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    scope: text("scope").notNull(),
    keyHash: text("key_hash").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.keyHash, table.windowStart] }),
    index("rate_limits_window_idx").on(table.windowStart),
  ],
);
