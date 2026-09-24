# docs/gates/ — ゲート台帳

## 正本は JSON、DB は射影

`docs/gates/*.json` がゲートの**正本**（Git 管理・PR 対象）である。ランタイムの
`compliance_gate` テーブルは、デプロイ時にこれらの JSON から同期される**射影**にすぎず、
DB 側を直接書き換えてもゲートの真の状態は変わらない（次回同期で JSON の値に上書きされる）。

同期は `scripts/gates-sync.mjs`（task_011 で作成）が担い、JSON と DB の差分を検査する。
`npm run gates:sync` が差分 0 であることを CI・統合テストの合格条件にする。

出典: `docs/implementation-plan.md` §4-1「ゲートの正本は `docs/gates/*.json`（Git 管理・PR
対象）。DB の `compliance_gate` はデプロイ時に JSON から同期される射影」。

## 変更は PO のみ

`docs/gates/**` への変更（`compliance-gates.json` の `status` / `evidence_uri` /
`approved_by` / `valid_until`、`legal-clearance.json` の `cleared`、`release-mode.json` の
`payments_enabled` を含む）は **PO（noritaka）のみ**が行う。

- `scripts/deny-test-weakening.sh`（PreToolUse、task_005）が `docs/gates/**` への Edit /
  Write / MultiEdit 経由の直接書き込みを拒否する。
- `scripts/deny-dangerous-bash.sh`（PreToolUse、task_005）が `docs/gates/**` への Bash 経由
  の書き込み（リダイレクト・`sed -i`・`cp`/`mv` の宛先など）を拒否する。
- `scripts/gate-integrity.mjs`（task_006）が `docs/gates/**` のハッシュを基準値と照合する。
- CODEOWNERS（task_009）で `docs/gates/**` への変更に PO のレビューが要求される。

出典: `docs/implementation-plan.md` §11-1「`docs/gates/legal-clearance.json` /
`compliance-gates.json` / `release-<version>.json`｜ゲートの正本。`cleared` の変更は PO
のみ｜**high**」、§16-6「本リポジトリで人間（PO）が実際に関与する関門は 3 つだけである:
① `docs/gates/legal-clearance.json` / `release-mode.json` / `compliance-gates.json` の変更、
② ADR の `accepted` 化、③ 実機確認とパイロット。」

エージェント（AI）は `status` を `passed` に書き換えられない。エージェントの役割は、照会
（`docs/external-inquiries.json`）の起案・送付準備・回答の転記案の提示までであり、ゲートの
可否判断そのものは行わない。

## このディレクトリのファイル

| ファイル | 作成タスク | 内容 |
|---|---|---|
| `compliance-gates.json` | task_036（本ファイル群） | 10 ゲートの台帳。フィールド定義は同ファイル内の `gate_schema` を参照 |
| `legal-clearance.json` | task_005 | `{ cleared, basis, approved_by, approved_at }`。`release.yml` の決済有効化ゲートが参照する |
| `release-mode.json` | task_009 | `{ payments_enabled, provider_keys, basis, approved_by }`。決済なし本番デプロイを通す 1 段目のゲート |
| `release-<version>.json` | task_008 (release-audit workflow) | リリースごとの監査記録（独立 2 ベンダー以上の go かつ no-go ゼロ、または PO の明示承認） |
| `integrity-baseline.json` | task_006 | `gate-integrity.mjs` が照合するハッシュ基準値 |

本タスク（task_036）が作るのは `compliance-gates.json` のみ。上表の他ファイルは各担当タスク
が別途作成する（このディレクトリと同じ PO 限定変更規約に従う）。

## compliance-gates.json の読み方

各エントリの `status` は次の 5 値のいずれか（初期値はすべて `unknown`）。

| status | 意味 |
|---|---|
| `unknown` | 未照会・未判定（初期値） |
| `inquired` | 照会は送付済みだが確定回答待ち |
| `passed` | ゲート通過。`evidence_uri` が必須（DB 側 `CHECK (status <> 'passed' OR evidence_uri IS NOT NULL)` に対応） |
| `failed` | ゲート不通過。当該フェーズの機能は縮退・停止する |
| `n/a` | 対象外（構成変更等によりこのゲートを要さなくなった場合） |

`status` を `unknown` から動かす判断（`inquired`→`passed`/`failed` を含む）は PO が
`docs/external-inquiries.json` の回答受領後に行う（task_037）。AI エージェントはこの JSON
に対して読み取りと差分検知（`gates:sync`、`gate:compliance-freshness`）のみを行う。

`required_for` は `["phase1"]` / `["phase2"]` / 両方のいずれか。`GATE-LINE-POLICY` と
`GATE-LEGAL-PII` は Phase 1 の必須ゲートだが、招待制クローズドβ（幹事 3〜5 名・参加者同意
済み）に限定する場合に限り Phase 1 リリースの前提から一時的に免除できる（ADR に記録。一般
公開時には必須。出典: `docs/implementation-plan.md` §18-2）。
