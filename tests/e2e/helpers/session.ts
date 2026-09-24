/**
 * 幹事・参加者セッションの直接発行（task_022 の e2e ヘルパ）。
 *
 * ★ なぜ要るか: `@line/liff-mock` の既定値は `isInClient: false` で、これを上書きする
 *   経路はアプリ内部の動的 import に閉じており `window` に露出しない
 *   （`docs/vendor-docs/line/liff-sdk.md` §3 / `tests/e2e/share.spec.ts` の docstring）。
 *   したがって Playwright（実ブラウザ）から `liff.login()` 以降へ進める手段が無く、
 *   `POST /api/auth/line` はサーバー側で実際の LINE `/oauth2/v2.1/verify` を叩く
 *   （制約 N2）ため、この E2E 環境で本物の ID トークンを用意することもできない。
 *
 *   そこで、**LINE ログインそのものではなく、その先の画面・API 契約**を検証するために、
 *   `app_user` 行を直接作り、`src/lib/auth/session.ts` と同じ形式のセッション JWT を
 *   本ヘルパで独自に署名する（アプリのコードを import しない — Playwright のテスト
 *   ランナーは Next.js の webpack/turbopack ローダーを経由しないため、`import "server-only"`
 *   を先頭に持つモジュールは読み込めない。`node_modules/server-only/index.js` は
 *   無条件に throw する）。値の形（Cookie 名・issuer・audience・TTL・CSRF 導出式）は
 *   `src/lib/auth/session.ts` / `src/lib/auth/csrf.ts` のコメントに明記された仕様のとおりに
 *   複製してあり、アプリ側の検証ロジックはそのまま使う。
 *
 * ★ 接続情報: ローカル / CI の `app_rw` 接続文字列は `tests/integration/setup.ts` と同じ
 *   既定値（`DATABASE_URL` があればそれを使う）。セッション鍵は `process.env.SESSION_KEYS`
 *   の**先頭**エントリ（`.env.local` に置く。`npm run test:e2e` を起動したシェルの環境変数
 *   として渡る）。無ければ `.env.local` に用意されたローカル専用ダミー値にフォールバックする。
 */

import postgres from "postgres";

const DEFAULT_MIGRATOR_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOCAL_APP_RW_PASSWORD = process.env["APP_RW_PASSWORD"] ?? "app_rw_local_dev_only";

function migratorConnectionString(): string {
  return process.env["DATABASE_URL_MIGRATOR"] ?? DEFAULT_MIGRATOR_URL;
}

function appRwConnectionString(): string {
  const url = new URL(migratorConnectionString());
  url.username = "app_rw";
  url.password = LOCAL_APP_RW_PASSWORD;
  return url.toString();
}

let sqlSingleton: postgres.Sql | undefined;

/** テストプロセス内で使い回す `app_rw` 接続。呼び出し側は後始末（DELETE）だけ行えばよい。 */
export function testSql(): postgres.Sql {
  sqlSingleton ??= postgres(appRwConnectionString(), { max: 2, prepare: false, onnotice: () => undefined });
  return sqlSingleton;
}

export async function closeTestSql(): Promise<void> {
  await sqlSingleton?.end();
  sqlSingleton = undefined;
}

export function uniq(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** `tests/integration/setup.ts` の `RollbackSignal` と同じ番兵。`withRollback` 以外では投げない。 */
class RollbackSignal extends Error {
  public constructor() {
    super("rollback");
    this.name = "RollbackSignal";
  }
}

/**
 * `tests/integration/setup.ts` の `withRollback` の複製（アプリのコードと同じ意味だが、
 * あちらは `import.meta.url` を使っており Playwright のテストランナーの transform では
 * 読み込めないため、ここに複製する）。フィクスチャをトランザクション内で作り、
 * 結果だけを取り出して必ずロールバックする。`audit_log` のような追記専用・グローバルな
 * テーブルに実コミットで行を残さないために使う。
 */
export async function withRollback<T>(
  sql: postgres.Sql,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  let captured: { value: T } | undefined;
  try {
    await sql.begin(async (tx) => {
      captured = { value: await fn(tx) };
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
  if (captured === undefined) {
    throw new Error("withRollback: callback did not complete");
  }
  return captured.value;
}

/** `SESSION_KEYS` の先頭エントリ（`<kid>:<secret>`）。`.env.local` から渡る。 */
function currentSessionKey(): { readonly kid: string; readonly secret: string } {
  const raw = process.env["SESSION_KEYS"] ?? "devkey1:local-dev-session-key-1-not-a-real-secret-0";
  const first = raw.split(",")[0]?.trim() ?? "";
  const sep = first.indexOf(":");
  if (sep <= 0) {
    throw new Error("SESSION_KEYS の先頭エントリが '<kid>:<secret>' の形式ではありません");
  }
  return { kid: first.slice(0, sep), secret: first.slice(sep + 1) };
}

// `export` する理由: `tests/unit/e2e-helpers-session-contract.test.ts`（契約テスト）が
// `src/lib/auth/session.ts` の同名の値と突き合わせ、アプリ側の仕様が変わったのに
// この複製が追随していない状態を検出する（docs/concerns/task_022.md #3 の対応の一部）。
export const SESSION_COOKIE_NAME = "__Host-session";
export const SESSION_ISSUER = "cashapp";
export const SESSION_AUDIENCE = "cashapp-session";
export const SESSION_TTL_SECONDS = 30 * 60;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(mac);
}

export interface SeededSession {
  readonly userId: string;
  readonly cookieHeader: string;
  readonly csrfToken: string;
}

/**
 * `app_user` 行を作り、`src/lib/auth/session.ts` と互換なセッション JWT を発行する。
 * `identity_scope` は `e2e-test:` 接頭辞で始め、テスト後の一括後始末を容易にする。
 */
export async function seedOrganizerSession(labelSuffix: string): Promise<SeededSession> {
  const sql = testSql();
  const ref = Buffer.from(`e2e-organizer-${labelSuffix}`);
  const rows = await sql<{ id: string; session_epoch: number }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${ref}, ${`e2e-test:${labelSuffix}`}, 'development')
    RETURNING id, session_epoch
  `;
  const row = rows[0]!;
  const { kid, secret } = currentSessionKey();
  const jti = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const nowSeconds = Math.floor(Date.now() / 1000);

  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", kid, typ: "JWT" })));
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        epoch: row.session_epoch,
        iss: SESSION_ISSUER,
        aud: SESSION_AUDIENCE,
        sub: row.id,
        jti,
        iat: nowSeconds,
        exp: nowSeconds + SESSION_TTL_SECONDS,
      }),
    ),
  );
  const signature = base64Url(await hmacSha256(secret, `${header}.${payload}`));
  const token = `${header}.${payload}.${signature}`;

  const csrfToken = base64Url(await hmacSha256(secret, `csrf:${jti}`));

  return {
    userId: row.id,
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
    csrfToken,
  };
}

/**
 * テストが作った `e2e-test:` 接頭辞の app_user とその従属行を片付ける。
 *
 * ★ `app_user` を単独で DELETE すると `event.organizer_user_id`（`ON DELETE RESTRICT`）に
 *   阻まれて外部キー違反になる — 実際に発生した事故（`docs/run-log/task_022.json`、
 *   `PostgresError: ... violates foreign key constraint "event_organizer_user_id_fkey"`）。
 *   `POST /api/events` が 500 を返しても（`docs/concerns/task_022.md` #1 の timestamptz
 *   不具合）内部で `event` 行だけ実コミットされて残るケースがあるため、テストの成否に
 *   関わらず従属行を先に消す必要がある。`event` を DELETE すれば `participant` /
 *   `invoice` / `participant_claim` / `payment_attempt` / `payment_self_report` /
 *   `abuse_report` は `ON DELETE CASCADE` で連鎖するが、`manual_attestation.invoice_id` /
 *   `ledger_entry.{invoice_id,event_id}` は `ON DELETE` 指定が無い（`NO ACTION`）ため
 *   明示的に先に消す必要がある。
 *
 * ★ `ledger_entry` は追記専用（`forbid_mutation` トリガーが UPDATE/DELETE/TRUNCATE を
 *   文レベルで常に拒否する。件数 0 でも発火する）ため、**この関数からは一切 DELETE しない**
 *   （設計上そうあるべきで、バグではない）。`manual-attest` まで到達した e2e フィクスチャは
 *   `ledger_entry` 行を持つため `event` の DELETE が `ledger_entry_event_id_fkey` で失敗し
 *   得る。その場合は該当行が恒久的に残ることを許容し（`identity_scope` が
 *   `e2e-test:` 接頭辞なので実データと混ざらない）、例外を投げてテストの本来の
 *   assertion 失敗を後始末の失敗で覆い隠さないよう `console.warn` に留める。
 */
export async function cleanupE2eUsers(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const sql = testSql();
  const ids = [...userIds];

  await sql`
    DELETE FROM manual_attestation
    WHERE invoice_id IN (
      SELECT i.id FROM invoice i
      JOIN event e ON e.id = i.event_id
      WHERE e.organizer_user_id = ANY(${sql.array(ids)}::uuid[])
    )
  `;
  await sql`DELETE FROM consent_log WHERE user_id = ANY(${sql.array(ids)}::uuid[])`;
  await sql`DELETE FROM provider_binding WHERE organizer_user_id = ANY(${sql.array(ids)}::uuid[])`;
  await sql`DELETE FROM reminder_log WHERE sent_by_organizer = ANY(${sql.array(ids)}::uuid[])`;

  try {
    await sql`DELETE FROM event WHERE organizer_user_id = ANY(${sql.array(ids)}::uuid[])`;
  } catch (error) {
    // `ledger_entry` が参照している場合はここで失敗する（上の docstring を参照）。
    // 後始末の失敗でテスト本体の結果を覆い隠さない。
    console.warn(
      "cleanupE2eUsers: event の削除に失敗しました（ledger_entry が参照している可能性があります。" +
        "e2e-test: 接頭辞のフィクスチャなので実データとは混ざりません）:",
      error,
    );
  }

  try {
    await sql`DELETE FROM app_user WHERE id = ANY(${sql.array(ids)}::uuid[])`;
  } catch (error) {
    console.warn("cleanupE2eUsers: app_user の削除に失敗しました（従属行が残っています）:", error);
  }
}
