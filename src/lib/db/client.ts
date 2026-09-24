/**
 * DB 接続（サーバー専用）。
 *
 * ★ 接続文字列の解決は `resolveDbConnection()` **1 関数に集約**する。経路は 2 つだけ:
 *
 *   1. `hyperdrive` — Cloudflare Workers ランタイム。`env.HYPERDRIVE.connectionString` を使う。
 *      `connectionString` は wrangler が生成した型定義（worker-configuration.d.ts の
 *      `interface Hyperdrive`）に実在する読み取り専用プロパティである [実測]。
 *   2. `direct` — ローカル開発 / CI / マイグレーション。`DATABASE_URL` を使う。
 *
 * ★ ランタイムのロールは最小権限の `app_rw` でなければならない（R-SEC-03）。
 *   service role / postgres スーパーユーザーをランタイム環境変数に置かない。
 *   `resolveDbConnection()` は既定でロールを検査し、`app_rw` 以外なら失敗する。
 *   マイグレーションツール（gates-sync 等）だけが `allowPrivilegedRole` で明示的に外す。
 *
 * ★ ロール検査は**二重**にする。文字列の見た目だけでは足りない（task_011 レビュー指摘）。
 *   1. 静的: `parseConnection()` が `URL.username` を見るのに加えて、**クエリパラメータを
 *      許可リストで弾く**。postgres.js は `defaults` に無いクエリパラメータを
 *      `options.connection` に入れ（node_modules/postgres/cjs/src/index.js:437,485）、
 *      StartupMessage が `Object.assign({ user, ... }, options.connection)` で組まれるため
 *      （同 connection.js:996-1006）、`?user=postgres` を足すだけで `URL.username` を
 *      迂回して別ロールで接続できてしまう。本セッションで実測済み:
 *      `postgres://app_rw:postgres@127.0.0.1:54322/postgres?user=postgres` は
 *      `URL.username = 'app_rw'` のまま `session_user = 'postgres'` で繋がった。
 *   2. 実行時: `createVerifiedDbClient()` が接続直後に `SELECT session_user` を 1 回だけ
 *      発行し、接続文字列が名乗るロールと一致しなければ接続を閉じて `DbRoleMismatchError`。
 *      静的検査を将来すり抜けられても、実ロールで止まる。
 *
 * ★ ローカル開発の抜け道は 1 つだけ、しかも四重に締める（`ALLOW_PRIVILEGED_DB_ROLE`）。
 *   次の 4 条件が**すべて**成立するときに限り特権ロールを通す:
 *     1. 経路が `direct`（= `DATABASE_URL`）。Hyperdrive 経路では**常に**拒否する。
 *        `wrangler.toml` の既定環境（`name = "cashapp-dev"`）の `[vars] APP_ENV` は
 *        `"development"` であり、既定環境はデプロイ可能なので、APP_ENV だけでは
 *        「ローカルに限る」条件にならない（task_011 レビュー指摘）。Hyperdrive
 *        バインディングはデプロイ後のランタイムにこそ存在するため、経路で切る。
 *     2. `ALLOW_PRIVILEGED_DB_ROLE` が厳密に文字列 `"1"`
 *     3. `APP_ENV` が厳密に `"development"`
 *     4. 接続先ホストがループバック（127.0.0.1 / localhost / ::1）
 *   このフラグは `.dev.vars.example` にだけ書く。`.env.example` のランタイム欄には置かない
 *   （統合テスト check_069 が両方を機械検査する）。
 *
 *   ローカルの `wrangler dev` / `npm run cf:dev` は Hyperdrive 経路なのでこのフラグでは
 *   通らない。ローカルで Hyperdrive 経路を動かすには、Hyperdrive の一次資料
 *   （docs/vendor-docs/cloudflare/hyperdrive.md「方法 2」）どおり環境変数
 *   `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` に `app_rw` の接続文字列を
 *   与える（環境変数は `wrangler.toml` の `localConnectionString` より優先される）。
 *   恒久対処は task_035（`localConnectionString` 自体を `app_rw` に揃える）。
 *
 * ★ advisory lock は**トランザクションスコープの `pg_try_advisory_xact_lock` のみ**使う。
 *   セッションスコープの `pg_advisory_lock` / `pg_try_advisory_lock` は、接続プーラ
 *   （Hyperdrive / Supavisor）を挟むと「ロックを取った接続」と「解放する接続」が
 *   一致せずロックが残留する（R-OPS-08）。このモジュールはセッションスコープの API を
 *   一切公開しない。
 *
 * ★ 例外メッセージに接続文字列（パスワードを含む）を入れない。出すのはロール名とホスト名まで。
 */

import "server-only";

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/** ランタイムが使ってよい唯一の DB ロール。 */
export const RUNTIME_DB_ROLE = "app_rw";

/**
 * ローカル開発でだけ特権ロール接続を許す明示フラグの名前。
 * 値は厳密に `"1"` のときだけ有効。`.dev.vars.example` にのみ記載する。
 */
export const PRIVILEGED_ROLE_DEV_FLAG = "ALLOW_PRIVILEGED_DB_ROLE";

/** 上のフラグが効く唯一の `APP_ENV`。 */
export const PRIVILEGED_ROLE_DEV_APP_ENV = "development";

/** 上のフラグが効く唯一の接続先。`URL.hostname` は `::1` を `[::1]` にする。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 接続文字列に書いてよいクエリパラメータ。
 *
 * postgres.js の `parseOptions()` は、ここに挙げたキー（= 同ライブラリの `defaults` に
 * あるキー）だけをクライアント側オプションとして消費し、**それ以外のすべてのキーを
 * `options.connection` に積んで StartupMessage に転送する**
 * （node_modules/postgres/cjs/src/index.js:437,485 / connection.js:996-1006）。
 * 転送されるキーには `user`（接続ロールの上書き）・`database`・`options`（`-c` による
 * サーバ設定の注入）・`replication` が含まれるため、許可リスト外は一律で拒否する。
 * `sslmode` は `parseOptions()` が `ssl` に読み替えてからクエリから削除するので安全。
 */
const ALLOWED_CONNECTION_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "max",
  "ssl",
  "sslmode",
  "sslnegotiation",
  "idle_timeout",
  "connect_timeout",
  "max_lifetime",
  "max_pipeline",
  "backoff",
  "keep_alive",
  "prepare",
  "debug",
  "fetch_types",
  "publications",
  "target_session_attrs",
]);

export type DbRoute = "hyperdrive" | "direct";

/** 特権ロールが通った理由。通常は `"none"`（= ロールが `app_rw`）。 */
export type PrivilegedRoleGrant = "none" | "option" | "local-dev-flag";

/** Workers の Hyperdrive バインディングのうち、本モジュールが使う部分だけを写した型。 */
export interface HyperdriveBindingLike {
  readonly connectionString: string;
}

export interface DbEnv {
  /** Cloudflare Workers でのみ存在する（wrangler.toml の [[hyperdrive]] binding = "HYPERDRIVE"）。 */
  readonly HYPERDRIVE?: HyperdriveBindingLike | undefined;
  /** ローカル / CI / マイグレーション用の直接接続。 */
  readonly DATABASE_URL?: string | undefined;
  /** `wrangler.toml` の `[vars]`。development / staging / production。 */
  readonly APP_ENV?: string | undefined;
  /** ローカル開発専用の opt-in フラグ。`.dev.vars` にだけ置く。 */
  readonly ALLOW_PRIVILEGED_DB_ROLE?: string | undefined;
}

export interface ResolvedDbConnection {
  readonly route: DbRoute;
  readonly connectionString: string;
  /** 接続文字列に書かれたロール名。 */
  readonly role: string;
  /** ホスト名（ログ・診断用。パスワードは含まない）。 */
  readonly host: string;
  /** `app_rw` 以外のロールが通った場合、その理由。`app_rw` なら `"none"`。 */
  readonly privilegedRoleGrant: PrivilegedRoleGrant;
}

export interface ResolveDbConnectionOptions {
  /**
   * `app_rw` 以外のロール（postgres / service role）を許す。
   * マイグレーションと運用スクリプトのみ true にしてよい。ランタイム経路では常に false。
   */
  readonly allowPrivilegedRole?: boolean;
}

/** 設定不備。`message` に秘密値を含めない。 */
export class DbConfigError extends Error {
  public readonly code = "db_config_error";

  public constructor(message: string) {
    super(message);
    this.name = "DbConfigError";
  }
}

interface ParsedConnection {
  readonly role: string;
  readonly host: string;
}

function parseConnection(connectionString: string, route: DbRoute): ParsedConnection {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // 元の文字列は絶対に出さない。
    throw new DbConfigError(`database connection string for route '${route}' is not a valid URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DbConfigError(
      `database connection string for route '${route}' has unsupported protocol '${url.protocol}'`,
    );
  }
  // ★ クエリパラメータによる StartupMessage 注入を塞ぐ（`?user=` によるロール偽装ほか）。
  //   出すのはキー名だけ。値は秘密値になりうるので絶対に出さない。
  const disallowed = [...new Set(url.searchParams.keys())]
    .filter((key) => !ALLOWED_CONNECTION_QUERY_PARAMS.has(key))
    .sort();
  if (disallowed.length > 0) {
    throw new DbConfigError(
      `database connection string for route '${route}' has disallowed query parameter(s): ${disallowed.join(", ")}`,
    );
  }
  const role = decodeURIComponent(url.username);
  if (role.length === 0) {
    throw new DbConfigError(`database connection string for route '${route}' has no role`);
  }
  return { role, host: url.hostname };
}

/**
 * 接続文字列を解決する唯一の関数。
 *
 * 優先順位は Hyperdrive バインディング → `DATABASE_URL`。Workers ランタイムでは
 * バインディングが必ず存在するため、ランタイムの経路は常に `hyperdrive` になる。
 */
export function resolveDbConnection(
  env: DbEnv,
  options: ResolveDbConnectionOptions = {},
): ResolvedDbConnection {
  const hyperdriveConnectionString = env.HYPERDRIVE?.connectionString;

  let route: DbRoute;
  let connectionString: string;

  if (typeof hyperdriveConnectionString === "string" && hyperdriveConnectionString.length > 0) {
    route = "hyperdrive";
    connectionString = hyperdriveConnectionString;
  } else if (typeof env.DATABASE_URL === "string" && env.DATABASE_URL.length > 0) {
    route = "direct";
    connectionString = env.DATABASE_URL;
  } else {
    throw new DbConfigError(
      "no database connection available: neither the HYPERDRIVE binding nor DATABASE_URL is set",
    );
  }

  const { role, host } = parseConnection(connectionString, route);

  let privilegedRoleGrant: PrivilegedRoleGrant = "none";
  if (role !== RUNTIME_DB_ROLE) {
    if (options.allowPrivilegedRole === true) {
      privilegedRoleGrant = "option";
    } else if (isLocalDevPrivilegedOverride(env, route, host)) {
      privilegedRoleGrant = "local-dev-flag";
    } else {
      throw new DbConfigError(
        `runtime database role must be '${RUNTIME_DB_ROLE}', got '${role}' on route '${route}'`,
      );
    }
  }

  return { route, connectionString, role, host, privilegedRoleGrant };
}

/**
 * ローカル開発の opt-in。4 条件すべてが成立したときだけ true。
 * 1 つでも欠ければ false を返し、呼び出し側は通常どおり `DbConfigError` を投げる。
 *
 * 経路の条件を先に見る: Hyperdrive バインディングはデプロイ後の Workers ランタイムに
 * こそ存在するため、`hyperdrive` 経路でこのフラグを効かせてはいけない。
 * `APP_ENV === "development"` は `wrangler.toml` の既定環境（デプロイ可能）の値でもあり、
 * 単独では「ローカルに限る」条件にならない。
 */
function isLocalDevPrivilegedOverride(env: DbEnv, route: DbRoute, host: string): boolean {
  if (route !== "direct") return false;
  if (env.ALLOW_PRIVILEGED_DB_ROLE !== "1") return false;
  if (env.APP_ENV !== PRIVILEGED_ROLE_DEV_APP_ENV) return false;
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export interface DbHandle {
  readonly db: PostgresJsDatabase<typeof schema>;
  readonly sql: postgres.Sql;
  readonly route: DbRoute;
  readonly role: string;
  /** 接続を閉じる。Workers では `ctx.waitUntil(handle.close())` で呼ぶ。 */
  close(): Promise<void>;
}

export interface CreateDbClientOptions extends ResolveDbConnectionOptions {
  /** プール上限。Workers のアイソレートあたりの同時接続を絞る。 */
  readonly max?: number;
}

/**
 * 接続を作る。Workers ではリクエスト単位で作り、終了時に `close()` する。
 *
 * `prepare: false` — 接続プーラ（Hyperdrive / Supavisor）を挟むと名前付きプリペアド
 * ステートメントが接続をまたいで再利用できないため、保守的に無効にする。postgres.js の
 * 実在オプション（node_modules/postgres/types/index.d.ts で確認）[実測]。
 *
 * `fetch_types` は既定（true）のままにする。false にすると配列型（compliance_gate.required_for
 * など）が生の Postgres 配列リテラル文字列として返り、静かに壊れることを本タスクで実測した。
 * 起動時の型カタログ照会 1 往復を削れるかは Hyperdrive 実機での計測待ち（task_035）。[実測]
 */
export function createDbClient(env: DbEnv, options: CreateDbClientOptions = {}): DbHandle {
  const resolved = resolveDbConnection(env, options);
  const client = postgres(resolved.connectionString, {
    max: options.max ?? 5,
    prepare: false,
  });
  return {
    db: drizzle(client, { schema }),
    sql: client,
    route: resolved.route,
    role: resolved.role,
    close: async (): Promise<void> => {
      await client.end();
    },
  };
}

/**
 * 接続文字列が名乗るロールと、サーバが実際に認識しているロールの食い違い。
 * 文字列レベルの検査（`parseConnection`）を迂回されたときの最後の砦。
 */
export class DbRoleMismatchError extends Error {
  public readonly code = "db_role_mismatch";

  public constructor(message: string) {
    super(message);
    this.name = "DbRoleMismatchError";
  }
}

/**
 * 接続が実際に名乗っているロール（`session_user`）が `expectedRole` と一致することを
 * サーバに問い合わせて確かめる。一致しなければ `DbRoleMismatchError`。
 *
 * `session_user` を見るのは、`SET ROLE` 後も「認証に使われたロール」が分かるため。
 * メッセージにはロール名しか入れない（接続文字列・パスワードを出さない）。
 */
export async function assertSessionRole(sql: postgres.Sql, expectedRole: string): Promise<void> {
  const rows = await sql<{ actual_role: string }[]>`SELECT session_user AS actual_role`;
  const actual = rows[0]?.actual_role;
  if (actual !== expectedRole) {
    throw new DbRoleMismatchError(
      `database session role mismatch: connection string declares '${expectedRole}' but the server reports '${actual ?? "<none>"}'`,
    );
  }
}

/**
 * `createDbClient()` に実ロールの検査を足したもの。ランタイムはこちらを使う。
 *
 * 接続直後に `SELECT session_user` を 1 回だけ発行し、食い違えば接続を閉じてから投げる。
 * 接続文字列に `?user=` を足して `URL.username` を迂回する経路（本タスクで実測）を、
 * 静的検査が将来抜けても実ロールで止めるための二重化。
 */
export async function createVerifiedDbClient(
  env: DbEnv,
  options: CreateDbClientOptions = {},
): Promise<DbHandle> {
  const handle = createDbClient(env, options);
  try {
    await assertSessionRole(handle.sql, handle.role);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}

/**
 * トランザクションスコープの advisory lock を試みる。取得できたら true。
 *
 * トランザクション終了時に自動解放されるため、プーラを挟んでもロックが残らない。
 * セッションスコープ（`pg_try_advisory_lock`）はこのモジュールでは提供しない。
 */
export async function tryAdvisoryXactLock(
  tx: postgres.TransactionSql,
  lockKey: bigint,
): Promise<boolean> {
  // bigint はドライバのパラメータ型に無いので、文字列で渡して SQL 側で bigint にキャストする。
  const rows = await tx<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(${lockKey.toString()}::bigint) AS locked
  `;
  return rows[0]?.locked === true;
}

/** 監査連鎖の直列化に使う advisory lock キー（§10-1）。 */
export const AUDIT_CHAIN_LOCK_KEY = 8_314_001n;

/** drizzle の raw SQL タグを再輸出する（リポジトリ層が drizzle-orm を直接読まなくて済むように）。 */
export { drizzleSql as sql };
