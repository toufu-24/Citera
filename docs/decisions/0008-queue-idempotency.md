# ADR 0008: Queue side effect を D1 idempotency key で保護する

- Status: Accepted
- Date: 2026-07-13

## Context

Cloudflare Queues は at-least-once で duplicate/retry が正常に起こります。External metadata call、file state、export object を複数回生成してはいけません。

## Decision

Producer は domain state/change と unique `job_outbox` row を同じ D1 batch に入れ、response path の `waitUntil` で即時 dispatch を試します。失敗した pending row は Jobs Worker の hourly Cron が同じ Queue producer binding から再送します。

Consumer は schema-valid message の export/file/paper/user ID から `type:entityId:sourceVersion` key を導出し、D1 `job_runs` unique row で lease/checkpoint/terminal state を保持します。新しい `running` lease は遅延 retry、stale lease は CAS で reclaim します。成功 message は individual ack、transient failure は capped exponential retry、permanent handler failure と application retry exhaustion は record + ack とします。Trustworthy owner/idempotency identity を得られない schema-invalid envelope は log + ack します。DLQ は Queue-level delivery failure の guard とし、application terminal state は D1 に残します。

Account deletion は `users.deletion_requested_at` と monotonic generation を先に commit して auth と非 deletion job を fence します。Consumer は最大 15 分の signed URL と通常 15 分 lease を覆う 20 分を待ち、他の running job がなければ owner R2 prefix と D1 user を削除します。Hourly Cron は terminal/stale deletion attempt に新しい generation/outbox row を発行し、古い generation の conditional delete を無効化します。

## Consequences

Handler は replay-safe upsert/conditional write に制限されます。Outbox には storage/write cost と最大1時間の fallback dispatch delay があり、account deletion は安全な grace/recovery のためさらに遅延し得ます。Cron 監視が必要です。DLQ retention を durable record とみなさず、D1 を運用画面の source とします。
