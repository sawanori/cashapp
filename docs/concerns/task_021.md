# task_021 残懸念

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

## 1. `createDbClient`（`src/lib/db/client.ts`）が `db.sql` の timestamp 列を壊す

- **指摘 [severity: high]**: `createDbClient` は `drizzle(client, { schema })` を呼ぶが、
  drizzle-orm の postgres-js ドライバ（`node_modules/drizzle-orm/postgres-js/driver.cjs` の
  `construct()`）が渡された `client.options.parsers` / `serializers` のうち timestamp 系 OID
  （1184 等）をその場で透過（no-op）に書き換える。`createDbClient` は同じ `client` を `sql:` として
  返すため、アプリ全体で使われている `db.sql`（drizzle を介さない生タグ付きテンプレート。`db.db`
  はどこからも使われていない）経由の timestamptz 列が、読み取りでは `Date` ではなく文字列に、
  書き込みでは `Date` 値の束縛が例外になる。`appendAuditLog`（`occurredAt`）・`runIdempotent`
  （`expiresAt`）・`resolveEventByJoinToken`（`.getTime()`）を含む、書き込み系ルートの大半と
  join トークンを解決するすべての参加者向けルートに及ぶ。既存の統合テストは全て
  `tests/integration/setup.ts` の別接続（drizzle を介さない）を使うため、これまで検出されていない。
  repro を `tests/integration/_debug_admin.test.ts` に固定した。
- **対応案**: `src/lib/db/client.ts` の所有タスクが、`drizzle()` を呼ばない（`db.db` は未使用の
  ため削除可）か、`drizzle()` に渡す前に `client.options` を複製するかで修正する。
- **対応予定タスク**: `src/lib/db/client.ts` の所有タスク（未特定。task_003/task_011 系）。

## 2. 幹事あたりの合計請求額上限（サーバー強制）は未実装

- **指摘 [severity: medium]**: scope の「悪用対策: 幹事あたり上限（サーバー強制）」のうち、
  合計請求額上限は対象ファイル（`src/app/api/events/[id]/invoices/route.ts` /
  `src/lib/db/repositories/invoices.ts`）が task_021 の files_to_modify に含まれず、スコープ規律
  と衝突するため未実装。`abuse-limits.test.ts` は「上限超過429」の要件を `POST /api/e/report`
  のレート制限で満たした（scope 記載の 3 項目のうち別の 1 つ）。
- **対応案**: task-list.json の files_to_modify に上記 2 ファイルを追加する後続タスクで実装。
- **対応予定タスク**: 未採番。

## 3. O-9 要対応インボックスの 10 種別自動分類は部分実装

- **指摘 [severity: medium]**: `GET /api/events/:id/participants` が返す `ParticipantRow` には
  `needsAttention` はあるが分類に必要な内訳（台帳残高・void 理由・紛争フラグ等）が無く、
  `src/app/(liff)/events/[id]/inbox/page.tsx` は `confirmationMethod==='mixed'` と
  `rosterStatus==='canceled'` の 2 種のみを機械分類し、残りは「要確認」に丸める。
- **対応案**: 参加者一覧 API に分類用の内訳を足す後続タスクで完成させる。
- **対応予定タスク**: 未採番。

## 4. `docs/incident-response.md` の個人情報保護委員会報告期限は未検証

- **指摘 [severity: medium]**: 速報 3〜5 日・確報 30/60 日という数値は、本タスク実施時点で
  WebFetch が対象ページで 404、WebSearch がセッション上限到達のため一次資料を取得できず、
  一般に知られる数値を暫定値として記載した（ファイル内に明記済み）。
- **対応案**: 一次資料（個人情報保護委員会の公表資料）を取得後、弁護士確認とあわせて確定する。
- **対応予定タスク**: 未採番（法務レビュー担当）。

## 5. `(web)/layout.tsx` への法務リンク差し込みは未実施

- **指摘 [severity: low]**: 同ファイルのコメントは「運営者情報・規約・プライバシーポリシーへの
  リンクは task_021 がここに足す」と書くが、`layout.tsx` は task_021 の files_to_modify に含まれ
  ないため触れていない。法務情報は `src/app/(liff)/settings/legal/page.tsx` に集約した。
- **対応案**: files_to_modify に `src/app/(web)/layout.tsx` を追加する後続タスクで配線する。
- **対応予定タスク**: 未採番。

## 6. `POST /api/invoices/:id/refund` の自動アダプタ経路は Phase 1 で未到達

- **指摘 [severity: low]**: Phase 1 の出荷アダプタ `manual_confirm` は `capabilities.refund` が
  常に `'none'` のため、`provider.refund()` 呼び出し以降のコード（自動アダプタ向け）は型を満たす
  形で書いたが統合テストでは踏めない。
- **対応案**: Phase 2 で自動アダプタが出荷され次第、当該経路の統合テストを追加する。
- **対応予定タスク**: Phase 2 の決済アダプタ実装タスク。

## 7. `GET /api/me/export.zip` は手書き ZIP（依存追加なし・単一エントリ）

- **指摘 [severity: low]**: 依存ライブラリを増やさない制約（files_to_modify が package.json のみ）
  のため、ZIP は無圧縮 STORE 方式を自前実装した（`src/app/api/me/export.zip/route.ts`）。
  中身は `export.json` 1 ファイルで、CSV 等の複数ファイル構成にはしていない。
- **対応案**: 必要になれば `npm i` で zip ライブラリを追加し、複数フォーマットへ拡張する。
- **対応予定タスク**: 未採番。

## 8. `tests/unit/gate-check.test.ts` の既存失敗（task_021 起因ではない）

- **指摘 [severity: low]**: `npm run test:unit` で `G2 の 3 分岐` 配下 2 件が失敗する
  （`` `test:contract` は未定義 `` を前提にしたフィクスチャが、task_018 が `package.json` に
  `test:contract` を実在させたことで食い違った）。task_021 が触れたファイルとは無関係
  （`tests/unit/gate-check.test.ts` / `scripts/gate-check.mjs` はいずれも task_006 の所有）。
- **対応案**: task_006 側でフィクスチャの参照スクリプト名を、実在しない別名に差し替える。
- **対応予定タスク**: task_006 または `scripts/gate-check.mjs` の所有タスク。
