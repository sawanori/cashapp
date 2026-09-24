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

const { DbConfigError, RUNTIME_DB_ROLE, resolveDbConnection } = await import("@/lib/db/client");

const APP_RW_URL = "postgresql://app_rw:pw@db.example.internal:5432/postgres";
const HYPERDRIVE_URL = "postgresql://app_rw:hyperdrive-pw@127.0.0.1:41234/postgres";
const PRIVILEGED_URL = "postgresql://postgres:pw@127.0.0.1:54322/postgres";

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
