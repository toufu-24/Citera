-- Development-only sample data. This file intentionally lives outside migrations/.
INSERT OR IGNORE INTO users (id, email, display_name, avatar_url, created_at, updated_at)
VALUES ('usr_01J00000000000000000000000', 'demo@citera.local', 'Citera Demo', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO papers (
  id, user_id, title, abstract, publication_year, publication_date, venue, paper_type,
  status, priority, rating, read_progress, source_url, metadata_state, search_text,
  version, created_at, updated_at
) VALUES (
  'pap_01J00000000000000000000000',
  'usr_01J00000000000000000000000',
  'Attention Is All You Need',
  'A seeded record for local Citera development.',
  2017,
  '2017-06-12',
  'NeurIPS',
  'paper-conference',
  'reading',
  1,
  5,
  0.35,
  'https://arxiv.org/abs/1706.03762',
  'complete',
  'attention is all you need neurips 1706.03762',
  1,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO paper_identifiers (
  id, user_id, paper_id, identifier_type, normalized_value, original_value, identifier_version, created_at
) VALUES (
  'pid_01J00000000000000000000000',
  'usr_01J00000000000000000000000',
  'pap_01J00000000000000000000000',
  'arxiv',
  '1706.03762',
  'arXiv:1706.03762v7',
  'v7',
  '2026-01-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO tags (id, user_id, name, normalized_name, color, created_at, updated_at)
VALUES (
  'tag_01J00000000000000000000000',
  'usr_01J00000000000000000000000',
  'Machine Learning',
  'machine learning',
  '#635bff',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO paper_tags (user_id, paper_id, tag_id, created_at)
VALUES (
  'usr_01J00000000000000000000000',
  'pap_01J00000000000000000000000',
  'tag_01J00000000000000000000000',
  '2026-01-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO collections (id, user_id, name, description, parent_id, created_at, updated_at, deleted_at)
VALUES (
  'col_01J00000000000000000000000',
  'usr_01J00000000000000000000000',
  'Reading queue',
  'Seeded local collection',
  NULL,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  NULL
);

INSERT OR IGNORE INTO collection_papers (user_id, collection_id, paper_id, created_at)
VALUES (
  'usr_01J00000000000000000000000',
  'col_01J00000000000000000000000',
  'pap_01J00000000000000000000000',
  '2026-01-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO notes (
  id, user_id, paper_id, note_type, content_markdown, version, created_at, updated_at
) VALUES (
  'not_01J00000000000000000000000',
  'usr_01J00000000000000000000000',
  'pap_01J00000000000000000000000',
  'general',
  'Seeded **Markdown** note.',
  1,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO changes (user_id, entity_type, entity_id, operation, version, data_json, changed_at)
VALUES (
  'usr_01J00000000000000000000000',
  'paper',
  'pap_01J00000000000000000000000',
  'create',
  1,
  '{"id":"pap_01J00000000000000000000000","title":"Attention Is All You Need","version":1}',
  '2026-01-01T00:00:00.000Z'
);
