/**
 * `/api/cron/*` の認可（check_104）と、cron の三者一致（task_020 done_definition）。
 *
 * 三者とは:
 *   1. `workers/cron/index.ts` の `CRON_ROUTES`（cron Worker が実際に叩くパス）
 *   2. `src/app/api/cron/<name>/route.ts`（本体に実在する Route Handler）
 *   3. `workers/cron/wrangler.toml` の `[triggers] crons`（Cloudflare に登録される発火設定）
 *
 * どれか 1 つがずれると「cron は鳴っているのに誰も処理していない」「ルートはあるが発火しない」に
 * なる。ずれた瞬間にこのテストが落ちる。
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CRON_PATHS, CRON_SECRET_HEADER, checkCronAuth, parseCronSecrets } from "@/lib/cron-auth";

import { CRON_ROUTES } from "../../workers/cron/index";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SECRET_A = "cron-secret-current-0123456789abcdef";
const SECRET_B = "cron-secret-previous-0123456789abcd";

function request(secret: string | null): Request {
  const headers = new Headers();
  if (secret !== null) headers.set(CRON_SECRET_HEADER, secret);
  return new Request("https://example.test/api/cron/reconcile", { method: "POST", headers });
}

describe("cron の認可（check_104）", () => {
  it("非 production は正しいシークレットでも 404", () => {
    for (const appEnv of ["development", "staging", undefined]) {
      const denied = checkCronAuth({
        appEnv,
        secrets: [SECRET_A],
        presented: SECRET_A,
      });
      expect(denied?.status).toBe(404);
    }
  });

  it("production でシークレットが無ければ 401", () => {
    const denied = checkCronAuth({
      appEnv: "production",
      secrets: [SECRET_A],
      presented: request(null).headers.get(CRON_SECRET_HEADER),
    });
    expect(denied?.status).toBe(401);
  });

  it("production で許容リストに無い値は 401", () => {
    const denied = checkCronAuth({
      appEnv: "production",
      secrets: [SECRET_A],
      presented: "not-the-secret-0123456789abcdefgh",
    });
    expect(denied?.status).toBe(401);
  });

  it("許容リストのどれか（ローテーション中の旧値を含む）に一致すれば通す", () => {
    for (const secret of [SECRET_A, SECRET_B]) {
      expect(
        checkCronAuth({ appEnv: "production", secrets: [SECRET_A, SECRET_B], presented: secret }),
      ).toBeNull();
    }
  });

  it("CRON_SECRETS はカンマ区切りで、空白と空要素を落とす", () => {
    expect(parseCronSecrets(` ${SECRET_A} , ${SECRET_B} ,, `)).toEqual([SECRET_A, SECRET_B]);
    expect(parseCronSecrets(undefined)).toEqual([]);
    expect(parseCronSecrets("")).toEqual([]);
  });

  it("シークレット未設定（許容リストが空）なら常に 401", () => {
    expect(
      checkCronAuth({ appEnv: "production", secrets: [], presented: SECRET_A })?.status,
    ).toBe(401);
  });
});

/** `workers/cron/wrangler.toml` の `[triggers] crons` を読む。 */
function wranglerCrons(): string[] {
  const toml = readFileSync(path.join(REPO_ROOT, "workers", "cron", "wrangler.toml"), "utf8");
  const block = /\[triggers\][\s\S]*?crons\s*=\s*\[([\s\S]*?)\]/.exec(toml);
  expect(block).not.toBeNull();
  const body = block?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** `src/app/api/cron/<name>/route.ts` が実在するパス一覧。 */
function routeHandlerPaths(): string[] {
  const dir = path.join(REPO_ROOT, "src", "app", "api", "cron");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/api/cron/${entry.name}`)
    .sort();
}

describe("cron の三者一致（cron Worker / Route Handler / [triggers] crons）", () => {
  const workerPaths = CRON_ROUTES.map((route) => route.path).sort();

  it("cron Worker が叩くパスと CRON_PATHS が一致する", () => {
    expect(workerPaths).toEqual([...CRON_PATHS].sort());
  });

  it("cron Worker が叩くパスに Route Handler が実在する", () => {
    expect(routeHandlerPaths()).toEqual(workerPaths);
  });

  it("[triggers] crons と cron Worker の cron 式が 1:1 で対応する", () => {
    const crons = wranglerCrons();
    expect(crons.length).toBe(CRON_ROUTES.length);
    expect([...crons].sort()).toEqual(CRON_ROUTES.map((route) => route.cron).sort());
    // 同じ cron 式を 2 つのパスに割り当てない（発火しても片方しか呼ばれなくなる）。
    expect(new Set(crons).size).toBe(crons.length);
  });

  it("6 パスすべてが登録されている", () => {
    expect(workerPaths.length).toBe(6);
  });
});
