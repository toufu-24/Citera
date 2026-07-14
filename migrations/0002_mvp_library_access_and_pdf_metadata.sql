PRAGMA foreign_keys = ON;

CREATE TABLE libraries (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal','shared')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE library_members (
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (library_id, user_id)
);
CREATE INDEX library_members_user_idx ON library_members(user_id, status);

ALTER TABLE users ADD COLUMN access_issuer TEXT;
ALTER TABLE users ADD COLUMN access_subject TEXT;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
CREATE UNIQUE INDEX users_access_identity_uq
  ON users(access_issuer, access_subject)
  WHERE access_issuer IS NOT NULL AND access_subject IS NOT NULL;
CREATE INDEX users_status_idx ON users(status);

ALTER TABLE papers ADD COLUMN library_id TEXT;
ALTER TABLE papers ADD COLUMN reading_status TEXT NOT NULL DEFAULT 'unread';
ALTER TABLE papers ADD COLUMN note_markdown TEXT;

INSERT INTO libraries (id, kind, name, created_at)
SELECT 'lib_' || substr(u.id, 5), 'personal',
       CASE WHEN trim(u.display_name) <> '' THEN u.display_name || ' library' ELSE 'Personal library' END,
       u.created_at
FROM users u
WHERE u.id LIKE 'usr_%'
  AND NOT EXISTS (SELECT 1 FROM libraries l WHERE l.id = 'lib_' || substr(u.id, 5));

INSERT INTO library_members (library_id, user_id, role, status, created_at)
SELECT 'lib_' || substr(u.id, 5), u.id, 'owner', 'active', u.created_at
FROM users u
WHERE u.id LIKE 'usr_%'
  AND EXISTS (SELECT 1 FROM libraries l WHERE l.id = 'lib_' || substr(u.id, 5))
  AND NOT EXISTS (
    SELECT 1 FROM library_members m
    WHERE m.library_id = 'lib_' || substr(u.id, 5) AND m.user_id = u.id
  );

UPDATE papers
SET library_id = 'lib_' || substr(user_id, 5),
    reading_status = CASE status
      WHEN 'reading' THEN 'reading'
      WHEN 'read' THEN 'read'
      WHEN 'archived' THEN 'on_hold'
      ELSE 'unread'
    END
WHERE library_id IS NULL;

CREATE INDEX papers_library_created_idx ON papers(library_id, created_at DESC, id DESC);
CREATE INDEX papers_library_status_idx ON papers(library_id, reading_status, updated_at DESC, id DESC);

ALTER TABLE files ADD COLUMN label TEXT;
ALTER TABLE files ADD COLUMN file_kind TEXT NOT NULL DEFAULT 'fulltext';
ALTER TABLE files ADD COLUMN language_code TEXT;
ALTER TABLE files ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE files
SET file_kind = CASE WHEN kind = 'supplement' THEN 'supplement' ELSE 'fulltext' END
WHERE file_kind = 'fulltext';

UPDATE files
SET is_default = 1
WHERE id IN (
  SELECT f.id
  FROM files f
  WHERE f.upload_state = 'verified'
    AND f.deleted_at IS NULL
    AND f.id = (
      SELECT f2.id
      FROM files f2
      WHERE f2.paper_id = f.paper_id
        AND f2.upload_state = 'verified'
        AND f2.deleted_at IS NULL
      ORDER BY f2.created_at ASC, f2.id ASC
      LIMIT 1
    )
);

CREATE INDEX files_paper_kind_order_idx ON files(paper_id, file_kind, sort_order, created_at);
CREATE UNIQUE INDEX files_one_default_per_paper_uq
  ON files(paper_id)
  WHERE is_default = 1 AND deleted_at IS NULL;

ALTER TABLE tags ADD COLUMN library_id TEXT;
UPDATE tags SET library_id = 'lib_' || substr(user_id, 5) WHERE library_id IS NULL;
CREATE INDEX tags_library_name_idx ON tags(library_id, normalized_name);

ALTER TABLE paper_tags ADD COLUMN library_id TEXT;
UPDATE paper_tags SET library_id = 'lib_' || substr(user_id, 5) WHERE library_id IS NULL;
CREATE INDEX paper_tags_library_tag_paper_idx ON paper_tags(library_id, tag_id, paper_id);

ALTER TABLE notes ADD COLUMN library_id TEXT;
UPDATE notes SET library_id = 'lib_' || substr(user_id, 5) WHERE library_id IS NULL;
CREATE INDEX notes_library_paper_idx ON notes(library_id, paper_id, updated_at DESC);
