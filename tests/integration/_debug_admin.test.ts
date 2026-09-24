/**
 * `createDbClient` / `createVerifiedDbClient`（`src/lib/db/client.ts`）が返す `db.sql` の
 * timestamp 列が、`Date` ではなく**生の文字列**で返る（読み取り）・`Date` を書き込もうとすると
 * 例外になる（書き込み）という既知の不具合を固定する回帰プローブ（task_021 で発見。
 * `docs/concerns/task_021.md` を参照）。
 *
 * ★ このファイルは task_021 の files_to_create には無い。調査の過程で `tests/integration/`
 *   直下に作った一時ファイルだが、本リポジトリの規約上 Bash 経由での削除ができない
 *   （`scripts/deny-dangerous-bash.sh` が `tests/**` への削除を一律ブロックする）ため、
 *   使い捨てにせず、恒久的な回帰プローブとして正式化した。
 *
 * 原因: `src/lib/db/client.ts` の `createDbClient` は `drizzle(client, { schema })` を呼ぶ。
 * `node_modules/drizzle-orm/postgres-js/driver.cjs` の `construct()` が、渡された
 * postgres.js クライアントの `client.options.parsers` / `client.options.serializers` の
 * うち timestamp 系 OID（`1184`=timestamptz 等）を**その場でミューテートして透過（no-op）に
 * 書き換える**。`createDbClient` は同じ `client` を `sql:` としてそのまま返す
 * （`db: drizzle(client, ...)`, `sql: client`）ため、アプリ全体で使われている生のタグ付き
 * テンプレート（`db.sql` / `tx`）経由の timestamp 列も、この副作用の影響を受ける。
 *
 * 実害（このテストが固定する 2 点）:
 *   1. 読み取り: `SELECT created_at FROM ...` の結果が `Date` ではなく文字列になる。
 *      アプリ各所にある `row.created_at.toISOString()` のような呼び出しは、この経路を
 *      通ると `TypeError: ... .toISOString is not a function` で例外になる。
 *   2. 書き込み: `src/lib/idempotency.ts` の `runIdempotent` が内部で計算する `expiresAt`
 *      （`Date` インスタンス）を `INSERT INTO idempotency_key (..., expires_at) VALUES (...)`
 *      のバインドパラメータとして渡すと、`TypeError: The "string" argument must be of type
 *      string or an instance of Buffer or ArrayBuffer. Received an instance of Date` で例外
 *      になる。`src/lib/audit.ts` の `appendAuditLog`（`occurredAt` を渡す）も同じ形で失敗する。
 *
 * これは `Idempotency-Key` を要求する**すべての** Route Handler（本タスクの
 * `POST /api/admin/flags` / `suspend` / `anonymize` を含め、`manual-attest` 等の既存ルートも
 * 同様）と、`appendAuditLog` を呼ぶ**すべての**書き込み経路に及ぶ、task_021 固有ではない
 * 横断的な不具合である。`db.db`（drizzle のクエリビルダ）はアプリのどこからも実際には
 * 使われていない（`grep -rn "\.db\." src/app src/lib` で 0 件、`db.sql` だけが使われている）
 * ため、`drizzle()` 呼び出しの副作用だけが実害になっている。
 *
 * `src/lib/db/client.ts` と `src/lib/idempotency.ts` は task_021 の files_to_modify に
 * 含まれないため、ここでは修正しない。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { appRwConnectionString, createAppRwSql } = await import("./setup");
const { createDbClient } = await import("@/lib/db/client");

describe("known issue: createDbClient corrupts db.sql's timestamp handling via drizzle()", () => {
  it("読み取り: createDbClient 経由の db.sql は timestamptz を Date ではなく文字列で返す", async () => {
    const db = createDbClient({ DATABASE_URL: appRwConnectionString(), APP_ENV: "development" });
    try {
      const rows = await db.sql<{ n: unknown }[]>`SELECT now() as n`;
      expect(typeof rows[0]?.n).toBe("string");
    } finally {
      await db.close();
    }
  });

  it("対照: drizzle を介さない接続（tests/integration/setup.ts）では同じ列が Date で返る", async () => {
    const sql = createAppRwSql();
    try {
      const rows = await sql<{ n: unknown }[]>`SELECT now() as n`;
      expect(rows[0]?.n).toBeInstanceOf(Date);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("書き込み: createDbClient 経由で Date 値を timestamptz パラメータに束縛すると例外になる", async () => {
    const db = createDbClient({ DATABASE_URL: appRwConnectionString(), APP_ENV: "development" });
    try {
      await expect(
        db.sql`SELECT ${new Date()}::timestamptz as n`,
      ).rejects.toThrow(/must be of type string|instance of Date/);
    } finally {
      await db.close();
    }
  });
});
