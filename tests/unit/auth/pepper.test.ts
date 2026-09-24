/**
 * `src/lib/auth/pepper.ts`（`line_user_ref` の算出と `app_user` の解決）のユニットテスト。
 *
 * ここでは **SQL の発行順序と分岐**だけを見る。実 Postgres に対する通しの確認
 * （移行で claim が維持される・旧参照値が残らない）は tests/integration/auth.test.ts。
 *
 * 敵対レビュー F-4（GPT-6 Astra, 2026-09-24）の再現と回帰:
 *   PEPPER の切替中、移行は旧参照値を**上書き**する。移行後に旧 PEPPER だけを持つ処理系で
 *   同じ人がログインすると、その処理系は既存行を見つけられず **別の app_user を作る**。
 *   以後 2 つのアカウントが残り、発行されるセッションの userId が設定によって変わる。
 */

import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "@/lib/errors";

vi.mock("server-only", () => ({}));

const { MIN_SECRET_BYTES, loadAppConfig } = await import("@/lib/config/env");
const { IDENTITY_SCOPE, computeLineUserRef, resolveAppUser, userRefFingerprint } = await import(
  "@/lib/auth/pepper"
);

const PEPPER_V1 = "p".repeat(MIN_SECRET_BYTES);
const PEPPER_V2 = "q".repeat(MIN_SECRET_BYTES);
const SUB = "Ufedcba98765432100123456789abcdef";

function configFor(pepper: string): ReturnType<typeof loadAppConfig> {
  return loadAppConfig({
    APP_ENV: "development",
    LINE_ENV_PROFILE: JSON.stringify({
      env: "development",
      liffId: "2000000000-abcd1234",
      loginChannelId: "2000000000",
    }),
    PEPPER: pepper,
    SESSION_KEYS: `k1:${"s".repeat(MIN_SECRET_BYTES)}`,
    CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
  });
}

const CONFIG_V1 = configFor(`1:${PEPPER_V1}`);
const CONFIG_V1_V2 = configFor(`1:${PEPPER_V1},2:${PEPPER_V2}`);

interface Query {
  readonly text: string;
  readonly params: readonly unknown[];
}

function appUserRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    session_epoch: 1,
    status: "active",
    pepper_version: 1,
    identity_scope: IDENTITY_SCOPE,
    line_env: "development",
    ...overrides,
  };
}

/**
 * postgres.js のタグ付きテンプレートを模した最小のスタブ。
 * `savepoint` を持たないので `runInTransaction` は `begin()` 経路を通る。
 */
function createFakeSql(respond: (query: Query) => unknown[]): {
  sql: postgres.Sql;
  queries: Query[];
} {
  const queries: Query[] = [];
  const tag = (strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]> => {
    const text = strings.join(" ? ").replace(/\s+/g, " ").trim();
    const query: Query = { text, params };
    queries.push(query);
    return Promise.resolve(respond(query));
  };
  (tag as unknown as { begin: unknown }).begin = async (
    fn: (tx: unknown) => Promise<unknown>,
  ): Promise<unknown> => fn(tag);
  return { sql: tag as unknown as postgres.Sql, queries };
}

function kindOf(query: Query): string {
  if (query.text.includes("pg_advisory_xact_lock")) return "advisory-lock";
  if (query.text.includes("INSERT INTO app_user")) return "insert";
  if (query.text.includes("UPDATE app_user")) return "migrate";
  if (query.text.includes("UPDATE participant_claim")) return "migrate-claim";
  if (query.text.includes("<> ALL")) return "unknown-version-probe";
  if (query.text.includes("FROM app_user")) return "lookup";
  return "other";
}

describe("resolveAppUser — 現行バージョンの行が見つかる場合", () => {
  it("そのまま返し、INSERT も移行もしない", async () => {
    const { sql, queries } = createFakeSql((query) =>
      kindOf(query) === "lookup" ? [appUserRow()] : [],
    );

    const result = await resolveAppUser(sql, CONFIG_V1, SUB);

    expect(result.created).toBe(false);
    expect(result.migratedFromPepperVersion).toBeNull();
    expect(queries.map(kindOf)).toEqual(["lookup"]);
  });
});

describe("resolveAppUser — 旧バージョンからの移行", () => {
  it("旧版の行を見つけたら claim と app_user の両方を新版へ書き換える", async () => {
    let currentLookups = 0;
    const { sql, queries } = createFakeSql((query) => {
      if (kindOf(query) === "lookup") {
        // params は [identity_scope, pepper_version, line_user_ref]。
        if (query.params[1] === 1) return [appUserRow({ pepper_version: 1 })];
        currentLookups += 1;
        return [];
      }
      if (kindOf(query) === "migrate") return [appUserRow({ pepper_version: 2 })];
      return [];
    });

    const result = await resolveAppUser(sql, CONFIG_V1_V2, SUB);

    expect(result.migratedFromPepperVersion).toBe(1);
    expect(result.user.pepperVersion).toBe(2);
    // 現行版の検索はロックの前後で 2 回（2 回目は待っているあいだの作成を拾うため）。
    expect(currentLookups).toBe(2);
    expect(queries.map(kindOf)).toEqual([
      "lookup",
      "advisory-lock",
      "lookup",
      "lookup",
      "migrate-claim",
      "migrate",
    ]);
  });
});

describe("F-4: 旧 PEPPER だけを持つ処理系がアカウントを分裂させない", () => {
  it("DB に自分の設定に無い pepper_version の行があれば、新規作成せず CONFIG_INVALID で止まる", async () => {
    // 旧 PEPPER（v1）だけを持つ処理系。DB には移行済み（v2）の行がある状態。
    const { sql, queries } = createFakeSql((query) => {
      switch (kindOf(query)) {
        case "lookup":
          return []; // v1 の参照値では見つからない（移行で上書きされているため）。
        case "unknown-version-probe":
          return [{ pepper_version: 2 }];
        default:
          return [appUserRow({ id: "22222222-2222-4222-8222-222222222222" })];
      }
    });

    let thrown: unknown;
    try {
      await resolveAppUser(sql, CONFIG_V1, SUB);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe(ERROR_CODES.CONFIG_INVALID);
    expect((thrown as AppError).status).toBe(503);
    // 別の app_user を作っていないこと（= アカウントが割れていないこと）。
    expect(queries.map(kindOf)).not.toContain("insert");
  });

  it("未知バージョンの検査は設定にある版の一覧を渡す（旧版を捨てた処理系も止まる）", async () => {
    const probes: Query[] = [];
    const { sql } = createFakeSql((query) => {
      if (kindOf(query) === "unknown-version-probe") {
        probes.push(query);
        return [];
      }
      if (kindOf(query) === "insert") return [{ ...appUserRow(), inserted: true }];
      return [];
    });

    await resolveAppUser(sql, CONFIG_V1_V2, SUB);

    expect(probes).toHaveLength(1);
    expect(probes[0]?.params).toContainEqual([2, 1]);
  });

  it("自分の設定に無い版が無ければ、これまでどおり新規作成する", async () => {
    const { sql, queries } = createFakeSql((query) => {
      switch (kindOf(query)) {
        case "lookup":
          return [];
        case "unknown-version-probe":
          return [];
        case "insert":
          return [{ ...appUserRow(), inserted: true }];
        default:
          return [];
      }
    });

    const result = await resolveAppUser(sql, CONFIG_V1, SUB);

    expect(result.created).toBe(true);
    expect(result.migratedFromPepperVersion).toBeNull();
    expect(queries.map(kindOf)).toEqual([
      "lookup",
      "advisory-lock",
      "lookup",
      "unknown-version-probe",
      "insert",
    ]);
  });

  it("新版（v2）を持つ処理系は、v2 の行があっても新規作成できる", async () => {
    const { sql, queries } = createFakeSql((query) => {
      switch (kindOf(query)) {
        case "lookup":
          return [];
        case "unknown-version-probe":
          return []; // 設定は [2,1] なので、この 2 つ以外の版は無い。
        case "insert":
          return [{ ...appUserRow({ pepper_version: 2 }), inserted: true }];
        default:
          return [];
      }
    });

    const result = await resolveAppUser(sql, CONFIG_V1_V2, SUB);

    expect(result.created).toBe(true);
    expect(queries.map(kindOf)).toEqual([
      "lookup",
      "advisory-lock",
      "lookup",
      "lookup",
      "unknown-version-probe",
      "insert",
    ]);
  });
});

/**
 * 2 周目の敵対レビュー（GPT-6 Astra）F-1（high）の回帰。
 *
 * 「新版の存在確認と INSERT は直列化されていない。既存行が無い場合 FOR UPDATE は競合を防がず、
 *   ON CONFLICT の対象にも pepper_version が含まれるため、同じ sub に対する v1・v2 の行を
 *   両方作れる」——つまり *逐次* の分裂（F-4）を塞いでも、*同時* の分裂が残っていた。
 */
describe("F-1(2周目): 同時初回ログインでもアカウントが分裂しない", () => {
  it("新規作成の経路は助言ロックを取り、ロックの前には INSERT も検査もしない", async () => {
    const { sql, queries } = createFakeSql((query) => {
      if (kindOf(query) === "insert") return [{ ...appUserRow(), inserted: true }];
      return [];
    });

    await resolveAppUser(sql, CONFIG_V1, SUB);

    const kinds = queries.map(kindOf);
    const lockAt = kinds.indexOf("advisory-lock");
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("unknown-version-probe")).toBeGreaterThan(lockAt);
    expect(kinds.indexOf("insert")).toBeGreaterThan(lockAt);
  });

  it("ロック待ちのあいだに別トランザクションが作った行を拾い、2 つ目を作らない", async () => {
    let currentLookups = 0;
    const { sql, queries } = createFakeSql((query) => {
      switch (kindOf(query)) {
        case "lookup":
          currentLookups += 1;
          // 1 回目（ロック取得前）は空。ロックを待っているあいだに別トランザクションが
          // 作って commit したので、2 回目（ロック取得後）は見える。
          return currentLookups >= 2 ? [appUserRow()] : [];
        case "insert":
          return [{ ...appUserRow(), inserted: true }];
        default:
          return [];
      }
    });

    const result = await resolveAppUser(sql, CONFIG_V1, SUB);

    expect(result.created).toBe(false);
    expect(result.migratedFromPepperVersion).toBeNull();
    expect(queries.map(kindOf)).toEqual(["lookup", "advisory-lock", "lookup"]);
  });

  it("現行版の行が最初から見つかる経路では助言ロックを取らない（通常ログインを直列化しない）", async () => {
    const { sql, queries } = createFakeSql((query) =>
      kindOf(query) === "lookup" ? [appUserRow()] : [],
    );

    await resolveAppUser(sql, CONFIG_V1, SUB);

    expect(queries.map(kindOf)).not.toContain("advisory-lock");
  });
});

describe("computeLineUserRef / userRefFingerprint", () => {
  it("PEPPER が違えば参照値も違う（同じ sub でも）", async () => {
    const v1 = await computeLineUserRef(SUB, { version: 1, value: PEPPER_V1 });
    const v2 = await computeLineUserRef(SUB, { version: 2, value: PEPPER_V2 });
    expect(v1.byteLength).toBe(32);
    expect(Buffer.from(v1).equals(Buffer.from(v2))).toBe(false);
  });

  it("fingerprint は参照値の先頭 8 バイトの hex で、生の sub を含まない", async () => {
    const ref = await computeLineUserRef(SUB, { version: 1, value: PEPPER_V1 });
    const fp = userRefFingerprint(ref);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain(SUB);
  });
});
