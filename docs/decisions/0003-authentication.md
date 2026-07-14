# ADR 0003: Cloudflare Access と extension PKCE を分離し、token hash を所有する

- Status: Accepted
- Date: 2026-07-13

## Context

Citera の本番 Web は Cloudflare Access で保護し、browser extension に対しては Citera が OAuth authorization server として動作します。拡張機能の非ブラウザ API 呼び出しは Access cookie に依存できず、bearer session token を平文で D1 に保存する設計も避ける必要があります。

## Decision

本番 Web の静的 route と identity-bootstrap endpoint は Access で保護します。Bootstrap の `Cf-Access-Jwt-Assertion` を team JWKS/RS256、issuer、application audience、time claims まで Worker でも検証し、Web には別の Citera HttpOnly cookie を発行します。API path は extension bearer を通すため Access Bypass とし、全 route を Citera cookie/bearer と resource scope で認証・認可します。Extension の対話的 authorization endpoint は Access identity を使って one-time code を発行し、PKCE S256、short access、rotating refresh credential へ交換します。D1 には `TOKEN_HASH_PEPPER` を使った token の SHA-256 hash だけを保存します。旧 Google flow はローカル互換用として本番では無効にします。

## Consequences

Access application/policy/AUD の外部設定と、実 Access JWT の staging smoke test が必要です。Rotation は `session_families` と parent/replacement lineage を増やし、旧 token replay 時に family-wide revoke するため D1 write が増えます。D1 dump に bearer plaintext がないことと、concurrent rotation/replay が active child を残さないことを security release gate にします。
