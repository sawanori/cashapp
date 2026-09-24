# ADR-013: `(web)` ルートグループは「退避先」ではなく、静的法務ページと管理者画面の置き場である

- ステータス: proposed（`GATE-LINE-POLICY` / Q-LN2 の回答が未着のため `accepted` にしない。G10）
- Confidence: high（決定の内容は計画本文に明記済み。未確定なのは前提条件である Q-LN2 の回答だけ）
- 関連: implementation-plan.md §4-4, §5, §7-3, A7, §16-6 / premortem-risks.md R-LINE-05, R-LINE-04
  / task_013, task_021, task_022 / check_079

## Context

`docs/research/premortem-risks.md` の R-LINE-05 は、LINE ミニアプリポリシーの「有料サービスの
販売にはアプリ内課金機能を利用しなければならない」条項に会費徴収が該当すると解釈された場合、
ミニアプリという配布形態そのものが崩れると指摘した。その緩和策として R-LINE-05 は

> LIFF 依存コードを `src/lib/liff/` と `src/app/(liff)` の 1 系統に隔離し、`src/app/(web)` を
> 並置して「LINE を外しても名簿・請求・手動確認が動く」ことを `npm run build:web-only` で
> 機械的に維持する

と書いた。**この後半は Phase 1 では実現しない。** 計画本文（§4-4 / §7-3 / A7 の退避欄）は
プレモータムのこの一文を明示的に絞り込み、次のように裁定している。

> `(web)` は管理者画面と静的法務ページ（O-13 相当の運営者情報・規約・プライバシー）のみ。
> LINE 非依存の幹事・参加者導線は Phase 1 では作らない（ADR-013、§5）。
> `build:web-only` は LINE SDK 無しでビルドが通ることの担保。

> **LINE 非依存の幹事・参加者導線は Phase 1 では未実装のため、退避には別計画（画面層と
> セッション層の作り直し、所要は Phase 1 相当）が要る（ADR-013）。`build:web-only` は
> ビルドが LINE SDK 無しで通ることの担保にすぎない**

本 ADR はこの絞り込みを決定として記録し、`(web)` を「いざとなれば切り替えられる退避先」と
読み違える経路を塞ぐ。

## Decision

1. `src/app/(liff)` と `src/app/(web)` を **並置**する。LIFF 依存コードは
   `src/lib/liff/**` と `src/app/(liff)/**` の 2 か所にだけ置く。
2. Phase 1 の `(web)` に置くのは次の 2 つだけである。
   - 静的な法務ページ（運営者情報・利用規約・プライバシーポリシー。O-13 相当。task_021）
   - 管理者画面（別 IdP・lookup・anonymize/export。task_021）
3. **幹事・参加者の集金導線の LINE 非依存版を Phase 1 では作らない。**
   名簿・請求・手動確認・配布・支払いの各画面は `(liff)` にのみ存在する。
4. `npm run build:web-only`（`scripts/build-web-only.mjs`）が担保するのは次の 4 点に限る。
   - `package.json` の `build` / `build:cf` が `NEXT_PUBLIC_LIFF_MOCK=0` に**固定**していること
     （下の「畳み込みの条件」。未定義だとモックが本番バンドルに載る。
     `${NEXT_PUBLIC_LIFF_MOCK:-0}` のように外部の値を尊重する形も**不可**で、
     デプロイ環境に `1` を置くだけでゲートを緑のまま通過してモックが載るため、
     右辺が `0` リテラルであることまで検査する）
   - `src/lib/liff/**` と `src/app/(liff)/**` **以外の** `src/` 配下のどのファイルも
     `@line/liff` / `@line/liff-mock` / `src/lib/liff/**` を参照しないこと
     （`src/` の全走査 ＋ `src/app/**` の `(liff)` 以外と `src/middleware.ts` を起点とする
     import グラフの走査。決定 1 を機械的に強制する）
   - `next build` が成功すること
   - `.next/static/**` に `@line/liff-mock` 由来の識別子と dev / review の LIFF ID が無いこと
     （R-LINE-04 / 制約 I4 / check_079）

   **畳み込みの条件（2026-09-24 実測で確定）**: モックの動的 import が落ちるのは
   `NEXT_PUBLIC_LIFF_MOCK` が **`"1"` 以外の値で設定されている**ときであって、
   「未設定」ではない。Next.js の `getNextPublicEnvironmentVariables()`
   （`node_modules/next/dist/lib/static-env.js`）が `for (const key in process.env)` で
   **存在するキーだけ**を define にするため、未設定だと実行時判定が残り
   `@line/liff-mock` がクライアントチャンクに出力される。
   複製リポジトリに `bootLiff()` を呼ぶ page を置いた実測で、未設定なら 2 ファイル、
   `NEXT_PUBLIC_LIFF_MOCK=0` なら 0 ファイルになることを確認した。
5. したがって **`build:web-only` の緑は「LINE を外しても集金が回る」ことの証明ではない。**
   `GATE-LINE-POLICY` が否定側に倒れた場合の退避には、画面層とセッション層の作り直し
   （所要は Phase 1 相当）という別計画が要る。この事実を A7 の退避欄と本 ADR の両方に置く。

## なぜ「退避先を今から作らない」のか

- ミニアプリの審査要件そのものが「主な機能はミニアプリ内で提供」であり（§7-3）、
  LINE 非依存の集金導線を Phase 1 から並行実装すると、**審査に不利な構成を自分で作る**ことになる。
- 2 系統の導線を同時に育てると、認可・セッション・冪等・台帳適用の各層に「LIFF 経路」と
  「Web 経路」の 2 通りの真実ができる。Phase 1 の稼働本数（幹事 1 名のパイロット）に対して
  この複雑さは釣り合わない。
- 退避が必要になったときに **無傷で残る資産**（台帳・アダプタ層・冪等基盤・DB スキーマ・
  監査連鎖）は `(liff)` 依存ではない。捨てるのは画面層とセッション層に限られる。
  そこを作り直す前提で、いま守るのは「LIFF 依存が 2 か所から漏れ出していないこと」だけでよい。

## Consequences

- `(web)` に幹事・参加者向けの画面を足す変更は、本 ADR を改訂してからでないと入れられない。
- `build:web-only` が緑であることを根拠に「LINE を外しても大丈夫」と述べてはならない。
  リリース判定・PO への報告・`docs/PROGRESS.md` の記述でこの言い換えをしないこと。
- Phase 1 時点の `(web)` には実ページが 1 つも無い（レイアウトのみ）。法務ページと管理者画面は
  task_021 が足し、それが LINE SDK 無しで描画されることの E2E は task_022
  （`tests/e2e/web-only.spec.ts`）が確かめる。
  ただし決定 1 の強制は `(web)` の到達範囲に依存させない。`(web)` に実ページが無くても、
  `src/app/page.tsx` や `src/middleware.ts` のようなルートグループ外の共有ファイルは
  毎ビルドに載るため、`build:web-only` は `src/` を全走査して「許した 2 か所以外から
  LIFF を参照していないこと」を直接確かめる。

## 未解決

- Q-LN2（会費徴収が「有料サービスの販売」に当たるか）の回答。`GATE-LINE-POLICY` の入力であり、
  否定側に倒れたときに本 ADR の前提が変わる。`docs/external-inquiries.json` で追跡中。
- 退避が必要になった場合の「別計画」の中身（所要・順序・捨てる範囲の確定）は未起票である。
  Q-LN2 の回答が否定側に倒れた時点で起票する。
