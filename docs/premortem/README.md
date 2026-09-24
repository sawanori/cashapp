# docs/premortem/

フェーズ境界で回すプレモータムの出力置き場。1 回の実行につき 1 ファイル、`YYYY-MM-DD.json`（UTC）で残す。

生成するのは `.claude/workflows/premortem.ts`（Workflow ツール）である。起案は `.claude/agents/premortem-facilitator.md`、反証は GPT、照合は Gemini という役割分担は `docs/implementation-plan.md` §16-2 に従う。

## このディレクトリに入るもの・入らないもの

| | 置き場 | 誰が書くか |
|---|---|---|
| リスク台帳の正本（86 件） | `docs/research/premortem-risks.md` | PO。**エージェントは書き換えない** |
| 各回の**差分だけ**（新規と再掲の一覧） | `docs/premortem/<date>.json` | `premortem.ts` の畳み込みエージェント |

正本を毎回書き足すと台帳が雪だるま式に膨らみ、どれが今回の発見かが読めなくなる（R-TH-09）。だから各回の出力は差分だけをここに置き、正本へ取り込むかどうかは PO が判断する。

## 実行

```
Workflow({ name: "premortem", args: { phase: "Phase 1 実装", scope: "src/lib/payments/** の差分" } })
```

`args` は次の 4 つ。すべて省略できる。

| キー | 既定 | 意味 |
|---|---|---|
| `date` | 実行時に `date -u +%Y-%m-%d` を 1 回叩いて確定 | 出力ファイル名に使う UTC 日付 |
| `phase` | `（フェーズ指定なし）` | 対象フェーズの名前。出力にそのまま入る |
| `scope` | `リポジトリ全体の現在の差分` | 4 レンズが読む範囲 |
| `dryRun` | `false` | `true` ならファイルを書かず、書くはずだった内容だけを返す |

Workflow スクリプトは `Date.now()` / `new Date()` を使えない（resume が壊れるため）。日付を固定したいときは `args.date` に `YYYY-MM-DD` を渡す。

## 4 レンズ

`docs/task-list.json` の task_008 の scope が定める 4 本を並列で回す。`.claude/agents/premortem-facilitator.md` の 4 レンズをこの名前に割り付けている。

| key | 担当範囲 |
|---|---|
| `legal` | 資金決済法・特商法・個人情報保護法・LINE の各規約。「幹事個人が受け取る」線引きが崩れる瞬間 |
| `payment` | 資金・冪等・順序・鍵。二重請求、取りこぼし、Webhook の順序逆転、台帳の不一致 |
| `platform` | LINE 審査・LIFF・Cloudflare Workers の制約・決済事業者の停止、および運用負荷・問い合わせ・離脱 |
| `harness` | ハーネス自体の失敗（F1〜F13）・DB・インフラ。「検査しているつもりで何も検査していない」状態 |

`platform` は `premortem-facilitator.md` の 3 本目（ops-support / ux-adoption）とプラットフォーム側の制約を 1 本にまとめたものである。レンズ名の対応が変わるときは両方を直す。

## 出力の形

```json
{
  "date": "2026-09-24",
  "generated_at": "2026-09-24T00:00:00Z",
  "phase": "Phase 1 実装",
  "scope": "src/lib/payments/** の差分",
  "baseline": "docs/research/premortem-risks.md",
  "baseline_count": 86,
  "missing_lenses": [],
  "g11": { "blocked": false, "unaddressed_high": [] },
  "new_items": [
    {
      "id": "P-2026-09-24-01",
      "lens": "payment",
      "failure_mode": "……",
      "trigger_moment": "……",
      "what_happens": "……",
      "detection_signal": "機械で取れる値",
      "countermeasure": "……",
      "degraded_mode": "……",
      "severity": "S1",
      "confidence": "high"
    }
  ],
  "restated": [{ "risk_id": "R-PAY-14", "status_change": "なし", "lens": "payment" }]
}
```

`new_items` は 7 項目（`failure_mode` / `trigger_moment` / `what_happens` / `detection_signal` / `countermeasure` / `degraded_mode` / `severity` と `confidence`）がすべて埋まったものだけを載せる。1 つでも欠けるものは載せない。`detection_signal` が「注意深く見る」のような人手依存のものも載せない。

`missing_lenses` は結果を返さなかったレンズである。**空でないときは「4 レンズで見た」と書いてはならない。** 欠測は欠測として残す。

## G11（新規着手の停止）

前回の high が未対応のまま 3 件以上あるとき、`g11.blocked` が `true` になり、実行結果の `headline` の先頭で新規着手の停止を宣言する。判定は `npm run gate:check` の G11 と同じ趣旨だが、こちらはプレモータムの起案側から見た値であり、ゲートの代わりにはならない。

## してはいけないこと

- `docs/research/premortem-risks.md` を書き換えない（追記の可否は PO の判断）
- `docs/gates/**` を書き換えない（F13）
- ユニーク検出が 0 件のときに既存項目の言い換えで水増ししない。0 件ならそう書く
- 同じ日に 2 回回したとき、既存ファイルを上書きせずに `new_items` を差分追記する
