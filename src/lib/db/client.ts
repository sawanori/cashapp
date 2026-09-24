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

export type DbRoute = "hyperdrive" | "direct";

/** Workers の Hyperdrive バインディングのうち、本モジュールが使う部分だけを写した型。 */
export interface HyperdriveBindingLike {
  readonly connectionString: string;
}

export interface DbEnv {
  /** Cloudflare Workers でのみ存在する（wrangler.toml の [[hyperdrive]] binding = "HYPERDRIVE"）。 */
  readonly HYPERDRIVE?: HyperdriveBindingLike | undefined;
  /** ローカル / CI / マイグレーション用の直接接続。 */
  readonly DATABASE_URL?: string | undefined;
}

export interface ResolvedDbConnection {
  readonly route: DbRoute;
  readonly connectionString: string;
  /** 接続文字列に書かれたロール名。 */
  readonly role: string;
  /** ホスト名（ログ・診断用。パスワードは含まない）。 */
  readonly host: string;
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

  if (!options.allowPrivilegedRole && role !== RUNTIME_DB_ROLE) {
    throw new DbConfigError(
      `runtime database role must be '${RUNTIME_DB_ROLE}', got '${role}' on route '${route}'`,
    );
  }

  return { route, connectionString, role, host };
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
