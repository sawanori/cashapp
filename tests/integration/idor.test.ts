/**
 * IDOR・トークン・preview の統合テスト（実 Postgres）。
 *
 * task_015 scope / acceptance-checks:
 *   - 別人 claim 不可 / 再 claim 不可 / unclaim 後に本人 claim 可 / 支払済み unclaim で needs_attention
 *   - joinToken だけでは 401（セッション必須。check_004）
 *   - 他イベントの joinToken では到達できない
 *   - 期限切れ 404 / ローテーション後の旧トークン 404（check_084）
 *   - レート制限 429
 *   - preview の応答に `amount` / `status` キーが無い（型と実データの両方）
 *   - ログに joinToken の平文が 0 件
 *   - self-report が ledger_entry に書かない
 *
 * 隔離: DB を使うケースはすべて `withRollback` のトランザクション内。接続は `app_rw`。
 */

import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { EventPreview } from "@/lib/db/repositories/claims";

import {
  REPO_ROOT,
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  expectFailure,
  withRollback,
} from "./setup";

vi.mock("server-only", () => ({}));

const { AppError } = await import("@/lib/errors");
const { MIN_SECRET_BYTES, loadAppConfig } = await import("@/lib/config/env");
const { requireSession } = await import("@/lib/auth/session");
const { resolveRateLimiter } = await import("@/lib/auth/rate-limit");
const { createEvent } = await import("@/lib/db/repositories/events");
const { createParticipants } = await import("@/lib/db/repositories/participants");
const { issueInvoices } = await import("@/lib/db/repositories/invoices");
const {
  buildEventPreview,
  claimParticipant,
  getMyInvoice,
  listCandidates,
  selfReport,
  unclaimParticipant,
} = await import("@/lib/db/repositories/claims");
const {
  JOIN_TOKEN_HEADER,
  generateToken,
  resolveEventByJoinToken,
  rotateJoinToken,
} = await import("@/lib/join-token");

type CreateEventInput = Parameters<typeof createEvent>[2];

const LOGIN_CHANNEL_ID = "2000000000";

function testConfig(): ReturnType<typeof loadAppConfig> {
  return loadAppConfig({
    APP_ENV: "development",
    LINE_ENV_PROFILE: JSON.stringify({
      env: "development",
      liffId: `${LOGIN_CHANNEL_ID}-abcd1234`,
      loginChannelId: LOGIN_CHANNEL_ID,
    }),
    PEPPER: `1:${"p".repeat(MIN_SECRET_BYTES)}`,
    SESSION_KEYS: `cur:${"s".repeat(MIN_SECRET_BYTES)}`,
    CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
  });
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

function uniq(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function asSql(tx: postgres.TransactionSql): postgres.Sql {
  return tx as unknown as postgres.Sql;
}

interface TestUser {
  readonly id: string;
  readonly ref: Buffer;
}

async function insertUser(tx: postgres.TransactionSql, suffix: string): Promise<TestUser> {
  const ref = Buffer.from(`user-${suffix}`);
  const rows = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${ref}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("failed to insert test user");
  return { id: row.id, ref };
}

function baseEventInput(overrides: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    title: "夏合宿",
    organizerLabel: "山田太郎",
    eventAt: null,
    venue: null,
    offering: null,
    defaultAmountMinor: 3000,
    collectByAt: null,
    minorsIncluded: false,
    allowCash: false,
    feeDisclosureAccepted: true,
    ...overrides,
  };
}

interface Fixture {
  readonly organizerId: string;
  readonly eventId: string;
  readonly joinToken: string;
  readonly participants: readonly { id: string; claimToken: string }[];
}

/** 幹事・イベント・名簿・請求まで作り、期限つきの招待トークンを 1 本発行する。 */
async function setupEvent(
  tx: postgres.TransactionSql,
  labels: readonly string[] = ["山田", "鈴木"],
): Promise<Fixture> {
  const organizer = await insertUser(tx, uniq());
  const event = await createEvent(tx, organizer.id, baseEventInput());
  const created = await createParticipants(
    tx,
    organizer.id,
    event.event.id,
    labels.map((displayLabel) => ({ displayLabel })),
  );
  await tx`UPDATE participant SET name_visibility = 'participants' WHERE event_id = ${event.event.id}`;
  await issueInvoices(tx, organizer.id, event.event.id);
  const rotated = await rotateJoinToken(tx, organizer.id, event.event.id);
  return {
    organizerId: organizer.id,
    eventId: event.event.id,
    joinToken: rotated.token,
    participants: created.map((p) => ({ id: p.id, claimToken: p.claimToken })),
  };
}

// ============================================================================
// トークンの寿命とローテーション（check_084）
// ============================================================================

describe("招待トークンの寿命とローテーション（check_084）", () => {
  it("発行直後のトークンはイベントを解決できる", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const event = await resolveEventByJoinToken(asSql(tx), fixture.joinToken);
      expect(event.id).toBe(fixture.eventId);
    });
  });

  it("ローテーション後の旧トークンは 404（新しいトークンは通る）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const rotated = await rotateJoinToken(tx, fixture.organizerId, fixture.eventId);

      const error = await expectFailure(tx, async (sp) => {
        await resolveEventByJoinToken(asSql(sp), fixture.joinToken);
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(404);
      expect((error as InstanceType<typeof AppError>).code).toBe("JOIN_TOKEN_INVALID");

      const event = await resolveEventByJoinToken(asSql(tx), rotated.token);
      expect(event.id).toBe(fixture.eventId);
    });
  });

  it("期限を過ぎたトークンは 404", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      await tx`
        UPDATE event SET join_token_expires_at = now() - interval '1 day' WHERE id = ${fixture.eventId}
      `;
      const error = await expectFailure(tx, async (sp) => {
        await resolveEventByJoinToken(asSql(sp), fixture.joinToken);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(404);
    });
  });

  it("存在しないトークンも 404（イベントの有無を区別しない）", async () => {
    await withRollback(appRw, async (tx) => {
      await setupEvent(tx);
      const error = await expectFailure(tx, async (sp) => {
        await resolveEventByJoinToken(asSql(sp), generateToken());
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(404);
    });
  });

  it("キャンセル済みイベントのトークンは 404", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      await tx`UPDATE event SET status = 'canceled' WHERE id = ${fixture.eventId}`;
      const error = await expectFailure(tx, async (sp) => {
        await resolveEventByJoinToken(asSql(sp), fixture.joinToken);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(404);
    });
  });

  it("期限が記録されていないトークンは無効（fail-closed。round1 GPT F-2）", async () => {
    await withRollback(appRw, async (tx) => {
      const organizer = await insertUser(tx, uniq());
      const created = await createEvent(tx, organizer.id, baseEventInput());
      // `createEvent`（task_014 所有）は期限を書かない。発行経路（POST /api/events）が
      // 期限を入れるまでは、そのトークンでイベントを解決できてはならない。
      const rows = await tx<{ join_token_expires_at: Date | null }[]>`
        SELECT join_token_expires_at FROM event WHERE id = ${created.event.id}
      `;
      expect(rows[0]?.join_token_expires_at).toBeNull();

      const error = await expectFailure(tx, async (sp) => {
        await resolveEventByJoinToken(asSql(sp), created.joinToken);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(404);

      // 期限を入れれば同じトークンで解決できる（POST /api/events がこれを行う）。
      await tx`
        UPDATE event SET join_token_expires_at = now() + interval '90 days' WHERE id = ${created.event.id}
      `;
      const resolved = await resolveEventByJoinToken(asSql(tx), created.joinToken);
      expect(resolved.id).toBe(created.event.id);
    });
  });

  it("POST /api/events のルートが作成直後に期限を書き込む（静的）", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src", "app", "api", "events", "route.ts"),
      "utf8",
    );
    expect(source).toContain("join_token_expires_at");
    expect(source).toContain("JOIN_TOKEN_TTL_DAYS");
  });

  it("他人はローテーションできない（404。存在を教えない）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const stranger = await insertUser(tx, uniq());
      const error = await expectFailure(tx, async (sp) => {
        await rotateJoinToken(sp, stranger.id, fixture.eventId);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(404);
    });
  });
});

// ============================================================================
// トークンだけでは認可されない（check_004）
// ============================================================================

describe("joinToken だけでは認可されない（check_004）", () => {
  it("有効な X-Join-Token を持っていてもセッション Cookie が無ければ 401", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const request = new Request("https://app.example/api/e/me", {
        headers: { [JOIN_TOKEN_HEADER]: fixture.joinToken },
      });

      const error = await expectFailure(tx, async (sp) => {
        await requireSession(testConfig(), asSql(sp), request);
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(401);
      expect((error as InstanceType<typeof AppError>).code).toBe("UNAUTHORIZED");

      // preview だけはセッション無しで通る（公開最小情報）。
      const preview = await buildEventPreview(asSql(tx), {
        id: fixture.eventId,
        title: "夏合宿",
        organizerLabel: "山田太郎",
        collectByAt: null,
        defaultAmountMinor: 3000,
        allowCash: false,
      });
      expect(preview.participantCount).toBe(2);
    });
  });

  it("preview 以外の /api/e/* はすべて requireSession を通る（静的）", () => {
    const dir = path.join(REPO_ROOT, "src", "app", "api", "e");
    const routes = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      const source = fs.readFileSync(path.join(dir, route, "route.ts"), "utf8");
      if (route === "preview") {
        expect(source).not.toContain("requireSession(");
      } else {
        expect(source).toContain("requireSession(");
      }
    }
  });
});

// ============================================================================
// 他イベントのトークンでは到達できない
// ============================================================================

describe("イベントの越境", () => {
  it("イベント A のトークンでイベント B の participant は claim できない", async () => {
    await withRollback(appRw, async (tx) => {
      const eventA = await setupEvent(tx);
      const eventB = await setupEvent(tx);
      const user = await insertUser(tx, uniq());

      const error = await expectFailure(tx, async (sp) => {
        await claimParticipant(sp, {
          eventId: eventA.eventId,
          lineUserRef: user.ref,
          pepperVersion: 1,
          input: { participantId: eventB.participants[0]!.id, confirmed: true },
        });
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(404);
    });
  });

  it("イベント A のトークンでイベント B の claimToken も使えない", async () => {
    await withRollback(appRw, async (tx) => {
      const eventA = await setupEvent(tx);
      const eventB = await setupEvent(tx);
      const user = await insertUser(tx, uniq());

      const error = await expectFailure(tx, async (sp) => {
        await claimParticipant(sp, {
          eventId: eventA.eventId,
          lineUserRef: user.ref,
          pepperVersion: 1,
          input: { claimToken: eventB.participants[0]!.claimToken },
        });
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(404);
    });
  });

  it("イベント B で claim した人が、イベント A の文脈では請求を見られない", async () => {
    await withRollback(appRw, async (tx) => {
      const eventA = await setupEvent(tx);
      const eventB = await setupEvent(tx);
      const user = await insertUser(tx, uniq());

      await claimParticipant(tx, {
        eventId: eventB.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: eventB.participants[0]!.id, confirmed: true },
      });

      const error = await expectFailure(tx, async (sp) => {
        await getMyInvoice(asSql(sp), eventA.eventId, user.ref);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(403);
      expect((error as InstanceType<typeof AppError>).code).toBe("NOT_CLAIMED");
    });
  });

  it("他人の請求は GET /api/e/me の経路から見えない", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const owner = await insertUser(tx, uniq());
      const stranger = await insertUser(tx, uniq());

      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: owner.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });

      const mine = await getMyInvoice(asSql(tx), fixture.eventId, owner.ref);
      expect(mine.participantId).toBe(fixture.participants[0]!.id);

      const error = await expectFailure(tx, async (sp) => {
        await getMyInvoice(asSql(sp), fixture.eventId, stranger.ref);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(403);
    });
  });
});

// ============================================================================
// claim の 4 本（scope: 別人 / 再 claim / unclaim 後 / 支払済み unclaim）
// ============================================================================

describe("claim と unclaim（IDOR の本体）", () => {
  it("別人が claim 済みの行は claim できず、unclaim 後は本人が claim し直せる", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const first = await insertUser(tx, uniq());
      const second = await insertUser(tx, uniq());
      const target = { participantId: fixture.participants[0]!.id, confirmed: true } as const;

      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: first.ref,
        pepperVersion: 1,
        input: target,
      });

      const blocked = await expectFailure(tx, async (sp) => {
        await claimParticipant(sp, {
          eventId: fixture.eventId,
          lineUserRef: second.ref,
          pepperVersion: 1,
          input: target,
        });
      });
      expect((blocked as InstanceType<typeof AppError>).code).toBe("ALREADY_CLAIMED");

      await unclaimParticipant(tx, fixture.organizerId, fixture.eventId, target.participantId);

      const reclaimed = await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: second.ref,
        pepperVersion: 1,
        input: target,
      });
      expect(reclaimed.participantId).toBe(target.participantId);
    });
  });

  it("氏名を共有していない行は participantId 経路で claim できない（round1 GPT F-1・high）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const attacker = await insertUser(tx, uniq());
      const target = fixture.participants[0]!;

      // 幹事が氏名の共有を取り消した（既定の organizer_only に戻した）行。
      await tx`UPDATE participant SET name_visibility = 'organizer_only' WHERE id = ${target.id}`;

      // 候補一覧には出てこない。
      const candidates = await listCandidates(asSql(tx), fixture.eventId);
      expect(candidates.map((c) => c.id)).not.toContain(target.id);

      // UUID を知っていても名簿選択の経路では到達できない（404。存在を区別しない）。
      const error = await expectFailure(tx, async (sp) => {
        await claimParticipant(sp, {
          eventId: fixture.eventId,
          lineUserRef: attacker.ref,
          pepperVersion: 1,
          input: { participantId: target.id, confirmed: true },
        });
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(404);

      // 誰にも claim されていないこと（＝上の呼び出しで行が押さえられていない）。
      const claims = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM participant_claim
        WHERE participant_id = ${target.id} AND released_at IS NULL
      `;
      expect(Number(claims[0]?.n)).toBe(0);

      // 本人（個別リンクの持ち主）は claimToken 経路で claim できる。
      const claimed = await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: attacker.ref,
        pepperVersion: 1,
        input: { claimToken: target.claimToken },
      });
      expect(claimed.via).toBe("claim_token");
    });
  });

  it("支払済みの参加者を unclaim すると needs_attention が立つ（ランクは不変）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());
      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });
      await tx`
        UPDATE invoice SET settlement_status = 'paid', paid_at = now()
        WHERE participant_id = ${fixture.participants[0]!.id}
      `;

      const result = await unclaimParticipant(
        tx,
        fixture.organizerId,
        fixture.eventId,
        fixture.participants[0]!.id,
      );
      expect(result.needsAttention).toBe(true);

      const rows = await tx<{ needs_attention: boolean; settlement_rank: number }[]>`
        SELECT needs_attention, settlement_rank FROM invoice
        WHERE participant_id = ${fixture.participants[0]!.id}
      `;
      expect(rows[0]?.needs_attention).toBe(true);
      expect(rows[0]?.settlement_rank).toBe(40);
    });
  });
});

// ============================================================================
// preview の中身（同意前に個人情報を出さない）
// ============================================================================

describe("preview に amount / status キーが無い", () => {
  it("型レベル: EventPreview は `amount` も `status` も持たない", () => {
    type HasKey<T, K extends string> = K extends keyof T ? true : false;
    const hasAmount: HasKey<EventPreview, "amount"> = false;
    const hasStatus: HasKey<EventPreview, "status"> = false;
    const hasDisplayLabel: HasKey<EventPreview, "displayLabel"> = false;
    const hasParticipants: HasKey<EventPreview, "participants"> = false;
    expect([hasAmount, hasStatus, hasDisplayLabel, hasParticipants]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("実データ: 応答のキーは決め打ちの 6 つだけで、氏名も個別金額も含まない", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx, ["山田太郎", "鈴木花子"]);
      const preview = await buildEventPreview(asSql(tx), {
        id: fixture.eventId,
        title: "夏合宿",
        organizerLabel: "山田太郎",
        collectByAt: null,
        defaultAmountMinor: 3000,
        allowCash: false,
      });

      expect(Object.keys(preview).sort()).toEqual([
        "allowCash",
        "amountRangeMinor",
        "collectByAt",
        "organizerLabel",
        "participantCount",
        "title",
      ]);
      expect(Object.keys(preview)).not.toContain("amount");
      expect(Object.keys(preview)).not.toContain("status");

      const serialized = JSON.stringify(preview);
      expect(serialized).not.toContain("鈴木花子");
      expect(preview.participantCount).toBe(2);
      expect(preview.amountRangeMinor).toEqual({ min: 3000, max: 3000 });
    });
  });
});

// ============================================================================
// 自己申告は台帳に書かない
// ============================================================================

describe("self-report は ledger_entry に書かない", () => {
  it("申告後も ledger_entry の件数が変わらない", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());
      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });

      const before = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM ledger_entry`;
      await selfReport(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        input: { method: "cash" },
      });
      const after = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM ledger_entry`;
      expect(after[0]?.n).toBe(before[0]?.n);
    });
  });
});

// ============================================================================
// レート制限（429）
// ============================================================================

describe("レート制限", () => {
  it("バックエンドが超過を返したら allowed=false になる", async () => {
    const limiter = resolveRateLimiter({
      AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    const decision = await limiter.check("e-preview:test");
    expect(decision.allowed).toBe(false);
    expect(decision.backend).toBe("workers-rate-limit-binding");
  });

  it("preview ルートは DB へ接続する前にレート制限を判定し、超過を 429 に写す（静的）", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src", "app", "api", "e", "preview", "route.ts"),
      "utf8",
    );
    const limitAt = source.indexOf("rateLimiter.check(");
    const dbAt = source.indexOf("createVerifiedDbClient(routeEnv)");
    expect(limitAt).toBeGreaterThan(-1);
    expect(dbAt).toBeGreaterThan(-1);
    expect(limitAt).toBeLessThan(dbAt);
    expect(source).toContain("throw rateLimited(");
  });

  it("rateLimited() は 429 である", async () => {
    const { rateLimited } = await import("@/lib/errors");
    expect(rateLimited().status).toBe(429);
  });
});

// ============================================================================
// ログに平文のトークンを出さない（check_084）
// ============================================================================

describe("ログに joinToken の平文が 0 件（check_084）", () => {
  function listSourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listSourceFiles(full));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
  }

  it("logEvent の引数にトークンを渡している箇所が 1 つも無い", () => {
    const files = listSourceFiles(path.join(REPO_ROOT, "src"));
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      // `logEvent(` から対応する閉じ括弧までを粗く取り出し、トークン名が現れないことを見る。
      const pattern = /logEvent\(([\s\S]*?)\n\s*\}\);/g;
      let match = pattern.exec(source);
      while (match !== null) {
        const args = match[1] ?? "";
        if (/joinToken|claimToken|idToken|csrfToken/.test(args)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
        match = pattern.exec(source);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("トークンを含む例外でも、応答本文と detail に平文が出ない", async () => {
    const token = generateToken();
    const { readJoinTokenHeader } = await import("@/lib/join-token");
    const request = new Request("https://app.example/api/e/preview", {
      headers: { [JOIN_TOKEN_HEADER]: `${token}!!invalid` },
    });
    try {
      readJoinTokenHeader(request);
      expect.unreachable();
    } catch (error) {
      const appError = error as InstanceType<typeof AppError>;
      expect(appError.message).not.toContain(token);
      expect(appError.detail ?? "").not.toContain(token);
    }
  });

  it("トークンをパスに置いたルートが存在しない（制約 X-ID / check_084）", () => {
    const appDir = path.join(REPO_ROOT, "src", "app");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (/^\[(joinToken|join_token|token|claimToken)\]$/.test(entry.name)) {
            offenders.push(path.relative(REPO_ROOT, full));
          }
          walk(full);
        }
      }
    };
    walk(appDir);
    expect(offenders).toEqual([]);
  });
});
