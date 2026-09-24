# docs/research — 計画フェーズの一次成果物（2026-09-24）

このディレクトリは `docs/implementation-plan.md` が参照する調査・設計・プレモータムの成果物を、作成当時のまま保存したもの。**参照専用。更新しない。** 最新の判断は implementation-plan.md と docs/decisions/ の ADR が正。

| ファイル | 内容 |
|---|---|
| `00-handover.md` | ユーザー提供の AI 引継ぎ書（原文）＋今回の追加要件 |
| `research-paypay.md` | PayPay: 個人間送金 API の不在、加盟店 API、加盟店資格、手数料、LINE×PayPay 連携 |
| `research-stripe.md` | Stripe: SSA 1.2(a)(i)、禁止業種、日本の C2C 条項、Connect×PayPay の記載差、Accounts v2 |
| `research-line-miniapp.md` | LINE ミニアプリ: 認証/未認証、ポリシー、決済、LIFF ID トークン検証、shareTargetPicker |
| `research-legal-jp.md` | 資金決済法 2 条の 2 / 内閣府令 1 条の 2 / 資金移動業登録要件 / 割賦販売法 / 個情法 / 特商法 |
| `research-alt-providers.md` | 代替事業者: PAY.JP / Square / KOMOJU / PayPal / 楽天銀行 API / 電子決済等代行業 / 幹事Pay |
| `research-competitors.md` | 競合: PayPay グループ支払い、LINE 内送金、Peatix / PassMarket / connpass、6 軸比較 |
| `research-tech-stack.md` | Next.js / Vercel / Supabase / LIFF 認証統合 / Webhook 冪等 / テスト手段。**ホスティングは Vercel を推奨していたが、PO 指示により Cloudflare Workers を採用（ADR-012）。この調査のホスティング節は不採用の根拠として残す** |
| `consolidated.md` | 統合調査。§3 反証で訂正された主張、§5 照会事項、§6 設計制約 L/P/W/N/I、§7 自動チェック要件への回答 |
| `design-arch-A.md` / `-B.md` / `-C.md` | アーキテクチャ案（MVP-first / Risk-first / Extensibility-first） |
| `design-team-T1.md` / `-T2.md` | チーム/ハーネス案（ソロ＋AI 最大活用 / 品質ゲート駆動） |
| `design-synthesis.md` | 最終設計ブリーフ（勝者 arch-C ＋ team-T2）。DDL 全文は §2-2。**プレモータムで誤りと裁定された記述（SameSite=Lax、ゲートを全入口に、RLS deny-all＋service role、nonce 検証、C5 台帳に書かない、PreCompact、CODEOWNERS 承認、3 者全会一致）を含むため、implementation-plan.md §1 と `premortem-risks.md` §0 / §2 を優先する** |
| `premortem-risks.md` | 8 レンズのプレモータム統合リスク台帳（118 件 → 86 件。S1 42 / S2 42 / S3 2） |
| `premortem-raw.json` | 8 レンズの生出力（118 件） |

- 反証検証のカバレッジ: 3 レンズ反証検証を通った主張は一部のみで大半は未検証。ワークフロー実行時の集計では 105 件中 16 件と記録したが、集計の原本は保存しておらず再現できない [不明]。リポジトリに現存する記録は `consolidated.md` §0-4 の自己申告「82 件中 18 件」と、同 §3 が claim ID 付きで残す 14 件のみで、三つの数は一致しない。
- 決済事業者・LINEヤフー・弁護士への照会は 0 件。
- プレモータムの 2 レンズ（legal-compliance / team-harness）は gemini-cli MCP 経由で、ツール応答は実モデルが gemini-3.5-flash にフォールバックしたと明示している。
