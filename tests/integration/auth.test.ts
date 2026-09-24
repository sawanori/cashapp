/**
 * 認証まわりの統合テスト（実 Postgres。`supabase start` 済みのローカル / CI）。
 *
 * acceptance-checks:
 *   - check_007: LINE の生 sub（`U` + 32 hex）がどの行にも保存されていない。
 *   - check_072: 同一 ID トークンの 2 回目の提示が 401。
 *   - check_073: `session_epoch` を進めると当該ユーザーの全セッションが即 401。
 *   - check_074: `pepper_version` が違う 2 つの PEPPER で、旧版のユーザーが新版へ移行され claim が維持される。
 *
 * 隔離: すべて `withRollback` のトランザクション内で行い、並列に走る他タスクのデータを汚さない。
 * 接続は本番と同じ最小権限ロール `app_rw`。
 */

import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "@/lib/errors";

import {
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  withRollback,
} from "./setup";

vi.mock("server-only", () => ({}));

const { MIN_SECRET_BYTES, loadAppConfig } = await import("@/lib/config/env");
const { authenticateWithLineIdToken, LINE_ID_TOKEN_ISSUER } = await import("@/lib/auth/line-verify");
const { createDbUsedIdTokenStore } = await import("@/lib/auth/used-token");
const { IDENTITY_SCOPE, computeLineUserRef } = await import("@/lib/auth/pepper");
const { buildSessionCookie, requireSession, SESSION_COOKIE_NAME } = await import(
  "@/lib/auth/session"
);
const { CONSENT_KINDS, parseConsentBody } = await import("@/app/api/consent/route");

const LOGIN_CHANNEL_ID = "2000000000";
const PEPPER_V1 = "p".repeat(MIN_SECRET_BYTES);
const PEPPER_V2 = "q".repeat(MIN_SECRET_BYTES);
const SESSION_KEY = "s".repeat(MIN_SECRET_BYTES);

function configFor(pepper: string) {
  return loadAppConfig({
    APP_ENV: "development",
    LINE_ENV_PROFILE: JSON.stringify({
      env: "development",
      liffId: `${LOGIN_CHANNEL_ID}-abcd1234`,
      loginChannelId: LOGIN_CHANNEL_ID,
    }),
    PEPPER: pepper,
    SESSION_KEYS: `cur:${SESSION_KEY}`,
    CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
  });
}

const CONFIG_V1 = configFor(`1:${PEPPER_V1}`);
const CONFIG_V1_V2 = configFor(`1:${PEPPER_V1},2:${PEPPER_V2}`);

const ALLOW_ALL_LIMITER = {
  check: async (): Promise<{ allowed: boolean; backend: "workers-rate-limit-binding" }> => ({
    allowed: true,
    backend: "workers-rate-limit-binding",
  }),
};

function lineSub(suffix: string): string {
  // `U` + 32 hex。suffix で一意にする。
  const hex = suffix.padStart(32, "0").slice(-32).replace(/[^0-9a-f]/g, "0");
  return `U${hex}`;
}

function verifyFetchFor(sub: string, nowSeconds: number): typeof fetch {
  return (async (): Promise<Response> =>
    Response.json({
      iss: LINE_ID_TOKEN_ISSUER,
      sub,
      aud: LOGIN_CHANNEL_ID,
      exp: nowSeconds + 3600,
      iat: nowSeconds - 5,
    })) as unknown as typeof fetch;
}

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

describe("POST /api/auth/line の本体（authenticateWithLineIdToken）", () => {
  it("初回のログインで app_user が作られ、セッションと CSRF トークンが返る", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("a1");
      const now = new Date();
      const result = await authenticateWithLineIdToken(
        {
          config: CONFIG_V1,
          sql: tx as unknown as postgres.Sql,
          usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
          rateLimiter: ALLOW_ALL_LIMITER,
          clientIp: "203.0.113.10",
          now,
          fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
        },
        "id-token-a1",
      );

      expect(result.created).toBe(true);
      expect(result.migratedFromPepperVersion).toBeNull();
      expect(result.user.pepperVersion).toBe(1);
      expect(result.user.sessionEpoch).toBe(1);
      expect(result.session.token.split(".")).toHaveLength(3);
      expect(result.csrfToken.length).toBeGreaterThan(20);

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM app_user WHERE id = ${result.user.id}
      `;
      expect(rows[0]?.n).toBe("1");
    });
  });

  it("2 回目のログイン（別トークン）では同じ app_user が使われる", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("a2");
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const deps = {
        config: CONFIG_V1,
        sql: tx as unknown as postgres.Sql,
        usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
        rateLimiter: ALLOW_ALL_LIMITER,
        clientIp: "203.0.113.10",
        now,
        fetchImpl: verifyFetchFor(sub, nowSeconds),
      };

      const first = await authenticateWithLineIdToken(deps, "id-token-a2-first");
      const second = await authenticateWithLineIdToken(deps, "id-token-a2-second");

      expect(second.user.id).toBe(first.user.id);
      expect(second.created).toBe(false);
      expect(second.session.jti).not.toBe(first.session.jti);
    });
  });

  it("同一 ID トークンの 2 回目の提示は 401 になる（check_072 / ADR-009）", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("a3");
      const now = new Date();
      const deps = {
        config: CONFIG_V1,
        sql: tx as unknown as postgres.Sql,
        usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
        rateLimiter: ALLOW_ALL_LIMITER,
        clientIp: "203.0.113.10",
        now,
        fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
      };

      const first = await authenticateWithLineIdToken(deps, "replayed-id-token");
      expect(first.session.token.length).toBeGreaterThan(0);

      let thrown: unknown;
      try {
        await authenticateWithLineIdToken(deps, "replayed-id-token");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe(ERROR_CODES.ID_TOKEN_INVALID);
      expect((thrown as AppError).status).toBe(401);
    });
  });

  it("used_id_token には ID トークン本体ではなくハッシュが入り、TTL は exp", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("a4");
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      await authenticateWithLineIdToken(
        {
          config: CONFIG_V1,
          sql: tx as unknown as postgres.Sql,
          usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
          rateLimiter: ALLOW_ALL_LIMITER,
          clientIp: null,
          now,
          fetchImpl: verifyFetchFor(sub, nowSeconds),
        },
        "secret-id-token-a4",
      );

      const rows = await tx<{ jti_or_hash: string; expires_at: Date }[]>`
        SELECT jti_or_hash, expires_at FROM used_id_token
        WHERE jti_or_hash LIKE 'sha256:%'
        ORDER BY used_at DESC LIMIT 1
      `;
      expect(rows[0]?.jti_or_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(rows[0]?.jti_or_hash).not.toContain("secret-id-token-a4");
      const ttlSeconds = Math.round(((rows[0]?.expires_at.getTime() ?? 0) - now.getTime()) / 1000);
      expect(ttlSeconds).toBeGreaterThan(3500);
      expect(ttlSeconds).toBeLessThanOrEqual(3600);
    });
  });

  it("停止されたユーザーは 403 USER_SUSPENDED", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("a5");
      const now = new Date();
      const deps = {
        config: CONFIG_V1,
        sql: tx as unknown as postgres.Sql,
        usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
        rateLimiter: ALLOW_ALL_LIMITER,
        clientIp: null,
        now,
        fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
      };

      const first = await authenticateWithLineIdToken(deps, "token-a5-1");
      await tx`
        UPDATE app_user SET status = 'suspended', suspended_at = now() WHERE id = ${first.user.id}
      `;

      let thrown: unknown;
      try {
        await authenticateWithLineIdToken(deps, "token-a5-2");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe(ERROR_CODES.USER_SUSPENDED);
      expect((thrown as AppError).status).toBe(403);
    });
  });
});

describe("pepper_version の移行（check_074 / R-SEC-09）", () => {
  it("旧 pepper_version のユーザーがログイン時に新版へ移行され、claim が維持される", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("b1");
      const now = new Date();

      // ① PEPPER v1 だけの世界でログインし、claim を作る。
      const before = await authenticateWithLineIdToken(
        {
          config: CONFIG_V1,
          sql: tx as unknown as postgres.Sql,
          usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
          rateLimiter: ALLOW_ALL_LIMITER,
          clientIp: null,
          now,
          fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
        },
        "token-b1-v1",
      );
      expect(before.user.pepperVersion).toBe(1);

      const refV1 = await computeLineUserRef(sub, { version: 1, value: PEPPER_V1 });
      const [event] = await tx<{ id: string }[]>`
        INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash, minors_included)
        VALUES (${before.user.id}, 'pepper migration', 'organizer',
                ${Buffer.from("join-b1")}, false)
        RETURNING id
      `;
      const [participant] = await tx<{ id: string }[]>`
        INSERT INTO participant (event_id, display_label) VALUES (${event!.id}, 'p-b1') RETURNING id
      `;
      const [claim] = await tx<{ id: string }[]>`
        INSERT INTO participant_claim (event_id, participant_id, line_user_ref, pepper_version)
        VALUES (${event!.id}, ${participant!.id}, ${refV1}, 1)
        RETURNING id
      `;

      // ② PEPPER v2 を足した世界で同じ人がログインする。
      const after = await authenticateWithLineIdToken(
        {
          config: CONFIG_V1_V2,
          sql: tx as unknown as postgres.Sql,
          usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
          rateLimiter: ALLOW_ALL_LIMITER,
          clientIp: null,
          now,
          fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
        },
        "token-b1-v2",
      );

      expect(after.user.id).toBe(before.user.id);
      expect(after.migratedFromPepperVersion).toBe(1);
      expect(after.user.pepperVersion).toBe(2);

      // ③ app_user の参照値が v2 のものに書き換わっている。
      const refV2 = await computeLineUserRef(sub, { version: 2, value: PEPPER_V2 });
      const users = await tx<{ line_user_ref: Buffer; pepper_version: number }[]>`
        SELECT line_user_ref, pepper_version FROM app_user WHERE id = ${after.user.id}
      `;
      expect(users[0]?.pepper_version).toBe(2);
      expect(Buffer.from(users[0]?.line_user_ref ?? Buffer.alloc(0)).equals(Buffer.from(refV2))).toBe(
        true,
      );

      // ④ claim も一緒に移り、同じ行が生きている（claim が切れていない）。
      const claims = await tx<{ id: string; pepper_version: number; line_user_ref: Buffer }[]>`
        SELECT id, pepper_version, line_user_ref FROM participant_claim
        WHERE event_id = ${event!.id} AND released_at IS NULL
      `;
      expect(claims).toHaveLength(1);
      expect(claims[0]?.id).toBe(claim!.id);
      expect(claims[0]?.pepper_version).toBe(2);
      expect(
        Buffer.from(claims[0]?.line_user_ref ?? Buffer.alloc(0)).equals(Buffer.from(refV2)),
      ).toBe(true);
    });
  });

  it("移行後に旧版の参照値は残らない（同じ人の行が 2 つに割れない）", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("b2");
      const now = new Date();
      const deps = (config: ReturnType<typeof configFor>) => ({
        config,
        sql: tx as unknown as postgres.Sql,
        usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
        rateLimiter: ALLOW_ALL_LIMITER,
        clientIp: null,
        now,
        fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
      });

      await authenticateWithLineIdToken(deps(CONFIG_V1), "token-b2-v1");
      await authenticateWithLineIdToken(deps(CONFIG_V1_V2), "token-b2-v2");

      const refV1 = await computeLineUserRef(sub, { version: 1, value: PEPPER_V1 });
      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM app_user
        WHERE identity_scope = ${IDENTITY_SCOPE} AND line_user_ref = ${refV1}
      `;
      expect(rows[0]?.n).toBe("0");
    });
  });
});

describe("生の LINE userId がどこにも保存されない（check_007 / L7）", () => {
  it("ログイン後、public スキーマのどの列にも U + 32 hex が現れない", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("c1");
      const now = new Date();
      await authenticateWithLineIdToken(
        {
          config: CONFIG_V1,
          sql: tx as unknown as postgres.Sql,
          usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
          rateLimiter: ALLOW_ALL_LIMITER,
          clientIp: "203.0.113.10",
          now,
          fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
        },
        "token-c1",
      );

      const columns = await tx<{ table_name: string; column_name: string; data_type: string }[]>`
        SELECT c.table_name, c.column_name, c.data_type
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'character varying', 'character', 'bytea')
        ORDER BY c.table_name, c.column_name
      `;
      expect(columns.length).toBeGreaterThan(20);

      const selects = columns.map((column) => {
        const expression =
          column.data_type === "bytea"
            ? `encode("${column.column_name}", 'escape')`
            : `"${column.column_name}"::text`;
        return (
          `SELECT '${column.table_name}.${column.column_name}' AS location ` +
          `FROM "${column.table_name}" WHERE ${expression} ~ 'U[0-9a-f]{32}'`
        );
      });

      const hits = await tx.unsafe<{ location: string }[]>(selects.join(" UNION ALL "));
      expect(hits.map((row) => row.location)).toEqual([]);

      // 参照値は 32 バイトの bytea（HMAC の出力長）であって、生の sub（33 文字）ではない。
      const refs = await tx<{ len: number }[]>`
        SELECT octet_length(line_user_ref) AS len FROM app_user ORDER BY created_at DESC LIMIT 1
      `;
      expect(refs[0]?.len).toBe(32);
    });
  });
});

describe("requireSession — session_epoch による即時失効（check_073）", () => {
  async function loginInTx(
    tx: postgres.TransactionSql,
    suffix: string,
  ): Promise<{ userId: string; cookieHeader: string }> {
    const sub = lineSub(suffix);
    const now = new Date();
    const result = await authenticateWithLineIdToken(
      {
        config: CONFIG_V1,
        sql: tx as unknown as postgres.Sql,
        usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
        rateLimiter: ALLOW_ALL_LIMITER,
        clientIp: null,
        now,
        fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
      },
      `token-${suffix}`,
    );
    return { userId: result.user.id, cookieHeader: buildSessionCookie(result.session.token) };
  }

  function requestWithCookie(cookieHeader: string): Request {
    // `Set-Cookie` の値から名前=値だけを取り出して `Cookie` ヘッダに詰め直す。
    const pair = cookieHeader.split(";")[0] ?? "";
    return new Request("https://example.test/api/me", { headers: { cookie: pair } });
  }

  it("有効なセッションは通る", async () => {
    await withRollback(appRw, async (tx) => {
      const { userId, cookieHeader } = await loginInTx(tx, "d1");
      const session = await requireSession(
        CONFIG_V1,
        tx as unknown as postgres.Sql,
        requestWithCookie(cookieHeader),
      );
      expect(session.userId).toBe(userId);
      expect(session.sessionEpoch).toBe(1);
      expect(cookieHeader).toContain(SESSION_COOKIE_NAME);
    });
  });

  it("session_epoch を 1 進めると、期限内でも 401 になる", async () => {
    await withRollback(appRw, async (tx) => {
      const { userId, cookieHeader } = await loginInTx(tx, "d2");
      await tx`UPDATE app_user SET session_epoch = session_epoch + 1 WHERE id = ${userId}`;

      let thrown: unknown;
      try {
        await requireSession(
          CONFIG_V1,
          tx as unknown as postgres.Sql,
          requestWithCookie(cookieHeader),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe(ERROR_CODES.UNAUTHORIZED);
      expect((thrown as AppError).status).toBe(401);
    });
  });

  it("Cookie が無ければ 401", async () => {
    await withRollback(appRw, async (tx) => {
      let thrown: unknown;
      try {
        await requireSession(
          CONFIG_V1,
          tx as unknown as postgres.Sql,
          new Request("https://example.test/api/me"),
        );
      } catch (error) {
        thrown = error;
      }
      expect((thrown as AppError).code).toBe(ERROR_CODES.UNAUTHORIZED);
    });
  });

  it("停止されたユーザーのセッションは 403", async () => {
    await withRollback(appRw, async (tx) => {
      const { userId, cookieHeader } = await loginInTx(tx, "d3");
      await tx`UPDATE app_user SET status='suspended', suspended_at=now() WHERE id = ${userId}`;

      let thrown: unknown;
      try {
        await requireSession(
          CONFIG_V1,
          tx as unknown as postgres.Sql,
          requestWithCookie(cookieHeader),
        );
      } catch (error) {
        thrown = error;
      }
      expect((thrown as AppError).code).toBe(ERROR_CODES.USER_SUSPENDED);
    });
  });
});

describe("POST /api/consent（consent_log / L6 / R-LAW-06）", () => {
  it("ボディの検査は 4 種類の同意種別だけを通す", () => {
    for (const kind of CONSENT_KINDS) {
      expect(parseConsentBody({ consentKind: kind, textVersion: "v1" })).toEqual({
        consentKind: kind,
        textVersion: "v1",
      });
    }
    for (const bad of [
      null,
      "string",
      {},
      { consentKind: "marketing", textVersion: "v1" },
      { consentKind: "tos" },
      { consentKind: "tos", textVersion: "" },
      { consentKind: "tos", textVersion: "x".repeat(65) },
    ]) {
      expect(() => parseConsentBody(bad)).toThrow(AppError);
    }
  });

  it("consent_log に文言バージョンと時刻が追記され、app_user の受領時刻が更新される", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub("e1");
      const now = new Date();
      const login = await authenticateWithLineIdToken(
        {
          config: CONFIG_V1,
          sql: tx as unknown as postgres.Sql,
          usedTokenStore: createDbUsedIdTokenStore(tx as unknown as postgres.Sql),
          rateLimiter: ALLOW_ALL_LIMITER,
          clientIp: null,
          now,
          fetchImpl: verifyFetchFor(sub, Math.floor(now.getTime() / 1000)),
        },
        "token-e1",
      );

      // ルートハンドラと同じ 2 文（`src/app/api/consent/route.ts`）。
      await tx`
        INSERT INTO consent_log (user_id, consent_kind, text_version)
        VALUES (${login.user.id}, 'tos', '2026-09-24')
      `;
      await tx`UPDATE app_user SET tos_accepted_at = now() WHERE id = ${login.user.id}`;

      const logs = await tx<{ consent_kind: string; text_version: string }[]>`
        SELECT consent_kind, text_version FROM consent_log WHERE user_id = ${login.user.id}
      `;
      expect(logs).toEqual([{ consent_kind: "tos", text_version: "2026-09-24" }]);

      const users = await tx<{ tos_accepted_at: Date | null }[]>`
        SELECT tos_accepted_at FROM app_user WHERE id = ${login.user.id}
      `;
      expect(users[0]?.tos_accepted_at).not.toBeNull();
    });
  });
});
