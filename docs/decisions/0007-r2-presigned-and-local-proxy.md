# ADR 0007: 本番は R2 presigned URL、local は authenticated proxy を使う

- Status: Accepted
- Date: 2026-07-13

## Context

R2 binding は object access を提供しますが S3 presign credential は提供しません。Presigned URL は remote S3 endpoint 専用で、Miniflare local R2 に対応する S3 endpoint は公式にありません。

## Decision

Production adapter は bucket-scoped R2 access key と `aws4fetch` で exact GET/PUT SigV4 URL を数分だけ発行します。PUT は method/key/type/checksum/`If-None-Match` と申告した実 `Content-Length` を署名します。`Content-Length` は browser JavaScript が設定できない forbidden header なので returned client headers から除き、Blob/ArrayBuffer body から user agent が導出する値を R2 に検証させます。Local/test adapter は同じ auth/ownership/size validation を通る Worker PUT/Range GET を R2 binding へ proxy します。Mode は explicit environment で選び、local から production bucket へ silently write しません。

## Consequences

Production-only smoke test が必要です。実 browser と remote R2 で、body-derived `Content-Length` が signed value と一致する PUT の成功と、異なる body length/key/header の拒否を確認します。Complete endpoint も defense in depth として actual size、required SHA-256 checksum、magic を再検証し、不一致 object を削除します。
