# ADR 0006: 初期検索は索引付き正規化列 + LIKE を使う

- Status: Accepted
- Date: 2026-07-13

## Context

FTS5 は強力ですが D1/local version、tokenizer、migration/trigger behavior を継続検証する必要があります。初期個人 library は bounded data size です。

## Decision

MVP は `papers.search_text` と、title/venue/identifier/tag/author/note の既存正規化値または本文に対する scoped LIKE/EXISTS、user-first indexes、bounded pagination を使います。重要 query の `EXPLAIN QUERY PLAN` を release review で確認します。

## Consequences

Large library の ranking/full text は限定的です。Query-plan fixture の自動 test は未実装です。P95 query latency、rows read、library size が設定閾値を超え、production/local FTS migration test が安定した時点で FTS5 adapter へ移行します。
