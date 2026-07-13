# ADR 0002: 同期に単調増加 change log を使う

- Status: Accepted
- Date: 2026-07-13

## Context

複数端末、offline outbox、soft delete を同期する必要があります。initial version に WebSocket/CRDT は過大で、updated_at polling だけでは同時刻・delete・pagination gap を安全に扱えません。

## Decision

D1 の entity mutation と同じ atomic batch で `changes` row と response snapshot/tombstone を追加することを設計原則とします。Client は per-user sequence cursor で pull し、`client_mutations` が replay を deduplicate します。

## Consequences

Change log の retention/compaction が必要です。現在は一部 route が entity/change/result を段階的に書くため、この atomicity 原則は未完了です。Note conflict-copy utility も runtime Outbox には未接続で、current API は version conflict を返します。
