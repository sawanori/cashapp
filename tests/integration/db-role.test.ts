/**
 * ランタイム DB ロールの**実効**検査（task_011 レビュー指摘 high の遮断テスト）。
 *
 * done_definition「ランタイム接続文字列が app_rw であることをテストで確認」は、
 * 文字列の見た目しか担保していなかった。postgres.js は `defaults` に無いクエリ
 * パラメータを `options.connection` に積み、StartupMessage は
 * `Object.assign({ user, ... }, options.connection)` で組まれるため、
 * `?user=postgres` を足すだけで `URL.username` の検査を迂回して別ロールで接続できる。
 * ここではその迂回が実在することを実 DB で示し、修正後の `resolveDbConnection()` が
 * 静的に弾くこと、さらに `createVerifiedDbClient()` が実ロールで二重に止めることを証明する。
 *
 * `client.ts` は `import "server-only"` を持つので、ユニットテストと同じくモックする。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  appRwConnectionString,
  createMigratorSql,
  ensureAppRwLoginPassword,
  migratorConnectionString,
} from "./setup";

vi.mock("server-only", () => ({}));

const {
  DbConfigError,
  DbRoleMismatchError,
  RUNTIME_DB_ROLE,
  assertSessionRole,
  createVerifiedDbClient,
  resolveDbConnection,
} = await import("@/lib/db/client");

let migrator: postgres.Sql;

/**
 * 「見た目は app_rw、実際は特権ロール」の接続文字列。
 * migrator（postgres）のパスワードをそのまま使い、ユーザー名だけ app_rw に偽装して
 * `?user=` で本当のロールを注入する。
 */
function spoofedConnectionString(): { connectionString: string; realRole: string } {
  const url = new URL(migratorConnectionString());
  const realRole = url.username;
  url.username = RUNTIME_DB_ROLE;
  url.searchParams.set("user", realRole);
  return { connectionString: url.toString(), realRole };
}

beforeAll(async () => {
  migrator = createMigratorSql();
  await ensureAppRwLoginPassword(migrator);
});

afterAll(async () => {
  await migrator?.end({ timeout: 5 });
});

describe("ランタイム DB ロールの実効検査", () => {
  it("?user= を足した接続文字列は URL 上 app_rw に見えて実ロールが変わる（迂回の実在）", async () => {
    const { connectionString, realRole } = spoofedConnectionString();
    expect(new URL(connectionString).username).toBe(RUNTIME_DB_ROLE);
    expect(realRole).not.toBe(RUNTIME_DB_ROLE);

    const raw = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const rows = await raw<{ actual_role: string }[]>`SELECT session_user AS actual_role`;
      // ここが通ってしまうのが指摘の中身。だからこそ下の 2 段で止める。
      expect(rows[0]?.actual_role).toBe(realRole);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("resolveDbConnection は ?user= 付きの接続文字列を静的に拒否する", () => {
    const { connectionString } = spoofedConnectionString();
    expect(() => resolveDbConnection({ DATABASE_URL: connectionString })).toThrow(DbConfigError);
    expect(() => resolveDbConnection({ HYPERDRIVE: { connectionString } })).toThrow(DbConfigError);
  });

  it("createVerifiedDbClient は app_rw 接続で session_user が app_rw であることを確かめて通す", async () => {
    const handle = await createVerifiedDbClient({ DATABASE_URL: appRwConnectionString() });
    try {
      expect(handle.role).toBe(RUNTIME_DB_ROLE);
      expect(handle.route).toBe("direct");
      const rows = await handle.sql<{ actual_role: string }[]>`SELECT session_user AS actual_role`;
      expect(rows[0]?.actual_role).toBe(RUNTIME_DB_ROLE);
    } finally {
      await handle.close();
    }
  });

  it("assertSessionRole は実ロールの食い違いを検出する（静的検査を抜けられても止まる）", async () => {
    const appRw = postgres(appRwConnectionString(), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await expect(assertSessionRole(appRw, "postgres")).rejects.toBeInstanceOf(
        DbRoleMismatchError,
      );
      await expect(assertSessionRole(appRw, RUNTIME_DB_ROLE)).resolves.toBeUndefined();
    } finally {
      await appRw.end({ timeout: 5 });
    }
  });

  it("食い違いのメッセージにロール名だけを出し、接続文字列（パスワード）を出さない", async () => {
    const appRw = postgres(appRwConnectionString(), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await assertSessionRole(appRw, "postgres");
      throw new Error("expected assertSessionRole to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(RUNTIME_DB_ROLE);
      expect(message).not.toContain(appRwConnectionString());
      expect(message).not.toContain("@127.0.0.1");
    } finally {
      await appRw.end({ timeout: 5 });
    }
  });
});
