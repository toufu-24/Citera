# ADR 0003: Social OAuth と extension PKCE を分離し、token hash を所有する

- Status: Accepted
- Date: 2026-07-13

## Context

Citera は Google の OAuth client であると同時に、browser extension の OAuth authorization server です。一般的な auth framework の session schema は bearer session token を D1 に保存することがあり、「平文 token を保存しない」要件と衝突します。

## Decision

Upstream Google authorization code flow の protocol helper は Arctic を使い、Citera が D1 の hashed state、PKCE verifier、nonce を検証します。ID token は Hono `verifyWithJwks` で Google JWKS/RS256、issuer、client-ID audience、time claims を検証し、nonce と `userinfo` subject も一致させます。Session/token persistence は小さな adapter が所有し、D1 には `TOKEN_HASH_PEPPER` を使った SHA-256 hash だけを保存します。Extension は one-time code + PKCE S256、short access、rotating refresh credential を使います。個人 deployment は `OWNER_EMAIL` を必須運用設定とします。

## Consequences

Auth framework の turnkey schema より code/test が増えます。Google/JWKS の実 smoke test は secret/callback 登録が必要な manual deployment check です。Rotation は `session_families` と parent/replacement lineage を増やし、旧 token replay 時に family-wide revoke するため D1 write が増えます。D1 dump に bearer plaintext がないことと、concurrent rotation/replay が active child を残さないことを security release gate にします。
