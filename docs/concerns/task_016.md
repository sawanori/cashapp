# task_016 の残懸念

配布（O-7）: 催促文＋URL コピー（主導線）・参加者ごとの個別リンク・shareTargetPicker（補助）・
未払い者再共有・QR・リンクを疑われた際の説明テンプレ。形式は「指摘 / 深刻度 / 対応案 /
対応予定タスク」。

---

## C-016-1 `[severity: medium]` Playwright の既定 `baseURL`（`127.0.0.1`）だと `next dev` の
ハイドレーションが永久に終わらない（実測。task_022 に直撃する穴）

- **指摘**: `playwright.config.ts` の既定 `baseURL` は `http://127.0.0.1:<port>` だが、
  Next.js 16 の `next dev` は `allowedDevOrigins` 未設定のとき、その `127.0.0.1` からの
  `/_next/*` dev リソース取得を「オリジン不一致」としてブロックする（dev サーバーのログに
  `Blocked cross-origin request to Next.js dev resource /_next/hmr from "127.0.0.1"` と出る）。
  RSC のクライアント参照解決がこれに依存しているため、ブロックされると**ハイドレーションが
  永久に終わらず**、`useEffect` が一度も発火しない。既存の O-4〜O-6（task_014/015 の画面）でも
  同じ症状を実測で確認した（`/events/:id/participants` も `読み込み中です` のまま固まる）。
  `localhost` に向けると同じサーバーが同じ内容を問題なく返す（実機の LINE アプリ内ブラウザは
  この経路を通らないため本番には影響しない）。診断の過程で「`eval()` が CSP で塞がれている」
  という console エラーも出るが、これは `react-server-dom-turbopack` の
  `checkEvalAvailabilityOnceDev`（スタックトレース再構成の可否を試すだけで、成否に関わらず
  機能をブロックしない実装をソースで確認済み）によるもので、実際の原因ではない
  （赤herring。切り分けに時間を要した）。
- **深刻度**: medium（今回は自分のテストファイル内だけで `localhost` を使う `test.use()` で
  回避できたが、task_022 が `playwright.config.ts` の既定値をそのまま使って複数の (liff) 画面を
  E2E 化すると、同じ穴に**すべて**でぶつかる）。
- **対応案**: `next.config.ts` に `allowedDevOrigins: ["127.0.0.1"]` を足す、または
  `playwright.config.ts` の既定 `baseURL` を `localhost` に変える。どちらも task_016 の
  files_to_create/files_to_modify の外なので本タスクでは変更していない。
- **対応予定タスク**: task_022（着手前に必ず読むこと）。所有は `next.config.ts`（task_003）/
  `playwright.config.ts`（task_003）。

## C-016-2 `[severity: medium]` check_030 の e2e 側の期待（`isApiAvailable=false` 時の
`ShareSheet` 描画を実ブラウザで固定する）は、liff-mock の制約で今は満たせない

- **指摘**: `docs/acceptance-checks.json` の check_030 は `verification_method` に
  「`npm run test:e2e`（`tests/e2e/share.spec.ts`）と `npm run gate:constraints`」を挙げ、
  「催促文＋URL コピー・個別リンク・QR のみ表示。picker ボタン非表示」を実ブラウザで確認する
  ことを想定している。しかし `@line/liff-mock` の既定値は `isInClient: false` で、これを
  上書きする `liff.$mock.set(...)` はアプリ内部の動的 import に閉じた `liff` インスタンス
  にしか生えず、`window` に露出しない（`src/lib/liff/mock.ts` の設計。他タスクのファイルの
  ため本タスクでは変更していない）。したがって liff-mock 有効時にブラウザから到達できるのは
  `isInClient=false` → `outside_line` の経路だけで、**認証済み `ready` フェーズに実際に
  到達して `ShareSheet`（picker ボタン非表示・コピー導線のみ）を実ブラウザで描画する e2e は
  今回組めなかった**。`isApiAvailable=false` 時の描画（picker ボタン非表示・催促文/個別
  リンク/説明テンプレ/QR が出ること）は `tests/unit/components/ShareSheet.test.tsx` で props
  経由により厳密に固定した（done_definition の本体）。`tests/e2e/share.spec.ts` は代わりに
  「`outside_line` でも URL コピー＋QR 案内が欠けずに出る」という N8 の別側面（コピー導線が
  picker の可用性に一切依存しないこと自体）を実ブラウザで固定している。
- **深刻度**: medium（done_definition の文言上の要求は満たしている。check_030 の
  `verification_method` が e2e に期待する範囲までは満たしていない）。
- **対応案**: `src/lib/liff/mock.ts`（task_013 所有）に、`NEXT_PUBLIC_LIFF_MOCK==="1"` の
  内側に限定した「起動前に mock データを注入するテスト専用フック」（例:
  `window.__CASHAPP_LIFF_MOCK_PRESET__` を `bootLiff()` 実行前に読む）を足すか、Playwright
  側で有効なセッション Cookie を直接発行する fixture を用意する。どちらも `src/lib/liff/mock.ts`
  または新規テストインフラの担当であり、task_016 の files_to_create/files_to_modify の外。
- **対応予定タスク**: task_022（E2E 基盤）。check_030 の `verification_method` は
  「unit（前段）＋ e2e（`outside_line` 側の N8 確認）」の組み合わせに更新するか、task_022 で
  上記フックを足したうえで元の想定どおりに寄せるか、PO 判断が要る。

## C-016-3 `[severity: low]` 「参加者ごとの個別リンク」は claim トークン単位の個別 URL ではなく、
共通の招待リンク＋宛名入り催促文である（C-015-2 の帰結。設計判断として実装）

- **指摘**: `POST /api/events/:id/participants` が発行する `claimToken` は**発行応答の 1 度きり**
  しか手に入らず、参加者一覧 API（`GET .../participants`）はそれを返さない（task_015 の設計。
  `docs/concerns/task_015.md` C-015-2 と同じ制約が `claimToken` にも及ぶ。`participants/page.tsx`
  のコメントも「参加者ごとの個別リンクの組み立ては配布導線（task_016）の担当」とだけ書き、
  トークンの受け渡し方法までは決めていなかった）。本タスクでは、`/events/:id/share` は
  `GET .../participants`（トークンを含まない）と `POST .../rotate-join-token`（イベント単位の
  一般リンクを都度作り直す）だけを使い、「参加者ごとの個別リンク一覧」は**同じ一般リンク＋
  参加者名を宛名にした催促文**（`buildReminderText({ participantLabel })`）として実装した。
  参加者は一般リンクを開いたあと、P-2 の名簿選択（「あなたは○○さんですか」）で自分を選ぶ。
  真に一意な claim トークンリンクを個別に再表示する手段は現行の API には無い。
- **深刻度**: low（機能としては成立しており、意図的な設計判断として `ShareSheet` / 実装
  コメントに明記した。将来 claim トークンの再発行 API を足す場合はここを差し替える）。
- **対応案**: 個別 claim トークンリンクを後から再表示したい場合、参加者単位の
  トークン再発行エンドポイント（`POST .../participants/:pid/rotate-claim-token` 相当）が
  要る。新規 API・スキーマ変更を伴うため本タスクの scope 外。
- **対応予定タスク**: 未定（PO 判断。優先度は低い。一般リンク＋名簿選択で運用上は完結する）。

## C-016-4 `[severity: low]` `/events/:id/share` へのナビゲーションリンクがまだ無い

- **指摘**: O-4（イベント詳細）・O-6（請求発行）のどちらからも `/events/:id/share` への
  リンクを足していない。`src/app/(liff)/events/[id]/page.tsx` と
  `src/app/(liff)/events/[id]/invoices/page.tsx` はどちらも task_016 の
  files_to_create/files_to_modify の外なので編集していない。
- **深刻度**: low（直接 URL で到達可能。機能そのものは完結している）。
- **対応案**: O-4 の「イベント内の操作」一覧（`event-detail__actions`）に「配布する」リンクを
  1 行足す。1 行の追加で足りる。
- **対応予定タスク**: 未定（PO 判断で軽微な UI 追随タスクとして切り出すか、次に
  `events/[id]/page.tsx` を触るタスクに含める）。

## C-016-5 `[severity: low]` `npm run test:unit` は task_016 と無関係な 2 件の失敗を含む
（task_006 所有・task_023 の C-9 と同一事象）

- **指摘**: `scripts/record-run.sh task_016 npm run test:unit` は 1194 件中 2 件失敗（exit 1）だが、
  失敗はいずれも `tests/unit/gate-check.test.ts`（`scripts/gate-check.mjs` は task_006 所有）で、
  `package.json.scripts` に `test:contract`（task_018 の scope）が並行コミットで実際に追加
  されたため、同テストの「`test:contract` は未定義」という前提のフィクスチャ検証が現在の
  `package.json` の実体と食い違っている。`docs/concerns/task_023.md` §9 に同一事象が既に
  記録されている（他タスクのファイルは変更しない規約に従い本タスクでも未対応）。
  `ShareSheet.test.tsx`（8 件）・`share-templates.test.ts`（16 件）を含む本タスクの新規
  ファイルはすべて pass している。
- **深刻度**: low（task_016 のスコープ外）。
- **対応案**: `tests/unit/gate-check.test.ts` のフィクスチャ（`report()` に渡す `base`/`root`
  の分離、または期待値の更新）は task_006 の所有者が対応する。
- **対応予定タスク**: task_006（所有者による確認）。

## GATE-LINE-POLICY / GATE-LINE-SHARE の状態（run-log 記録・done_definition 4 点目）

- `docs/gates/compliance-gates.json` の `GATE-LINE-POLICY` と `GATE-LINE-SHARE` はどちらも
  本タスク完了時点で `status: "unknown"`（Q-LN2 / Q-LN7 未回答）。`scripts/record-run.sh
  --manual task_016` で run-log に記録した（下記 evidence 参照）。
  `docs/task-list.json` の task_016 自身の concerns にあるとおり、Q-LN2 未回答のまま
  (liff) の配布導線を実装しているため、一般公開時には `GATE-LINE-POLICY` の `passed` が
  必須で、それまではクローズド β 限定（招待した幹事 3〜5 名）に留める前提（ADR-011 は
  task_029 で正式に作成される予定。`docs/implementation-plan.md` §18-2）。
