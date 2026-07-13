# ADR 0001: D1 と R2 の責務を分離する

- Status: Accepted
- Date: 2026-07-13

## Context

書誌・タグ・メモは relational query/sync が必要で、PDF/derived/export は大きな byte stream です。D1 に blob を入れると row reads/storage と backup が悪化し、R2 だけでは relational ownership/filter/version を表現できません。

## Decision

D1 を metadata/source of truth、非公開 R2 を bytes に限定します。D1 `files` row が owner、kind、size、hash、generated key、verification state を保持し、paper file object の操作はこの row を介します。Export object は `export_jobs` row で追跡し、account deletion だけは durable tombstone/grace period 後に owner prefix を直接列挙して残存 object を消します。

## Consequences

両者の一時的不整合を `upload_state` と冪等 cleanup job で回復する必要があります。一方、一覧 query は blob を読まず、PDF は Worker を中継せず転送できます。
