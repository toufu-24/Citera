PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  deletion_requested_at TEXT,
  deletion_generation INTEGER NOT NULL DEFAULT 0 CHECK (deletion_generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX users_email_uq ON users(email);

CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_account_id)
);
CREATE INDEX oauth_accounts_user_idx ON oauth_accounts(user_id);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);

CREATE TABLE session_families (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX session_families_user_active_idx ON session_families(user_id, revoked_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  access_token_hash TEXT,
  access_expires_at TEXT,
  family_id TEXT NOT NULL REFERENCES session_families(id) ON DELETE CASCADE,
  parent_session_id TEXT,
  replaced_by_session_id TEXT,
  device_name TEXT NOT NULL,
  user_agent TEXT,
  ip_hash TEXT,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX sessions_token_hash_uq ON sessions(token_hash);
CREATE UNIQUE INDEX sessions_access_token_hash_uq ON sessions(access_token_hash) WHERE access_token_hash IS NOT NULL;
CREATE INDEX sessions_user_active_idx ON sessions(user_id, revoked_at, expires_at);
CREATE INDEX sessions_family_idx ON sessions(family_id, revoked_at);

CREATE TABLE authorization_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX authorization_codes_expiry_idx ON authorization_codes(expires_at);

CREATE TABLE papers (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  abstract TEXT,
  publication_year INTEGER,
  publication_date TEXT,
  venue TEXT,
  volume TEXT,
  issue TEXT,
  pages TEXT,
  publisher TEXT,
  language TEXT,
  paper_type TEXT NOT NULL DEFAULT 'article-journal' CHECK (paper_type IN ('article-journal','paper-conference','chapter','book','thesis','preprint','report','dataset','software','other')),
  status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','reading','read','archived')),
  priority INTEGER NOT NULL DEFAULT 0,
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  read_progress REAL NOT NULL DEFAULT 0 CHECK (read_progress BETWEEN 0 AND 100),
  source_url TEXT,
  metadata_state TEXT NOT NULL DEFAULT 'pending' CHECK (metadata_state IN ('pending','complete','needs_review','failed')),
  search_text TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  last_opened_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX papers_user_created_idx ON papers(user_id, created_at DESC, id DESC);
CREATE INDEX papers_user_updated_idx ON papers(user_id, updated_at DESC, id DESC);
CREATE INDEX papers_user_publication_year_idx ON papers(user_id, publication_year DESC, id DESC);
CREATE INDEX papers_user_status_updated_idx ON papers(user_id, status, updated_at DESC, id DESC);

CREATE TABLE paper_identifiers (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL CHECK (identifier_type IN ('doi','arxiv','pmid','openalex','isbn','url')),
  normalized_value TEXT NOT NULL,
  original_value TEXT NOT NULL,
  identifier_version TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, identifier_type, normalized_value)
);
CREATE INDEX paper_identifiers_paper_idx ON paper_identifiers(user_id, paper_id);

CREATE TABLE authors (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  orcid TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX authors_user_name_orcid_uq ON authors(user_id, normalized_name, COALESCE(orcid, ''));
CREATE INDEX authors_user_name_idx ON authors(user_id, normalized_name);

CREATE TABLE paper_authors (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  role TEXT NOT NULL DEFAULT 'author',
  PRIMARY KEY(paper_id, author_id, role),
  UNIQUE(paper_id, role, position)
);
CREATE INDEX paper_authors_user_paper_idx ON paper_authors(user_id, paper_id);

CREATE TABLE metadata_values (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  source_type TEXT NOT NULL CHECK (source_type IN ('user','webpage','crossref','openalex','arxiv','pdf','import')),
  source_reference TEXT,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX metadata_values_user_paper_field_idx ON metadata_values(user_id, paper_id, field_name);

CREATE TABLE ingestions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
  client_mutation_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploading','processing','complete','failed')),
  error_code TEXT,
  error_message TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(user_id, client_mutation_id)
);
CREATE INDEX ingestions_user_state_idx ON ingestions(user_id, state, updated_at DESC);

CREATE TABLE files (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  ingestion_id TEXT REFERENCES ingestions(id) ON DELETE SET NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  original_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original_pdf','supplement','thumbnail','extracted_text','export')),
  upload_state TEXT NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending','uploaded','verified','failed')),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(r2_key)
);
CREATE INDEX files_user_sha_kind_idx ON files(user_id, sha256, kind);
CREATE INDEX files_user_paper_idx ON files(user_id, paper_id, deleted_at);

CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, normalized_name)
);
CREATE INDEX tags_user_name_idx ON tags(user_id, name COLLATE NOCASE);

CREATE TABLE paper_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(paper_id, tag_id)
);
CREATE INDEX paper_tags_user_tag_paper_idx ON paper_tags(user_id, tag_id, paper_id);

CREATE TABLE collections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  parent_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX collections_user_parent_name_uq ON collections(user_id, COALESCE(parent_id, ''), name COLLATE NOCASE);
CREATE INDEX collections_user_parent_idx ON collections(user_id, parent_id, deleted_at);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  default_collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  default_tag_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(default_tag_ids_json)),
  default_status TEXT NOT NULL DEFAULT 'inbox' CHECK (default_status IN ('inbox','reading','read','archived')),
  default_export_format TEXT NOT NULL DEFAULT 'bibtex' CHECK (default_export_format IN ('bibtex','csl-json','ris','csv','json')),
  updated_at TEXT NOT NULL
);

CREATE TABLE collection_papers (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(collection_id, paper_id)
);
CREATE INDEX collection_papers_user_paper_idx ON collection_papers(user_id, paper_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  parent_note_id TEXT,
  note_type TEXT NOT NULL CHECK (note_type IN ('general','page','highlight','summary','todo')),
  page_number INTEGER,
  anchor_json TEXT CHECK (anchor_json IS NULL OR json_valid(anchor_json)),
  content_markdown TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(id, user_id, paper_id),
  FOREIGN KEY(parent_note_id) REFERENCES notes(id) ON DELETE SET NULL,
  FOREIGN KEY(parent_note_id, user_id, paper_id) REFERENCES notes(id, user_id, paper_id),
  CHECK (note_type NOT IN ('page','highlight') OR (page_number IS NOT NULL AND page_number > 0))
);
CREATE INDEX notes_user_paper_updated_idx ON notes(user_id, paper_id, updated_at DESC);

CREATE TABLE paper_relations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  target_paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('preprint_of','version_of','supplement_to','duplicate_of','related')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_paper_id, target_paper_id, relation_type),
  CHECK (source_paper_id <> target_paper_id)
);
CREATE INDEX paper_relations_user_target_idx ON paper_relations(user_id, target_paper_id);

CREATE TABLE changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create','update','delete','restore')),
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  changed_at TEXT NOT NULL
);
CREATE INDEX changes_user_sequence_idx ON changes(user_id, sequence);
CREATE UNIQUE INDEX changes_paper_version_uq
  ON changes(user_id, entity_id, version)
  WHERE entity_type = 'paper';

CREATE TABLE client_mutations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_mutation_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, client_mutation_id)
);
CREATE INDEX client_mutations_created_idx ON client_mutations(created_at);

CREATE TABLE job_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_json TEXT NOT NULL CHECK (json_valid(job_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatched','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT
);
CREATE INDEX job_outbox_state_available_idx ON job_outbox(state, available_at, created_at);

CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('bibtex','csl-json','ris','csv','json','backup')),
  query_json TEXT NOT NULL CHECK (json_valid(query_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','complete','failed','expired')),
  r2_key TEXT,
  media_type TEXT,
  size_bytes INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX export_jobs_user_created_idx ON export_jobs(user_id, created_at DESC);

CREATE TABLE metadata_cache (
  cache_key TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  etag TEXT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX metadata_cache_expiry_idx ON metadata_cache(expires_at);

CREATE TABLE job_runs (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  paper_id TEXT,
  source_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','retrying','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX job_runs_user_state_idx ON job_runs(user_id, state, updated_at DESC);

CREATE TABLE rate_limits (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(scope, key_hash, window_start)
);
CREATE INDEX rate_limits_window_idx ON rate_limits(window_start);
