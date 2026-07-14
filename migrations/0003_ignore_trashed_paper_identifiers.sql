-- Identifiers belonging to trashed papers must not block a new active paper.
-- Rebuild the table because the original table-level UNIQUE constraint cannot
-- be changed into a partial unique index in place in SQLite.
CREATE TABLE paper_identifiers_new (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL CHECK (identifier_type IN ('doi','arxiv','pmid','openalex','isbn','url')),
  normalized_value TEXT NOT NULL,
  original_value TEXT NOT NULL,
  identifier_version TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO paper_identifiers_new (
  id,user_id,paper_id,identifier_type,normalized_value,original_value,identifier_version,created_at,deleted_at
)
SELECT pi.id,pi.user_id,pi.paper_id,pi.identifier_type,pi.normalized_value,pi.original_value,
       pi.identifier_version,pi.created_at,p.deleted_at
FROM paper_identifiers pi
JOIN papers p ON p.id=pi.paper_id AND p.user_id=pi.user_id;

DROP TABLE paper_identifiers;
ALTER TABLE paper_identifiers_new RENAME TO paper_identifiers;

CREATE INDEX paper_identifiers_paper_idx ON paper_identifiers(user_id, paper_id);
CREATE UNIQUE INDEX paper_identifiers_active_user_type_value_uq
  ON paper_identifiers(user_id, identifier_type, normalized_value)
  WHERE deleted_at IS NULL;
