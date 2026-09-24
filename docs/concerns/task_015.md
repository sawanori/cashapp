# task_015 の残懸念

請求発行・招待トークン・参加者単位 claim・unclaim・preview・自己申告・参加者画面（P-1〜P-3）。
形式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

---

## C-015-1 「未承認の追加リクエスト」の印が暗黙的である

- **指摘**: 参加者が `POST /api/e/request-add` で作った行と、幹事が登録した行を、
  `claim_token_hash IS NULL AND confirmed_by_organizer_at IS NULL` という**暗黙の組み合わせ**で
  区別している（`src/lib/db/repositories/claims.ts` の `requestAdd` / `claimParticipant`、
  `invoices.ts` の `issueInvoices`）。`participant` には由来を表す列が無く、task_014 の
  `createParticipants` が必ず claim トークンを発行することに依存している。
  実際、`tests/integration/setup.ts` の `insertBaseFixture` が作る参加者（claim トークン無し）は
  この判定では「未承認」に分類される。
- **深刻度**: medium（現在の経路では誤判定は起きないが、将来「個別リンクを発行しない参加者」を
  幹事が作れるようにした瞬間、その行が請求発行と候補一覧から静かに外れる）
- **対応案**: `participant` に `origin text NOT NULL DEFAULT 'organizer' CHECK (origin IN
  ('organizer','participant_request'))` を追加し、判定をその列 1 本にする。
  マイグレーションを伴うため本タスクの files_to_create の外。
- **対応予定タスク**: task_021（名簿まわりの管理面）

## C-015-2 `GET /api/events/:id/join-token` は生のトークンを返せない（C-014-6 の回答）

- **指摘**: `event.join_token_hash` しか保存していないため、発行時の 1 回の応答を取りこぼすと
  サーバーにも復元できない。配布画面（O-7）が「現在の招待リンク」を表示することは構造的にできず、
  リンクを配り直すには `POST /api/events/:id/rotate-join-token`（旧リンクは即無効）を使う。
  本エンドポイントはメタ情報（期限・版・`tokenRetrievable: false`）だけを返す。
- **深刻度**: medium（UX の制約。安全側の設計として意図的に選んだ）
- **対応案**: 配布導線（task_016）で「作成直後にその場で配る」を主導線にし、リンクを失った場合の
  復旧手段として「作り直す（旧リンクは使えなくなります）」を明示する。生のトークンを保存する案は
  採らない（DB 漏洩時に全イベントの招待リンクが漏れるため）。
- **対応予定タスク**: task_016

## C-015-3 招待トークンはリンクのクエリ文字列で運ぶ

- **指摘**: 制約 X-ID（長寿命の識別子を URL **パス**に置かない）は守っているが、招待リンクは
  `?t=<joinToken>` というクエリで参加者へ届く（クリックできるリンクである以上、他に運び方が無い）。
  クエリは Cloudflare のアクセスログや中間装置に記録され得る。着地後はヘッダ
  `X-Join-Token` だけで運び、Cookie にもブラウザの保存領域にも残していない。
  `Referrer-Policy: no-referrer`（middleware）と外部リンクの `rel="noreferrer"` で
  Referer 経由の流出は塞いである。
- **深刻度**: medium
- **対応案**: (a) Cloudflare 側でアクセスログのクエリ文字列を保存しない設定を明文化する、
  (b) 着地直後に `history.replaceState` でクエリを落とす、(c) 長寿命トークンを短命の交換トークンに
  引き換える経路を足す。(b) は本タスクで入れていない（画面の初期化順序に絡むため）。
- **対応予定タスク**: task_024（インフラ）/ task_022（E2E で (b) の挙動を固定）

## C-015-4 レート制限の 429 は実バインディングで未実測

- **指摘**: `GET /api/e/preview` / `POST /api/e/request-add` / `POST /api/e/self-report` は
  `resolveRateLimiter` で IP 単位の制限を掛けるが、ローカルには Workers の Rate Limiting
  バインディングも Durable Object も無い。テストで実測したのは「バックエンドが超過を返せば
  `allowed=false` になること」と「preview ルートが DB 接続より前に判定し `rateLimited()`（429）へ
  写していること（静的）」までで、**実バインディング越しの 429 は未検証**。
- **深刻度**: medium
- **対応案**: deferred: task_035（staging Supabase ＋ Hyperdrive）と task_024（wrangler の
  `[[ratelimits]]` バインディング追加）の完了後に実測する。
- **対応予定タスク**: task_024 / task_035

## C-015-5 `/api/e/*` の Route Handler 自体を走らせる自動テストが無い

- **指摘**: 統合テストはリポジトリ層（`claims.ts` / `invoices.ts` / `join-token.ts`）を実 DB に対して
  直接呼ぶ形で書いた。Route Handler は `getCloudflareContext()` を要するため、同じ隔離
  （`withRollback`）の中では動かせない。「セッション無しは 401」「preview 以外は `requireSession` を
  通る」は `requireSession` の実挙動 ＋ ルートの静的検査で担保している。
- **深刻度**: medium
- **対応案**: task_022 の E2E（Playwright）で P-1〜P-3 を通しで踏む。premortem P-11 の
  「画面を作る各タスクに最小 1 本の a11y/E2E を持たせる」に沿う。
- **対応予定タスク**: task_022

## C-015-6 O-9（要対応インボックス）の分類表示は未実装

- **指摘**: `POST /api/e/cannot-pay` は `invoice.needs_attention` を立て、理由は
  `audit_log.action = 'invoice.no_payment_method'` として残すだけで、O-9 の「支払手段なし」という
  分類表示そのものは作っていない（O-9 は task_021 の scope）。
- **深刻度**: low
- **対応案**: task_021 が `audit_log.action` と `needs_attention` から分類を導く。
- **対応予定タスク**: task_021

## C-015-7 Hyperdrive 経由の実測（A21）

- **指摘**: 本タスクの DB アクセスはすべてローカル Supabase の direct 接続（ロール `app_rw`）で
  検証した。Workers から Hyperdrive 経由で同じクエリが通ることは未実測。
- **深刻度**: low
- **対応案**: deferred: task_035 完了後。
- **対応予定タスク**: task_035
