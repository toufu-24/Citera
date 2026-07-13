# ADR 0004: D1 schema に Drizzle ORM を使う

- Status: Accepted
- Date: 2026-07-13

## Context

Web/API/Queue で TypeScript type と migration を保ちつつ、D1 binding の prepared/batch semantics と query plan を利用したい状況です。

## Decision

Drizzle SQLite schema/migration generation を採用し、現在の runtime query は明示 D1 prepared statement を使います。Performance/security critical query は SQL と `EXPLAIN QUERY PLAN` を確認する方針です。Migration SQL は commit し、不変にします。

## Consequences

Drizzle schema も raw SQL も user scoping を自動保証しません。Route/helper で userId を必須にし、integration isolation test を release gate とします。Query-plan regression test はまだ自動化されていません。
