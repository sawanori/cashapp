# 文言ポリシー（禁止語・許可文言）

`npm run gate:wording`（`scripts/wording-lint.mjs`）が機械検査する正本。人が読む説明と、リンタが読む機械可読ブロックを同じファイルに置く。

## 1. なぜ禁止するか

| 群 | 何を避けるか | 根拠 |
|---|---|---|
| 自動確認の断定 | Phase 1 の唯一の出荷アダプタは `manual_confirm` であり、支払いの確認は幹事の手作業である。これを「自動チェック」「自動で確認」「入金を確認しました」と書くと、実装していない機能を約束したことになる | `docs/research/premortem-risks.md` R-LAW-03 / R-LAW-12 / R-PAY-14、`docs/implementation-plan.md` §7-6（非自動ラベルの 8 層） |
| 寄付・募金の文脈 | LINE ミニアプリの禁止業種に該当しうる。サービス定義は「幹事が管理する精算・集金の台帳」に統一する | `docs/research/consolidated.md` §6-4 N11 |
| 支援・応援 | 対価性のない金銭授受を連想させ、寄付・募金と同じ判断を招く | 同上（N11 の拡張語彙） |
| 領収書・インボイス | 運営者は資金を経由しないため、運営者名義で発行できる証憑は存在しない。適格請求書は登録事業者のみが発行できる | `docs/implementation-plan.md` §18-4 |
| 加盟店審査の手引き | 「記入例」「審査の通し方」は、幹事が決済事業者へ行う申告内容への助言になり、運営者が審査結果に責任を負う立場に立つ | `docs/research/premortem-risks.md` R-LAW-12 |
| 未確定手数料の確定表示 | 決済手数料は事業者との契約が未確定であり（`docs/research/consolidated.md` §5）、具体的な率や金額を断定表示すると景表法上の問題になる | `docs/implementation-plan.md` §18-3 |

## 2. 禁止語

- **自動確認の断定**: 自動チェック / 自動で確認 / 自動照合 / 入金を確認しました
  - 「自動照合」は否定形（「自動照合ではありません」）でのみ使ってよい。§4 の許可文言に載っている形に限る。
- **寄付・募金の文脈**: 寄付 / 募金 / 投げ銭 / カンパ / クラウドファンディング / チャリティ / ドネーション
- **対価性を薄める語**: 支援 / 応援
- **証憑**: 領収書 / インボイス / 適格請求書
- **加盟店審査の手引き**（配布テンプレ・パイロット資料のみ対象）: 記入例 / 審査の通し方 / 審査を通す
- **未確定手数料の確定表示**: 「手数料」と具体的な率（`3.8%`）・金額（`50円`）・「無料」を同一文内で並べる表現

## 3. 検査対象

`docs/research/**` と `docs/inquiries/**` は対象外（一次資料と照会文は原文のまま保持する必要があるため）。本ファイル自身とリンタ・そのテストも対象外。

| 対象 | glob | いつから対象ファイルが存在するか |
|---|---|---|
| UI 文言・配布テンプレ | `src/**/*.ts` / `src/**/*.tsx` | いま（`expect_targets: now`） |
| 規約・プライバシーポリシー草案 | `src/content/**/*.md` | task_021 |
| パイロット資料 | `docs/pilot/**/*.md` | task_025 |

対象ファイルが 0 件のまま合格するゲートは禁止する（R-TH-01）。`expect_targets: now` の項目で対象 0 件なら `exit 1`。`from_task_XXX` の項目は当該タスクが DONE になるまで 0 件を許容する。

## 4. 許可文言

禁止語と重なる表現でも、以下の形であれば使ってよい。リンタは許可文言の内側に収まる一致を違反として数えない。

- 幹事が受け取ったと申告
- あなたの申告を幹事が確認中です
- 会費受領記録
- 自動照合ではありません
- 幹事が手動で確認

## 5. 機械可読ブロック

`scripts/wording-lint.mjs` はこのファイルの以下のブロックだけを読む。ここを変えるとゲートの挙動が変わる。

正規表現の方言は **JavaScript の `RegExp`**（`u` フラグなし・`gm` で実行）。`regex: true` を持たない項目の `patterns` はリテラル文字列として扱い、リンタ側でエスケープする。

<!-- machine-readable:begin -->
```json
{
  "version": 1,
  "global_exclude_globs": [
    "node_modules/**",
    ".next/**",
    ".open-next/**",
    ".wrangler/**",
    "docs/research/**",
    "docs/inquiries/**",
    "docs/wording-policy.md",
    "scripts/wording-lint.mjs",
    "tests/unit/wording-lint.test.ts",
    "tests/gates/fixtures/**"
  ],
  "allowed_phrases": [
    "幹事が受け取ったと申告",
    "あなたの申告を幹事が確認中です",
    "会費受領記録",
    "自動照合ではありません",
    "幹事が手動で確認"
  ],
  "forbidden": [
    {
      "id": "W-AUTO",
      "label": "自動確認の断定",
      "patterns": ["自動チェック", "自動で確認", "自動照合", "入金を確認しました"],
      "globs": ["src/**/*.ts", "src/**/*.tsx", "src/content/**/*.md", "docs/pilot/**/*.md"],
      "expect_targets": "now",
      "reason": "Phase 1 の確認は幹事の手作業（manual_confirm）であり、自動確認を断定すると未実装の機能を約束したことになる（R-LAW-03 / R-PAY-14）"
    },
    {
      "id": "W-DONATION",
      "label": "寄付・募金の文脈",
      "patterns": ["寄付", "募金", "投げ銭", "カンパ", "クラウドファンディング", "チャリティ", "ドネーション"],
      "globs": ["src/**/*.ts", "src/**/*.tsx", "src/content/**/*.md", "docs/pilot/**/*.md"],
      "expect_targets": "now",
      "reason": "LINE ミニアプリの禁止業種に該当しうる。サービス定義は精算・集金の台帳に統一する（N11）"
    },
    {
      "id": "W-SUPPORT",
      "label": "対価性を薄める語",
      "patterns": ["支援", "応援"],
      "globs": ["src/**/*.ts", "src/**/*.tsx", "src/content/**/*.md", "docs/pilot/**/*.md"],
      "expect_targets": "now",
      "reason": "対価性のない金銭授受を連想させ、寄付・募金と同じ判断を招く（N11 の拡張語彙）"
    },
    {
      "id": "W-RECEIPT",
      "label": "証憑",
      "patterns": ["領収書", "インボイス", "適格請求書"],
      "globs": ["src/**/*.ts", "src/**/*.tsx", "src/content/**/*.md", "docs/pilot/**/*.md"],
      "expect_targets": "now",
      "reason": "運営者は資金を経由しないため運営者名義の証憑を発行できない（L1・§18-4）"
    },
    {
      "id": "W-MERCHANT-GUIDE",
      "label": "加盟店審査の手引き",
      "patterns": ["記入例", "審査の通し方", "審査を通す"],
      "globs": ["src/content/**/*.md", "docs/pilot/**/*.md"],
      "expect_targets": "from_task_025",
      "reason": "幹事が決済事業者へ行う申告内容への助言になり、運営者が審査結果に責任を負う立場に立つ（R-LAW-12）"
    },
    {
      "id": "W-FEE-FIXED",
      "label": "未確定手数料の確定表示",
      "patterns": [
        "手数料[^。\\n]{0,16}[0-9０-９]+(\\.[0-9０-９]+)?\\s*[%％]",
        "[0-9０-９]+(\\.[0-9０-９]+)?\\s*[%％][^。\\n]{0,16}手数料",
        "手数料[^。\\n]{0,16}[0-9０-９,，]+\\s*円",
        "手数料[^。\\n]{0,8}(無料|0円|ゼロ)"
      ],
      "regex": true,
      "globs": ["src/**/*.ts", "src/**/*.tsx", "src/content/**/*.md", "docs/pilot/**/*.md"],
      "expect_targets": "now",
      "reason": "決済事業者との契約が未確定で手数料は確定していない（§18-3）。率・金額・無料の断定を禁止する"
    }
  ]
}
```
<!-- machine-readable:end -->

## 6. 変更手順

1. このファイルの §2 と §5 の機械可読ブロックを同時に更新する（片方だけの更新を禁止する）。
2. `npm run gate:wording` を `scripts/record-run.sh <task_id> npm run gate:wording` 経由で実行し、exit code を `docs/run-log/` に残す。
3. 禁止語を緩める変更は `docs/HANDOFF.md` に理由を記録する。
