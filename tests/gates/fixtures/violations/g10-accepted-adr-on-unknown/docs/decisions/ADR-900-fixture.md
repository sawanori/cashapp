# ADR-900: 違反フィクスチャ用の ADR（[不明] 依存のまま accepted）

- ステータス: accepted
- Confidence: low
- 関連: tests/gates/fixtures/violations/README.md

## Context

決済事業者の Webhook 署名方式は [不明] のままである。照会（Q-PP3）の回答は返っていない。

## Decision

回答を待たずに署名方式を確定したものとして扱い、この ADR を `accepted` にする。

これは違反フィクスチャである。G10 は「[設計] / [不明] に依存した ADR が accepted になっていないこと」を
検査するので、このファイルは必ず検出されなければならない。
