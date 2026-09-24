/**
 * 冪等キーの越境（check_110: 「別ユーザーが同一キーで 409、他人の応答が返らない」／R-PAY-02）。
 *
 * `src/lib/idempotency.ts` の主キーは `(user_ref, endpoint, key)` である（R-PAY-02 是正。
 * モジュール docstring）。したがって「同じキー文字列」を 2 人の別ユーザーが送っても、
 * DB 上は別々の行になり、原理的に他人の応答が漏れることはない — が、それを**実際に**
 * 確かめる。加えて「同じユーザーが同じキーで内容の異なるリクエストを送る」古典的な
 * 冪等キー衝突（同一ユーザー内の越境）も確かめる。
 *
 * `runIdempotent` は呼び出し側が開いたトランザクション（`tx`）を要求するため、
 * `withRollback` の中で直接呼ぶ（実ルート経由は避ける。理由は他の tests/security/*.test.ts
 * と同じ — `docs/concerns/task_022.md`）。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "../integration/setup";

vi.mock("server-only", () => ({}));

const { computeRequestHash, idempotencyUserRef, runIdempotent } = await import("@/lib/idempotency");
const { AppError } = await import("@/lib/errors");

let migrator: postgres.Sql;
let appRw: postgres.Sql;

beforeAll(async () => {
  migrator = createMigratorSql();
  await ensureAppRwLoginPassword(migrator);
  appRw = createAppRwSql();
});

afterAll(async () => {
  await appRw?.end();
  await migrator?.end();
});

function uniq(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function insertUser(tx: postgres.TransactionSql, suffix: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`u-${suffix}`)}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  return rows[0]!.id;
}

const ENDPOINT = "POST /api/events";

describe("別ユーザーが同一キー文字列を使っても、互いの応答は漏れない", () => {
  it("同じ Idempotency-Key・同じ endpoint でも user_ref が違えば別々に処理され、それぞれ自分の結果だけを受け取る", async () => {
    await withRollback(appRw, async (tx) => {
      const userA = idempotencyUserRef(await insertUser(tx, uniq()));
      const userB = idempotencyUserRef(await insertUser(tx, uniq()));
      const SHARED_KEY = "shared-key-guessed-by-attacker";
      const bodyA = { title: "A の秘密イベント" };
      const bodyB = { title: "B の秘密イベント" };
      const hashA = await computeRequestHash(bodyA);
      const hashB = await computeRequestHash(bodyB);

      const resultA = await runIdempotent(
        { sql: tx, userRef: userA, endpoint: ENDPOINT, key: SHARED_KEY, requestHash: hashA },
        async () => ({ statusCode: 201, cacheableBody: { title: bodyA.title, owner: "A" } }),
      );
      const resultB = await runIdempotent(
        { sql: tx, userRef: userB, endpoint: ENDPOINT, key: SHARED_KEY, requestHash: hashB },
        async () => ({ statusCode: 201, cacheableBody: { title: bodyB.title, owner: "B" } }),
      );

      expect(resultA.replayed).toBe(false);
      expect(resultB.replayed).toBe(false);
      expect(resultA.body["owner"]).toBe("A");
      expect(resultB.body["owner"]).toBe("B");
      expect(resultA.body["title"]).not.toBe(resultB.body["title"]);

      // DB 上も別行（同じ key 文字列で 2 行）。
      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM idempotency_key WHERE key = ${SHARED_KEY} AND endpoint = ${ENDPOINT}
      `;
      expect(rows[0]?.n).toBe("2");
    });
  });

  it("同一ユーザーが同じキーで別内容のリクエストを送ると 409（越境ではなく本人内の衝突）", async () => {
    await withRollback(appRw, async (tx) => {
      const userRef = idempotencyUserRef(await insertUser(tx, uniq()));
      const key = `same-user-key-${uniq()}`;
      const hash1 = await computeRequestHash({ a: 1 });
      const hash2 = await computeRequestHash({ a: 2 });

      await runIdempotent(
        { sql: tx, userRef, endpoint: ENDPOINT, key, requestHash: hash1 },
        async () => ({ statusCode: 201, cacheableBody: { first: true } }),
      );

      let thrown: unknown;
      try {
        await tx.savepoint((sp) =>
          runIdempotent(
            { sql: sp, userRef, endpoint: ENDPOINT, key, requestHash: hash2 },
            async () => ({ statusCode: 201, cacheableBody: { first: false } }),
          ),
        );
        expect.unreachable("expected IDEMPOTENCY_CONFLICT");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as InstanceType<typeof AppError>).status).toBe(409);
      expect((thrown as InstanceType<typeof AppError>).code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });

  it("同一ユーザーが同じキー・同じ内容で再送すると、保存済みの応答をそのまま返す（extra は再送に含めない）", async () => {
    await withRollback(appRw, async (tx) => {
      const userRef = idempotencyUserRef(await insertUser(tx, uniq()));
      const key = `replay-key-${uniq()}`;
      const hash = await computeRequestHash({ a: 1 });

      const first = await runIdempotent(
        { sql: tx, userRef, endpoint: ENDPOINT, key, requestHash: hash },
        async () => ({
          statusCode: 201,
          cacheableBody: { id: "created-once" },
          extra: { joinToken: "must-not-be-replayed" },
        }),
      );
      const second = await runIdempotent(
        { sql: tx, userRef, endpoint: ENDPOINT, key, requestHash: hash },
        async () => ({ statusCode: 201, cacheableBody: { id: "should-not-run-again" } }),
      );

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.body["id"]).toBe("created-once");
      expect(second.body["joinToken"]).toBeUndefined();
    });
  });
});
