# ADR 0005: PDF 解析を browser 中心にする

- Status: Accepted
- Date: 2026-07-13

## Context

Free Workers の CPU/memory は大きな PDF parsing、thumbnail、ZIP に適しません。出版社認証 PDF は server から取得できないこともあります。

## Decision

PDF.js viewer と browser-side SHA-256 を使い、Server は magic/size/checksum/ownership の軽い verification だけを必須とします。Document Info/XMP、先頭ページ text、DOI/arXiv candidate の PDF 内抽出と heavy derived asset job は将来の client-side/optional tier とします。Current extension の DOI/arXiv 抽出元は HTML metadata/URL/page text です。

## Consequences

端末性能差があり、background processing は PWA lifecycle に影響されます。将来の抽出結果は provenance/confidence 付き candidate として扱う方針です。現在は extension が HTML/URL/page text から得た DOI input を正規化して保存し、provider lookup の成功を別の「確認済み DOI」状態としてはモデル化していません。
