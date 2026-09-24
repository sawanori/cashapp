/**
 * `src/lib/db/client.ts` の接続文字列解決のユニットテスト（DB に接続しない）。
 *
 * done_definition:「client.ts の接続文字列解決が Workers 経路（Hyperdrive バインディング）と
 * direct 経路の二経路を持ち、ランタイム経路が Hyperdrive 由来であることをユニットテストで確認」。
 *
 * `client.ts` は `import "server-only"` を持つ。server-only パッケージは
 * `react-server` 条件が無い解決経路（＝このテストランナー）で読むと throw する設計なので、
 * ここではモジュールを空実装に差し替える。`import "server-only"` 自体が消えるわけではなく、
 * Next.js のビルドでクライアントから参照されればビルドが落ちる挙動はそのまま残る。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  DbConfigError,
  PRIVILEGED_ROLE_DEV_APP_ENV,
  PRIVILEGED_ROLE_DEV_FLAG,
  RUNTIME_DB_ROLE,
  resolveDbConnection,
} = await import("@/lib/db/client");

const APP_RW_URL = "postgresql://app_rw:pw@db.example.internal:5432/postgres";
const HYPERDRIVE_URL = "postgresql://app_rw:hyperdrive-pw@127.0.0.1:41234/postgres";
const PRIVILEGED_URL = "postgresql://postgres:pw@127.0.0.1:54322/postgres";
/** wrangler.toml の [[hyperdrive]] localConnectionString と同じ形（ロール postgres・ループバック）。 */
const LOCAL_HYPERDRIVE_PRIVILEGED_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
/** 同じくロール postgres だが、接続先がループバックではない。 */
const REMOTE_PRIVILEGED_URL = "postgresql://postgres:pw@db.example.internal:5432/postgres";

describe("resolveDbConnection", () => {
  it("Workers ランタイムでは Hyperdrive バインディング由来の接続文字列を返す", () => {
    const resolved = resolveDbConnection({
      HYPERDRIVE: { connectionString: HYPERDRIVE_URL },
      DATABASE_URL: APP_RW_URL,
    });
    expect(resolved.route).toBe("hyperdrive");
    expect(resolved.connectionString).toBe(HYPERDRIVE_URL);
    expect(resolved.role).toBe(RUNTIME_DB_ROLE);
    expect(resolved.host).toBe("127.0.0.1");
  });

  it("Hyperdrive バインディングが無ければ direct 経路（DATABASE_URL）にフォールバックする", () => {
    const resolved = resolveDbConnection({ DATABASE_URL: APP_RW_URL });
    expect(resolved.route).toBe("direct");
    expect(resolved.connectionString).toBe(APP_RW_URL);
    expect(resolved.role).toBe("app_rw");
    expect(resolved.host).toBe("db.example.internal");
  });

  it("空文字の connectionString は未設定として扱い direct にフォールバックする", () => {
    const resolved = resolveDbConnection({
      HYPERDRIVE: { connectionString: "" },
      DATABASE_URL: APP_RW_URL,
    });
    expect(resolved.route).toBe("direct");
  });

  it("どちらも無ければ DbConfigError", () => {
    expect(() => resolveDbConnection({})).toThrow(DbConfigError);
  });

  it("ランタイム経路で app_rw 以外のロールは拒否する（service role をランタイムに置かせない）", () => {
    expect(() => resolveDbConnection({ DATABASE_URL: PRIVILEGED_URL })).toThrow(DbConfigError);
    expect(() =>
      resolveDbConnection({ HYPERDRIVE: { connectionString: PRIVILEGED_URL } }),
    ).toThrow(/must be 'app_rw'/);
  });

  it("allowPrivilegedRole を明示したときだけ特権ロールを許す（マイグレーション経路）", () => {
    const resolved = resolveDbConnection(
      { DATABASE_URL: PRIVILEGED_URL },
      { allowPrivilegedRole: true },
    );
    expect(resolved.route).toBe("direct");
    expect(resolved.role).toBe("postgres");
    expect(resolved.privilegedRoleGrant).toBe("option");
  });

  it("app_rw なら privilegedRoleGrant は 'none'", () => {
    expect(resolveDbConnection({ DATABASE_URL: APP_RW_URL }).privilegedRoleGrant).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// ローカル開発専用の opt-in フラグ（task_011 レビュー修正）。
// 4 条件（direct 経路 / フラグ "1" / APP_ENV development / ループバック）を
// 1 つずつ欠けさせて、抜け道が本番に届かないことを確かめる。
//
// ★ 経路の条件は後追いの修正で足した。wrangler.toml の既定環境（name = "cashapp-dev"）は
//   デプロイ可能で、その [vars] APP_ENV は "development" である。つまり APP_ENV だけでは
//   「ローカルに限る」条件にならない。Hyperdrive バインディングはデプロイ後の
//   ランタイムにこそ存在するので、hyperdrive 経路では常に拒否する。
// ---------------------------------------------------------------------------
describe(`resolveDbConnection: ${PRIVILEGED_ROLE_DEV_FLAG}（ローカル開発専用）`, () => {
  const devEnvBase = {
    APP_ENV: PRIVILEGED_ROLE_DEV_APP_ENV,
    ALLOW_PRIVILEGED_DB_ROLE: "1",
  } as const;

  it("4 条件が揃えば direct 経路で postgres ロールを通す", () => {
    const resolved = resolveDbConnection({
      ...devEnvBase,
      DATABASE_URL: LOCAL_HYPERDRIVE_PRIVILEGED_URL,
    });
    expect(resolved.route).toBe("direct");
    expect(resolved.role).toBe("postgres");
    expect(resolved.privilegedRoleGrant).toBe("local-dev-flag");
  });

  it("hyperdrive 経路では 4 条件が揃っていてもフラグは効かない（デプロイ済み Worker に届かせない）", () => {
    expect(() =>
      resolveDbConnection({
        ...devEnvBase,
        HYPERDRIVE: { connectionString: LOCAL_HYPERDRIVE_PRIVILEGED_URL },
      }),
    ).toThrow(DbConfigError);
    expect(() =>
      resolveDbConnection({
        ...devEnvBase,
        HYPERDRIVE: { connectionString: LOCAL_HYPERDRIVE_PRIVILEGED_URL },
      }),
    ).toThrow(/must be 'app_rw'/);
    // DATABASE_URL が併記されていても、Hyperdrive が優先される以上は拒否のまま。
    expect(() =>
      resolveDbConnection({
        ...devEnvBase,
        HYPERDRIVE: { connectionString: LOCAL_HYPERDRIVE_PRIVILEGED_URL },
        DATABASE_URL: LOCAL_HYPERDRIVE_PRIVILEGED_URL,
      }),
    ).toThrow(DbConfigError);
  });

  it("localhost と [::1] もループバックとして通す", () => {
    for (const url of [
      "postgresql://postgres:pw@localhost:54322/postgres",
      "postgresql://postgres:pw@[::1]:54322/postgres",
    ]) {
      const resolved = resolveDbConnection({ ...devEnvBase, DATABASE_URL: url });
      expect(resolved.privilegedRoleGrant).toBe("local-dev-flag");
    }
  });

  it("APP_ENV が development 以外ならフラグは効かない（staging / production に届かない）", () => {
    for (const appEnv of ["staging", "production", "", undefined]) {
      expect(() =>
        resolveDbConnection({
          ALLOW_PRIVILEGED_DB_ROLE: "1",
          APP_ENV: appEnv,
          DATABASE_URL: LOCAL_HYPERDRIVE_PRIVILEGED_URL,
        }),
      ).toThrow(DbConfigError);
    }
  });

  it("接続先がループバックでなければフラグは効かない", () => {
    expect(() =>
      resolveDbConnection({
        ...devEnvBase,
        DATABASE_URL: REMOTE_PRIVILEGED_URL,
      }),
    ).toThrow(/must be 'app_rw'/);
  });

  it("フラグの値が '1' 以外（true / yes / 0 / 未設定）なら効かない", () => {
    for (const flag of ["true", "yes", "0", "", " 1", undefined]) {
      expect(() =>
        resolveDbConnection({
          APP_ENV: PRIVILEGED_ROLE_DEV_APP_ENV,
          ALLOW_PRIVILEGED_DB_ROLE: flag,
          DATABASE_URL: LOCAL_HYPERDRIVE_PRIVILEGED_URL,
        }),
      ).toThrow(DbConfigError);
    }
  });

  it("フラグが立っていてもロールが app_rw なら grant は 'none' のまま", () => {
    const resolved = resolveDbConnection({
      ...devEnvBase,
      HYPERDRIVE: { connectionString: HYPERDRIVE_URL },
    });
    expect(resolved.role).toBe(RUNTIME_DB_ROLE);
    expect(resolved.privilegedRoleGrant).toBe("none");
  });

  it("エラーメッセージに接続文字列（パスワード）を含めない", () => {
    try {
      resolveDbConnection({ DATABASE_URL: PRIVILEGED_URL });
      throw new Error("expected resolveDbConnection to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("pw");
      expect(message).not.toContain(PRIVILEGED_URL);
    }
  });

  it("Postgres 以外のスキームや壊れた URL は DbConfigError（原文を出さない）", () => {
    expect(() => resolveDbConnection({ DATABASE_URL: "mysql://app_rw:pw@h:3306/d" })).toThrow(
      DbConfigError,
    );
    expect(() => resolveDbConnection({ DATABASE_URL: "not-a-url" })).toThrow(DbConfigError);
  });
});

// ---------------------------------------------------------------------------
// クエリパラメータによる StartupMessage 注入（task_011 レビュー指摘 high）。
//
// postgres.js は `defaults` に無いクエリパラメータを options.connection に積み、
// StartupMessage は Object.assign({ user, ... }, options.connection) で組まれる。
// そのため `?user=postgres` を足すだけで URL.username の検査を迂回でき、
// 実際に `postgres://app_rw:postgres@127.0.0.1:54322/postgres?user=postgres` が
// session_user = 'postgres' で繋がることを本タスクで実測した。
// ---------------------------------------------------------------------------
describe("resolveDbConnection: 接続文字列のクエリパラメータ", () => {
  const withQuery = (query: string): string =>
    `postgresql://app_rw:pw@127.0.0.1:54322/postgres?${query}`;

  it("?user= によるロール偽装は direct / hyperdrive のどちらの経路でも拒否する", () => {
    const spoofed = withQuery("user=postgres");
    expect(() => resolveDbConnection({ DATABASE_URL: spoofed })).toThrow(DbConfigError);
    expect(() => resolveDbConnection({ HYPERDRIVE: { connectionString: spoofed } })).toThrow(
      DbConfigError,
    );
    expect(() => resolveDbConnection({ DATABASE_URL: spoofed })).toThrow(/query parameter/);
    // allowPrivilegedRole（マイグレーション経路）でも素通りさせない。
    expect(() =>
      resolveDbConnection({ DATABASE_URL: spoofed }, { allowPrivilegedRole: true }),
    ).toThrow(DbConfigError);
  });

  it("StartupMessage に転送されうる他のキーも拒否する", () => {
    for (const query of [
      "options=-c%20role%3Dpostgres",
      "database=other",
      "dbname=other",
      "replication=database",
      "application_name=spoof",
      "username=postgres",
      "password=leak",
    ]) {
      expect(() => resolveDbConnection({ DATABASE_URL: withQuery(query) })).toThrow(DbConfigError);
    }
  });

  it("エラーメッセージにキー名だけを出し、値は出さない", () => {
    try {
      resolveDbConnection({ DATABASE_URL: withQuery("user=postgres") });
      throw new Error("expected resolveDbConnection to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("user");
      expect(message).not.toContain("postgres:pw");
      expect(message).not.toContain("pw@");
    }
  });

  it("postgres.js がクライアント側で消費する既知のキーは通す", () => {
    const resolved = resolveDbConnection({
      DATABASE_URL: withQuery("sslmode=require&connect_timeout=10&prepare=false"),
    });
    expect(resolved.role).toBe(RUNTIME_DB_ROLE);
    expect(resolved.host).toBe("127.0.0.1");
  });
});
