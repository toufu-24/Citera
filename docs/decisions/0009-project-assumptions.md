# ADR 0009: 初期リリースの仮定と完了条件

- Status: Accepted
- Date: 2026-07-13

## Assumptions

- Single owner だが schema/API は user scoped にし、将来 account が増えても isolation する。
- First browser target は Chrome/Chromium。Firefox は browser API wrapper までを初期境界とする。
- Production Web identity は Cloudflare Access に委譲し、実 Access JWT/login/logout は staging の manual check とする。
- Highlight anchor data model は作るが、初期 UI の必須完成点は page-number note。PDF overlay rendering は deferred。
- OpenAlex は provider type/interface、thumbnail/extracted-text は file/job type の拡張点だけを持つ。実 adapter、PDF text pipeline、large streaming ZIP は無料枠での計測後に実装する。

## Completion criteria for deferred items

Deferred work は理由だけの TODO にしません。各 item は (1) bounded implementation、(2) security/tenant test、(3) measured Workers budget、(4) local and production compatibility を満たした時点で ADR を更新し Accepted scope に入れます。
