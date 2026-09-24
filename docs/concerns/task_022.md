# task_022 残懸念

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

## 1. `createVerifiedDbClient()` 経由の実 HTTP ルートは、ほぼ全ての DB 書き込み・多くの読み取りで 500 になる

- **指摘 [severity: high]**: `docs/concerns/task_021.md` #1 が発見した不具合
  （`src/lib/db/client.ts` の `createDbClient` が `drizzle(client, { schema })` の副作用で
  `db.sql`＝`client` の timestamptz パーサ/シリアライザを壊す）を、本タスクで実際に**動かして
  確定**した。ローカルの `next dev`（`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
  で `app_rw` 接続に上書き）に実セッション＋実 CSRF トークンで `POST /api/events` を送ると
  `500 INTERNAL` になり、原因を単独で再現すると
  `The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.
  Received an instance of Date`（`ERR_INVALID_ARG_TYPE`）。`runIdempotent()` の予約 INSERT
  （`expires_at` に `Date` を束縛）が**あらゆる書き込みの最初の一歩**であるため、`Idempotency-Key`
  を要求するほぼ全ての POST ルートがこの一撃で落ちる。`GET /api/events`・
  `GET /api/events/:id` も 500 になることを実測した（`getEventSummary`/`listOrganizerEvents` が
  読み取った timestamptz を Date として扱う箇所で落ちる）。
- **実測手順**: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://app_rw:app_rw_local_dev_only@127.0.0.1:54322/postgres npx next dev -p 3199` → 実セッション Cookie ＋ `X-CSRF-Token` を付けて `POST /api/events` → `500`。単独の再現は
  `drizzle(postgres(url), {})` してから同じ接続で `INSERT ... VALUES (${new Date()}, ...)` する
  だけで上記例外が出る（`SELECT now()` も `Date` ではなく文字列を返すようになる）。
- **影響範囲**: `tests/e2e/organizer-flow.spec.ts`・`manual-only-complete.spec.ts` の
  「完走」テストが `POST /api/events` で赤。`tests/e2e/participant-flow.spec.ts` は別の理由
  （#2）で `GET /api/e/preview` から先に進めない。check_001 / check_112 の一次要件
  （実 HTTP での完走）は**この不具合が直るまで満たせない**。
- **対応案**: `src/lib/db/client.ts` の `createDbClient` が `db.db`（drizzle インスタンス。
  どこからも使われていないことを task_021 が確認済み）を作らない、または `drizzle()` に渡す
  前に `client.options` を複製する。
- **対応予定タスク**: `src/lib/db/client.ts` の所有タスク（未特定。task_021 の記録と同じ）。
  本タスクの files_to_modify に同ファイルは無いため修正していない。

## 2. `/api/auth/line` と `/api/e/preview` は、ローカル・デプロイ後を問わず常に 503（レート制限バインディング未設定）

- **指摘 [severity: high]**: `docs/concerns/task_012.md` C-012-2 が既に発見・記録済みの不具合を
  実測で再確認した。`wrangler.toml` に `[[ratelimits]]` も Durable Object バインディングも無く、
  `src/lib/auth/rate-limit.ts` はどちらも無ければ fail-closed で `RATE_LIMIT_UNAVAILABLE`
  （503）を返す。ローカルの逃げ道 `ALLOW_LOCAL_RATE_LIMIT_BYPASS` は
  `env.HYPERDRIVE === undefined || env.HYPERDRIVE === null` を条件の 1 つに持つが、
  `wrangler.toml` が `[[hyperdrive]]` を宣言している限り `initOpenNextCloudflareForDev()` 経由の
  `next dev` では `env.HYPERDRIVE` が**常に**（接続文字列を上書きしても）非 null のオブジェクトに
  なるため、この逃げ道は**現在の wrangler.toml 構成では原理的に到達不能**であることを実測した
  （`ALLOW_LOCAL_RATE_LIMIT_BYPASS=1` を設定しても `/api/e/preview` は 503 のまま）。
- **影響**: `tests/e2e/participant-flow.spec.ts` の preview ステップが 503 で止まる
  （`docs/concerns/task_012.md` に記載の bypass 死経路の実地確認を兼ねる）。
- **対応案**: task_012 の対応案のとおり `wrangler.toml` に `[[ratelimits]]` か Durable Object
  バインディングを追加するか、`isLocalBypass()` の条件 3 を接続文字列の由来（direct/hyperdrive）
  で判定するよう変える（`src/lib/db/client.ts` の `isLocalDevPrivilegedOverride` と同じ設計）。
- **対応予定タスク**: task_024（本番）/ task_035（staging）。`src/lib/auth/rate-limit.ts` の
  条件式変更が要るなら別途 task_012 の後続。

## 3. `@line/liff-mock` の `isInClient` を外部から上書きする経路が無く、ブラウザ駆動の認証済み E2E が成立しない

- **指摘 [severity: medium・構造的制約]**: `src/lib/liff/client.ts` はモック SDK を内部の動的
  import に閉じており（`window` に露出しない。`tests/e2e/share.spec.ts` の docstring で既に
  指摘済み）、`@line/liff-mock` の既定値 `isInClient: false` を Playwright から書き換える手段が
  無い。公式 API `liff.$mock.set(...)` は差し込み後の `liff` インスタンスに対してしか呼べず、
  アプリはそれを外部へ渡さない。したがって `(liff)/**` の全ページは実ブラウザ操作では
  `outside_line` から先に進めない（本タスクで確定。E2E で認証済み UI を検証する具体的な
  手立てが現状のコードには無い）。
- **本タスクでの対応**: `tests/e2e/helpers/session.ts` で `app_user` 行とセッション JWT を
  直接発行し、Playwright の API テストコンテキスト（`request`）で実ルートを HTTP 経由で叩く形に
  した。ブラウザ描画（DOM のバッジ・サマリ文言）の検証は諦め、API が返す JSON の該当フィールド
  （`autoDetected` / `confirmationMethod` / `breakdown.*`）で代替した。DOM 側の描画そのものは
  `tests/unit/components/InvoiceRow.test.tsx` / `SummaryBar.test.tsx` が props 経由で別途
  検査済みであることを確認済み。
- **対応案**: `src/lib/liff/client.ts` に E2E 専用の上書きフック（例:
  `NEXT_PUBLIC_LIFF_MOCK_FORCE_IN_CLIENT` のようなビルド変数、または `window.__e2eLiffMock` を
  `NEXT_PUBLIC_LIFF_MOCK=1` の分岐内でだけ露出する）を足す。本番バンドルに絶対含めない設計
  （`I4`）を保ったまま行う必要があり、設計判断が要る。
- **対応予定タスク**: `src/lib/liff/client.ts` の所有タスク（task_012/013）。本タスクの
  files_to_modify に同ファイルは無いため変更していない。

## 4. CSV 数式インジェクション（`GET /api/events/:id/export.csv`）が未対策

- **指摘 [severity: medium]**: `src/app/api/events/[id]/export.csv/route.ts` の `csvField()` は
  引用符・カンマ・改行しかエスケープせず、セルの先頭が `=` / `+` / `-` / `@` のとき
  Excel・Google スプレッドシートがそのセルを数式として評価する（CSV Injection /
  Formula Injection。実測: `tests/security/xss-csp.test.ts` で 4 件の赤として固定）。
  `display_label` は `POST /api/e/request-add` 経由で参加者本人が自己申告できる値であり、
  `=HYPERLINK("https://evil.example","click")` のような値を名乗る攻撃者が、幹事が Excel で
  開いた CSV を通じてリンク実行やコマンド実行（プラグイン次第）を誘発しうる。
- **対応案**: `csvField()` で、値の先頭が `=`/`+`/`-`/`@`/タブ/改行のときに `'`（シングル
  クォート）を前置する（Excel/Sheets 双方で標準的に効く対策）。`docs/wording-policy.md` の
  対象外（文言ではなく書式）なので `gate:wording` には影響しない。
- **対応予定タスク**: `src/app/api/events/[id]/export.csv/route.ts` の所有タスク（task_021）。
  本タスクの files_to_modify に同ファイルは無いため未修正。

## 5. `src/lib/webhook/ip-allowlist.ts` の許可リスト解析が、無効な IPv4 表記を「無害な exact ルール」に誤分類する

- **指摘 [severity: low]**: `parseIpAllowlist()` は非 CIDR エントリを `parseIpv4()` → 失敗した
  場合に `/^[0-9A-Fa-f:.]{2,45}$/`（IPv6 想定）へフォールバックするが、この正規表現は数字と
  ドットだけの文字列も通す。`"203.0.113.256"`（オクテットが範囲外で `parseIpv4` が `null` を
  返す値）が `kind: "exact", value: "203.0.113.256"` という**無害だが不正な**ルールになり、
  モジュール自身の docstring が約束する「1 つでも書式が不正なら空配列（fail-closed）」を
  破る（実測: `tests/security/webhook-ip.test.ts` に赤 1 件として固定）。実害は無い
  （`203.0.113.256` という文字列が実際の `CF-Connecting-IP` に現れることは無い）が、
  運用者の設定ミスを検知できない。
- **対応案**: フォールバック正規表現を「コロンを 1 つ以上含む」ことを要求する形に変える
  （`/^[0-9A-Fa-f]*:[0-9A-Fa-f:.]*$/` 等）か、数字とドットだけの文字列は無条件に拒否する。
- **対応予定タスク**: `src/lib/webhook/ip-allowlist.ts` の所有タスク（task_018）。本タスクの
  files_to_modify に同ファイルは無いため未修正。

## 6. `/onboarding` に最小タップサイズ・200% フォント時の横スクロール対策が無い

- **指摘 [severity: low]**: `tests/a11y/pages.spec.ts` の実測で、`/onboarding`
  （`src/app/(liff)/onboarding/page.tsx`）のチェックボックス・ラジオの `<label>` が
  4 番目（(B) 自動検知版の選択ラベル）で高さ 18px しか無く 44px を満たさない。同ページに
  `html { font-size: 200% }` を適用すると `scrollWidth` が `clientWidth+32px` を大きく超える
  （実測 640px vs 444px）。§8-3 の共通規約（44px タップ・200% フォント）に照らして未対応。
- **対応案**: `.onboarding__check` / `.onboarding__choice` に `min-height: 44px` と
  縦方向の余白、長文ラベルの折り返しを前提にしたレイアウト（`display: flex; flex-wrap: wrap`
  等）を足す。
- **対応予定タスク**: `src/app/(liff)/onboarding/page.tsx` の所有タスク（task_017）。本タスクの
  files_to_modify に同ファイルは無いため未修正。

## 7. axe-core の best-practice ルール 2 件（`region` / `page-has-heading-one`）— 参考情報

- **指摘 [severity: low・参考]**: `(liff)` / `(web)` 共有レイアウトのスキップリンクが
  `<main>` の外（landmark 外）にあるため axe の `region`（best-practice タグ）が発火し、
  `outside_line` 状態には `<h1>` が無いため `page-has-heading-one`（同）も発火する。
  どちらも WCAG 2 A/AA タグ（`wcag2a`/`wcag2aa`/`wcag21aa`）では発火しない
  best-practice 限定のルールなので、`tests/a11y/pages.spec.ts` の判定は明示的に
  `withTags(["wcag2a","wcag2aa","wcag21aa"])` に絞ってある（check_111 の「axe-core 違反 0」は
  法的 conformance の対象である WCAG 2 A/AA を指すという解釈）。隠しているわけではなく、
  ここに参考情報として記録する。
- **対応予定タスク**: `src/app/(liff)/layout.tsx` / `src/app/(web)/layout.tsx` /
  `src/components/StateView.tsx` の所有タスク（task_012/013/021）。

## 8. ファネル計測（`src/lib/metrics/funnel.ts`）は実装済みだが、実ルートへの配線は未実施

- **指摘 [severity: medium]**: 本タスクは `recordFunnelStage` / `computeWeeklyFunnel` /
  週次 JSON 出力を実装し、`tests/e2e/manual-only-complete.spec.ts` で記録・集計・
  `docs/metrics/weekly-*.json` 書き出しまでを実際に動かして確認した（着地→同意→claim→
  checkout→paid の 5 段すべてが 1 として出ることを実測）。ただし**実際の集金導線
  （`GET /api/e/preview`・`POST /api/consent`・`POST /api/e/claim`・`POST /api/e/checkout`・
  台帳適用）から `recordFunnelStage` を呼ぶ配線はしていない**。呼び出し元となる各ルートは
  本タスクの files_to_modify に無い。
- **対応案**: 各ルートの成功パスの末尾（監査ログ追記と同じトランザクション内）に
  `recordFunnelStage(tx, { eventId, stage, requestId })` を 1 行足す。5 箇所すべてが揃うまでは
  週次 JSON の値は不完全になる。
- **対応予定タスク**: 各ルートの所有タスク（preview/consent: task_014、claim: task_015、
  checkout: task_017、台帳適用: task_018）または後続タスクでまとめて配線する。

## 9. `.github/workflows/e2e.yml` / `gate-a11y.yml` の Supabase 起動手順は CI での実行未確認

- **指摘 [severity: low・deferred]**: task_022 で追加した `tests/e2e/organizer-flow.spec.ts` 等が
  実 Postgres（`tests/e2e/helpers/session.ts` の `testSql()`）を要求するため、
  `.github/workflows/e2e.yml` に `gate-integration.yml`（task_011）と同じ Supabase 起動・
  マイグレーション・`app_rw` パスワード設定の手順を追加した。YAML の静的妥当性は
  `js-yaml` でパースして確認した（`jobs` キーが期待どおり読める）。**実際に GitHub Actions
  上で走らせた確認はしていない**（`git push` はメインセッションのみが行う規約のため）。
- **対応**: メインセッションの push 後に CI で確認する（本タスクの共通ルールに従い deferred
  扱いとし、BLOCKED の理由にしない）。

## 10. `docs/gates/compliance-gates.json`（正本）と本タスクが `feature_flag`/`compliance_gate` に書いたテスト用の値の扱い

- **指摘 [severity: low]**: `tests/security/gate-bypass.test.ts` は `withRollback(migrator, ...)`
  を使っており、`feature_flag` / `compliance_gate` への書き込みはすべてロールバックされる
  （実 DB・正本 JSON のどちらにも影響を残さない）。念のため明記する。
