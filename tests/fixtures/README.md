# `tests/fixtures/`

このディレクトリの JSON fixture は事業者の実レスポンス（または合成した想定レスポンス）を
保存したもので、`tests/contract/**`（task_018・重複/逆順/署名不一致の契約テスト）と
`tests/conformance/**`（task_019・ProviderConformanceKit の C1〜C31）の両方から読まれる。

## provenance（fixture の出自）は必須

`docs/implementation-plan.md` §14-4 / `docs/research/design-synthesis.md` §9-2。
すべての fixture JSON は最低限、以下の 2 フィールドを**トップレベルに snake_case で**持つ。

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `captured_from` | `"staging" \| "production" \| "vendor_doc_verbatim" \| "synthesized"` | ✅ | 事業者の実環境から捕獲したのか、一次資料の転記か、人が手で書いた想定値（`synthesized`）かを表す。 |
| `captured_at` | `"YYYY-MM-DD"` | ✅ | 取得日。`synthesized` の場合は作成日。 |
| `source_ref` | `string` | 任意 | 一次資料・キャプチャ元の説明（例: `docs/vendor-docs/<vendor>/<topic>.md`）。 |

検証は `tests/conformance/provenance.ts` の `assertFixtureProvenance()` が行う。
`tests/conformance/kit.ts` の `registerProvider()` は、この2フィールドが欠落・不正な
fixture を**登録時に拒否する**（例外を投げる。テストで固定済み:
`tests/conformance/manual-confirm.conformance.test.ts`）。

## `synthesized` のみのアダプタは `autoDetect: true` を名乗れない

`docs/research/premortem-risks.md` §3-4 G12。事業者の実レスポンスを1件も捕獲していない
（＝すべて `captured_from: "synthesized"`）アダプタは、自動検知（Webhook / 再照会での
自動確定）を名乗って `REGISTRY` に載せることができない
（`src/lib/payments/registry.ts` の `FixtureProvenance !== "captured"` ガードと同じ規則を、
`tests/conformance/kit.ts` の `registerProvider()` が fixture 登録時にも適用する）。

## ディレクトリ構成

- `tests/fixtures/fixture_provider/`: task_018 所有。`tests/contract/**` の重複・逆順・
  署名不一致テストと、task_018 完了後に追加される
  `tests/conformance/fixture-provider.conformance.test.ts`（C1〜C31・task_019 の
  `files_to_create`。現時点では未作成 — `docs/concerns/task_019.md` 参照）が読む。
  `succeeded.json` / `expired.json` / `tampered.json` / `amount-mismatch.json` /
  `disputed.json` を持つ想定。
- `tests/fixtures/fixture_provider/{refund-partial-1,refund-partial-2,orphan,underpaid}.json`
  （C4b・C21・C20 用。task_019 の `files_to_create` だが task_018 の
  `tests/contract/helpers/fixture-provider.ts`（HMAC 署名ヘルパー）が無いと正しい形式で
  作れないため、task_018 完了後に追加する。`docs/concerns/task_019.md` に deferred として
  記録済み。）

`manual_confirm`（Phase 1 の唯一の出荷アダプタ）は Webhook を受けない
（`capabilities.webhook === false`）ため、捕獲対象の HTTP レスポンス fixture を持たない。
`tests/conformance/manual-confirm.conformance.test.ts` は fixture 0 件で
`registerProvider()` に登録する。
