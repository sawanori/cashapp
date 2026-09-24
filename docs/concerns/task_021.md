# task_021 残懸念

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

## G5 修正ラウンド（2026-09-25・敵対レビュー是正）

`docs/review-log/task_021.json`（コミット `82dda92`）は `decision: "reject"`（有効票 2・
実効 high 3）。指摘は下記のとおり扱った。再レビューはしない（規約どおり指摘は 1 周だけ扱い、
残りは concerns に記録する）。

1. **[gpt F-1] `admin-auth.ts:336` proposalId 先頭ゼロで承認済み申請を再承認できる — 修正済み**。
   `ADMIN_PROPOSAL_ID_RE` を `/^[0-9]{1,19}$/` から `/^(0|[1-9][0-9]{0,18})$/`（先頭ゼロ無しの
   正規形のみ許可）に変更。原因は `id = ...::bigint`（数値キャストで正規化される）と
   `detail->>'proposalId' = ...`（文字列の完全一致。正規化されない）という 2 つの比較の
   ずれで、先頭ゼロを付けた `proposalId` が前者だけ一致し後者は外れて二重承認が成立していた。
   正規形以外を 404 で弾くことで比較対象を常に同じ文字列にした。
   回帰テスト: `tests/integration/admin.test.ts`「proposalId に先頭ゼロを付けると 404」
   （承認済み提案への先頭ゼロ付き再承認が 404 になることを確認）。
2. **[gpt F-2] `admin-auth.ts:210` login の大小文字違いで同一管理者が二人承認を偽装できる —
   修正済み**。`verifyAdmin` が返す `adminId` を `gh:${login}`（GitHub が返す生の大小文字）から
   `gh:${login.toLowerCase()}`（正規化した小文字）に変更。`approveAdminAction` の同一人物判定
   （`proposedBy !== input.admin.adminId`）は文字列の完全一致であり、GitHub の login は表示上の
   大小文字を変更できる（同一アカウント）ため、正規化前は大小文字を変えるだけで「別人による
   承認（twoPerson=true）」を偽装し、A23 縮退の 24 時間クーリングを回避できた。
   回帰テスト: `tests/integration/admin.test.ts`「GitHub login の大小文字が異なっても同一の
   adminId に正規化される」（`verifyAdmin` を直接呼び、"alice" と "Alice" が同じ `gh:alice` に
   正規化されることを確認）。
3. **[gemini F-1] `src/lib/db/client.ts` の横断的不具合 — 対応不可（スコープ外・未変更）**。
   task_011 が所有するファイルで、task_021 の files_to_create/files_to_modify に含まれない
   （共通ルール「他タスクの files_to_create に含まれるファイルを作らない・変更しない」に従い
   本タスクでは触れていない）。下の §1 に詳細。abuse-limits.test.ts / admin.test.ts の
   ルート経由成功系テストがライブラリ直呼びに退避している根本原因もこれで、task_011 の修正
   （または同ファイルを引き継ぐ後続タスク）が完了するまで閉じられない。
4. **medium「docs/review-log/task_021.json が存在しない」— 解消済み**。検証者が
   `scripts/review-drive.sh` → `scripts/merge-review.sh` を実行し、コミット `82dda92` で
   作成済み。
5. **medium「幹事あたり合計請求額上限が未実装」「O-9 の 10 種別分類が部分実装」「required
   status check 未登録」— 変更なし（下の §2・§3・§5 のまま）**。いずれも対象ファイルが
   task_021 の files_to_modify 外、または CI/リポジトリ設定（PO 作業）であり、本ラウンドの
   スコープ規律に従い着手していない。

**verify_commands 7 本を `scripts/record-run.sh task_021` 経由で全件再実行**（本ラウンド）:
`typecheck` exit 0 / `test:integration` 21 ファイル 251/251 pass（新規回帰テスト 2 件を含む）/
`gate:wording` 0 violation / `gate:terms` 5/5 / `gate:privacy-policy` 9/9 はすべて exit 0。
初回の `test:unit` 実行は task_006 所有 `tests/unit/gate-check.test.ts` の既存 2 件（`test:contract`
フィクスチャの食い違い）で exit 1 だったが、並行して走っていた task_006 側の修正コミット
（`90c8968`）が本ラウンド中に着地し、再実行で `test:unit` 1214/1214 pass・exit 0 を確認した。
同様に初回の `gate:constraints` は task_020 所有 `src/lib/reconcile.ts` の W11（advisory lock
欠落）で exit 1 だったが、task_020 側の並行コミットが advisory lock を実装済みで、再実行で
29 grep entry 0 violation・exit 0 を確認した。**最終的に verify_commands 7 本すべて exit 0**。
どちらも task_021 のファイル起因ではなく、task_021 側では何も変更していない（並行タスクの
進捗により事後的に解消された）。

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

## 8. `tests/unit/gate-check.test.ts` の既存失敗 — 解消済み

- **[severity: low→解消済み]**: `npm run test:unit` の `G2 の 3 分岐` 配下 2 件（`test:contract`
  フィクスチャの食い違い。task_006 所有）は、G5 修正ラウンド中に着地した task_006 側の
  並行コミット（`90c8968`。フィクスチャの参照スクリプト名を実在しない `bench:models` へ変更）
  で解消済み。再実行で `test:unit` 1214/1214 pass・exit 0 を確認した。対応不要。
