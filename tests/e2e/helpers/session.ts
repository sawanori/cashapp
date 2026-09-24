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

const SESSION_COOKIE_NAME = "__Host-session";
const SESSION_ISSUER = "cashapp";
const SESSION_AUDIENCE = "cashapp-session";
const SESSION_TTL_SECONDS = 30 * 60;

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

/** テストが作った `e2e-test:` 接頭辞の app_user とその従属行を片付ける。 */
export async function cleanupE2eUsers(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const sql = testSql();
  await sql`DELETE FROM app_user WHERE id = ANY(${sql.array([...userIds])}::uuid[])`;
}
