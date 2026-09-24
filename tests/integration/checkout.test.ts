/**
 * `POST /api/e/checkout` の統合テスト（実 Postgres・ロール `app_rw`）。
 *
 * task_017 done_definition / check_093 / check_010 / check_022 / check_090:
 *   - 同一請求へ同時 2 回 checkout しても生きた試行は 1 つ
 *   - 金額はサーバーが請求から読む（クライアントの申告を受けない）
 *   - claim していない請求は 403
 *   - ゲート未通過なら 409 で `payment_attempt` を 1 行も作らない
 *   - レジストリの 9 パターンを**実 DB の `compliance_gate` / `feature_flag` / `app_user`**で走らせる
 *     （フェイクで走らせる版は `tests/unit/payments/registry.test.ts`）
 *
 * 隔離: 原則 `withRollback`。**同時実行の 1 ケースだけ**は実コミットが要るので、
 * 作った行を明示的に後始末する（`audit_log` は追記専用なので migrator でトリガを外して消す。
 * `tests/integration/audit-chain.test.ts` と同じ手口）。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  withRollback,
} from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in integration tests");
  },
}));

const { AppError } = await import("@/lib/errors");
const { createCheckoutForClaim, buildExternalRef, buildReturnUrl, parseCheckoutBody } = await import(
  "@/app/api/e/checkout/route"
);
const { CANONICAL_GATES } = await import("@/lib/payments/gates");
const {
  GATE_REASON,
  PRODUCTION_APP_ENV,
  REGISTRY,
  dbGateEnvironment,
  resolveProvider,
} = await import("@/lib/payments/registry");
const { MANUAL_CONFIRM_PROVIDER_KEY, NotSupportedError, ProviderNotEnabledError } = await import(
  "@/lib/payments/types"
);
type RegistryEntry = (typeof REGISTRY)[string];

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

const LIFF_ID = "1234567890-abcdefgh";

interface Fixture {
  readonly organizerId: string;
  readonly payerUserId: string;
  readonly eventId: string;
  readonly participantId: string;
  readonly invoiceId: string;
}

/** 幹事・参加者（claim 済み）・イベント・請求の一式。 */
async function insertClaimedFixture(
  tx: postgres.TransactionSql,
  suffix: string,
  options: { readonly minorsIncluded?: boolean; readonly providerKey?: string } = {},
): Promise<Fixture> {
  const [organizer] = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`organizer-${suffix}`)}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const payerRef = Buffer.from(`payer-${suffix}`);
  const [payer] = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${payerRef}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const [event] = await tx<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       minors_included, default_amount_minor, provider_key, status)
    VALUES (${organizer!.id}, ${`event-${suffix}`}, '山田太郎', ${Buffer.from(`join-${suffix}`)},
            ${options.minorsIncluded ?? false}, 3000,
            ${options.providerKey ?? MANUAL_CONFIRM_PROVIDER_KEY}, 'collecting')
    RETURNING id
  `;
  const [participant] = await tx<{ id: string }[]>`
    INSERT INTO participant (event_id, display_label)
    VALUES (${event!.id}, ${`p-${suffix}`})
    RETURNING id
  `;
  await tx`
    INSERT INTO participant_claim (event_id, participant_id, line_user_ref, pepper_version)
    VALUES (${event!.id}, ${participant!.id}, ${payerRef}, 1)
  `;
  const [invoice] = await tx<{ id: string }[]>`
    INSERT INTO invoice (event_id, participant_id, amount_minor)
    VALUES (${event!.id}, ${participant!.id}, 3000)
    RETURNING id
  `;
  return {
    organizerId: organizer!.id,
    payerUserId: payer!.id,
    eventId: event!.id,
    participantId: participant!.id,
    invoiceId: invoice!.id,
  };
}

function params(fixture: Fixture, requestId = "req-checkout"): Parameters<typeof createCheckoutForClaim>[1] {
  return {
    appUserId: fixture.payerUserId,
    invoiceId: fixture.invoiceId,
    appEnv: "development",
    liffId: LIFF_ID,
    requestId,
  };
}

// ============================================================================
// 純粋関数
// ============================================================================

describe("金額を取らない（§9）", () => {
  it("invoiceId だけを受け取り、金額系のキーがあれば 400", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(parseCheckoutBody({ invoiceId: id }).invoiceId).toBe(id);
    for (const key of ["amount", "amountMinor", "money", "currency"]) {
      expect(() => parseCheckoutBody({ invoiceId: id, [key]: 3000 })).toThrow(AppError);
    }
  });

  it("externalRef は 64 文字・[A-Za-z0-9_-] に収まる", () => {
    const ref = buildExternalRef("33333333-3333-4333-8333-333333333333", 1);
    expect(ref).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(ref).toBe("iv_33333333333343338333333333333333_1");
  });

  it("returnUrl は LINE ミニアプリのパーマネントリンク（制約 P4）", () => {
    expect(buildReturnUrl(LIFF_ID, "abc")).toBe(
      `https://liff.line.me/${LIFF_ID}/e/return?invoice=abc`,
    );
  });
});

// ============================================================================
// 手動確認の checkout
// ============================================================================

describe("手動確認の checkout", () => {
  it("試行を write-ahead し、非自動ラベル付きの手動案内を返す", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertClaimedFixture(tx, uniq());
      const outcome = await createCheckoutForClaim(tx, params(fixture));

      expect(outcome.statusCode).toBe(201);
      expect(outcome.body["autoDetected"]).toBe(false);
      expect(outcome.body["confirmationMethod"]).toBe("manual_by_organizer");
      expect(outcome.body["reused"]).toBe(false);

      const ticket = outcome.body["ticket"] as { kind: string; instruction: { automatic: boolean } };
      expect(ticket.kind).toBe("manual");
      expect(ticket.instruction.automatic).toBe(false);

      const attempts = await tx<
        { provider_key: string; amount_minor: number; is_open: boolean; checkout_url: string | null }[]
      >`
        SELECT provider_key, amount_minor, is_open, checkout_url
        FROM payment_attempt WHERE invoice_id = ${fixture.invoiceId}
      `;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.provider_key).toBe(MANUAL_CONFIRM_PROVIDER_KEY);
      // 金額はクライアントではなく請求から読む。
      expect(attempts[0]?.amount_minor).toBe(3000);
      expect(attempts[0]?.checkout_url).toBeNull();
    });
  });

  it("2 回目は生きた試行を再利用し、試行は 1 つのまま（check_093）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertClaimedFixture(tx, uniq());
      const first = await createCheckoutForClaim(tx, params(fixture, "r1"));
      const second = await createCheckoutForClaim(tx, params(fixture, "r2"));

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.body["reused"]).toBe(true);
      expect((second.body["attempt"] as { id: string }).id).toBe(
        (first.body["attempt"] as { id: string }).id,
      );

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM payment_attempt WHERE invoice_id = ${fixture.invoiceId}
      `;
      expect(rows[0]?.n).toBe("1");
    });
  });

  it("DB 側の一意制約が「生きた試行は 1 つ」を保証する（アプリの分岐を外しても破れない）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertClaimedFixture(tx, uniq());
      await createCheckoutForClaim(tx, params(fixture));

      const [binding] = await tx<{ id: string }[]>`
        SELECT id FROM provider_binding WHERE organizer_user_id = ${fixture.organizerId}
      `;
      let failure: unknown;
      try {
        await tx.savepoint(async (sp) => {
          await sp`
            INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id,
                                         external_ref, amount_minor)
            VALUES (${fixture.invoiceId}, 'manual_confirm', ${binding!.id},
                    ${buildExternalRef(fixture.invoiceId, 99)}, 3000)
          `;
        });
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string } | undefined)?.code).toBe("23505");
    });
  });

  it("claim していない利用者は 403（存在を漏らさない）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertClaimedFixture(tx, uniq());
      const [stranger] = await tx<{ id: string }[]>`
        INSERT INTO app_user (line_user_ref, identity_scope, line_env)
        VALUES (${Buffer.from(`stranger-${uniq()}`)}, 'test:stranger', 'development')
        RETURNING id
      `;

      try {
        await createCheckoutForClaim(tx, { ...params(fixture), appUserId: stranger!.id });
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(403);
      }

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM payment_attempt WHERE invoice_id = ${fixture.invoiceId}
      `;
      expect(rows[0]?.n).toBe("0");
    });
  });

  it("支払済み・取消済み・中止イベントには新しい試行を作らない（409）", async () => {
    await withRollback(appRw, async (tx) => {
      const paid = await insertClaimedFixture(tx, uniq());
      await tx`UPDATE invoice SET settlement_status = 'paid' WHERE id = ${paid.invoiceId}`;
      await expect(createCheckoutForClaim(tx, params(paid))).rejects.toBeInstanceOf(AppError);

      const voided = await insertClaimedFixture(tx, uniq());
      await tx`
        UPDATE invoice SET lifecycle_state = 'void', voided_at = now() WHERE id = ${voided.invoiceId}
      `;
      await expect(createCheckoutForClaim(tx, params(voided))).rejects.toBeInstanceOf(AppError);

      const canceled = await insertClaimedFixture(tx, uniq());
      await tx`UPDATE event SET status = 'canceled' WHERE id = ${canceled.eventId}`;
      await expect(createCheckoutForClaim(tx, params(canceled))).rejects.toBeInstanceOf(AppError);
    });
  });

  it("未成年を含むイベントでも手動確認は使える（自動決済だけを止める）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertClaimedFixture(tx, uniq(), { minorsIncluded: true });
      const outcome = await createCheckoutForClaim(tx, params(fixture));
      expect(outcome.statusCode).toBe(201);
      expect(outcome.body["autoDetected"]).toBe(false);
    });
  });
});

// ============================================================================
// 同時 2 回（実コミット。後始末つき）
// ============================================================================

describe("同一請求へ同時 2 回 checkout（check_093）", () => {
  it("生きた試行は 1 つだけになる", async () => {
    const suffix = uniq();
    const requestId = `concurrent-${suffix}`;
    let fixture: Fixture | undefined;

    try {
      fixture = await appRw.begin(async (tx) => insertClaimedFixture(tx, suffix));
      const target = fixture;

      const results = await Promise.allSettled([
        appRw.begin(async (tx) => createCheckoutForClaim(tx, { ...params(target, requestId) })),
        appRw.begin(async (tx) => createCheckoutForClaim(tx, { ...params(target, requestId) })),
      ]);

      // 2 本とも成功してよい（2 本目は再利用を返す）。落ちるとしても一意制約であり、
      // いずれにせよ**生きた試行は 1 つ**でなければならない。
      const open = await appRw<{ n: string }[]>`
        SELECT count(*)::text AS n FROM payment_attempt
        WHERE invoice_id = ${target.invoiceId} AND is_open
      `;
      expect(open[0]?.n).toBe("1");

      const all = await appRw<{ n: string }[]>`
        SELECT count(*)::text AS n FROM payment_attempt WHERE invoice_id = ${target.invoiceId}
      `;
      expect(all[0]?.n).toBe("1");
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    } finally {
      if (fixture !== undefined) {
        const target = fixture;
        await appRw`DELETE FROM payment_attempt WHERE invoice_id = ${target.invoiceId}`;
        await appRw`DELETE FROM invoice WHERE id = ${target.invoiceId}`;
        await appRw`DELETE FROM participant_claim WHERE participant_id = ${target.participantId}`;
        await appRw`DELETE FROM participant WHERE id = ${target.participantId}`;
        await appRw`DELETE FROM event WHERE id = ${target.eventId}`;
        await appRw`DELETE FROM provider_binding WHERE organizer_user_id = ${target.organizerId}`;
        await appRw`DELETE FROM app_user WHERE id IN (${target.organizerId}, ${target.payerUserId})`;
        // audit_log は追記専用。既存の統合テストと同じ手口でトリガを外して消す。
        await migrator.begin(async (mtx) => {
          await mtx`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete`;
          await mtx`DELETE FROM audit_log WHERE request_id = ${requestId}`;
          await mtx`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`;
        });
      }
    }
  });
});

// ============================================================================
// 実 DB のゲート・フラグで 9 パターン（check_090）
// ============================================================================

describe("resolveProvider の 9 パターン（実 DB の compliance_gate / feature_flag / app_user）", () => {
  const AUTO_KEY = "fixture_provider";

  function autoEntry(fixtureProvenance: "captured" | "synthesized" | "none" = "captured"): RegistryEntry {
    return {
      provider: {
        key: AUTO_KEY,
        capabilities: {
          autoDetect: true,
          webhook: true,
          webhookSignature: "none",
          statusQuery: true,
          refund: "full_once",
          refundWindowDays: null,
          dispute: "none",
          disputeResponseWindowDays: null,
          checkoutIdempotent: true,
          credentialCustody: "server",
          settlementQuery: true,
          feeModel: {
            kind: "undetermined",
            note: "手数料は未定です。",
            rateBp: null,
            fixedMinor: null,
            undetermined: true,
          },
          settlementSchedule: "未定",
          payerIdentity: false,
          settlementLagHint: "未定",
        },
        createCheckout: () => Promise.reject(new NotSupportedError("test double")),
        parseWebhook: () => Promise.resolve([]),
        getPaymentStatus: () => Promise.reject(new NotSupportedError("test double")),
        refund: () => Promise.reject(new NotSupportedError("test double")),
        cancelCheckout: () => Promise.resolve(),
      },
      fixtureProvenance,
    };
  }

  /** 実 DB のゲート射影をすべて passed（evidence_uri 必須の CHECK を満たす）にする。 */
  async function passAllGates(mtx: postgres.TransactionSql): Promise<void> {
    await mtx`
      UPDATE compliance_gate
      SET status = 'passed', evidence_uri = 'test://integration', valid_until = NULL
      WHERE gate_key = ANY(${mtx.array(CANONICAL_GATES.map((gate) => gate.gateKey))})
    `;
  }

  async function setFlag(mtx: postgres.TransactionSql, key: string, value: string): Promise<void> {
    await mtx`
      INSERT INTO feature_flag (key, value, updated_by) VALUES (${key}, ${value}, 'po:test')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  async function insertOrganizer(
    mtx: postgres.TransactionSql,
    suffix: string,
    status: "active" | "suspended" = "active",
  ): Promise<{ id: string; bindingId: string }> {
    const [user] = await mtx<{ id: string }[]>`
      INSERT INTO app_user (line_user_ref, identity_scope, line_env, status, suspended_at)
      VALUES (${Buffer.from(`gate-${suffix}`)}, ${`test:${suffix}`}, 'development', ${status},
              ${status === "suspended" ? new Date() : null})
      RETURNING id
    `;
    const [binding] = await mtx<{ id: string }[]>`
      INSERT INTO provider_binding (organizer_user_id, provider_key, status)
      VALUES (${user!.id}, ${AUTO_KEY}, 'active')
      RETURNING id
    `;
    return { id: user!.id, bindingId: binding!.id };
  }

  function bindingOf(id: string, organizerUserId: string, status = "active"): Parameters<
    typeof resolveProvider
  >[1]["binding"] {
    return {
      id,
      organizerUserId,
      providerKey: AUTO_KEY,
      status: status as "active" | "pending" | "suspended" | "revoked",
      credentialRef: null,
      credentialFp: null,
      receivingIdentifier: null,
      receivingIdentifierKind: null,
    };
  }

  async function expectGate(promise: Promise<unknown>, gateKey: string): Promise<void> {
    try {
      await promise;
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderNotEnabledError);
      expect((error as InstanceType<typeof ProviderNotEnabledError>).gateKey).toBe(gateKey);
    }
  }

  it("9 パターンを実 DB のゲート・フラグで通す", async () => {
    await withRollback(migrator, async (mtx) => {
      const suffix = uniq();
      const organizer = await insertOrganizer(mtx, suffix);
      const suspended = await insertOrganizer(mtx, `${suffix}-s`, "suspended");
      const registry = { ...REGISTRY, [AUTO_KEY]: autoEntry() };

      const base = {
        organizerUserId: organizer.id,
        binding: bindingOf(organizer.bindingId, organizer.id),
        minorsIncluded: false,
        registry,
      };

      // 1. manual_confirm は全ガードをスキップする（種の状態＝ゲート unknown・フラグ false のまま）。
      const manual = await resolveProvider(MANUAL_CONFIRM_PROVIDER_KEY, {
        ...base,
        env: dbGateEnvironment(mtx, "development"),
      });
      expect(manual.capabilities.autoDetect).toBe(false);

      // 2. 非 production。
      await expectGate(
        resolveProvider(AUTO_KEY, { ...base, env: dbGateEnvironment(mtx, "staging") }),
        GATE_REASON.APP_ENV,
      );

      // 3. PAYMENTS_ENABLED（種の値は 'false'）。
      await expectGate(
        resolveProvider(AUTO_KEY, { ...base, env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV) }),
        GATE_REASON.PAYMENTS_ENABLED,
      );

      // 4. ゲート未通過（種の値は全件 'unknown'）。
      await setFlag(mtx, "PAYMENTS_ENABLED", "true");
      await expectGate(
        resolveProvider(AUTO_KEY, { ...base, env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV) }),
        CANONICAL_GATES[0]!.gateKey,
      );

      // 5. valid_until 超過。
      await passAllGates(mtx);
      await mtx`
        UPDATE compliance_gate SET valid_until = now() - interval '1 day'
        WHERE gate_key = ${CANONICAL_GATES[0]!.gateKey}
      `;
      await expectGate(
        resolveProvider(AUTO_KEY, { ...base, env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV) }),
        CANONICAL_GATES[0]!.gateKey,
      );
      await passAllGates(mtx);

      // 6. PROVIDER_<KEY>_MODE = off。
      await setFlag(mtx, `PROVIDER_${AUTO_KEY.toUpperCase()}_MODE`, "off");
      await expectGate(
        resolveProvider(AUTO_KEY, { ...base, env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV) }),
        `PROVIDER_${AUTO_KEY.toUpperCase()}_MODE`,
      );
      await setFlag(mtx, `PROVIDER_${AUTO_KEY.toUpperCase()}_MODE`, "on");

      // 7. binding が active でない。
      await expectGate(
        resolveProvider(AUTO_KEY, {
          ...base,
          binding: bindingOf(organizer.bindingId, organizer.id, "suspended"),
          env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV),
        }),
        GATE_REASON.BINDING_STATUS,
      );

      // 8. 幹事が suspended（実 DB の app_user.status を読む）。
      await expectGate(
        resolveProvider(AUTO_KEY, {
          ...base,
          organizerUserId: suspended.id,
          binding: bindingOf(suspended.bindingId, suspended.id),
          env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV),
        }),
        GATE_REASON.ORGANIZER_SUSPENDED,
      );

      // 9. minors_included。
      await expectGate(
        resolveProvider(AUTO_KEY, {
          ...base,
          minorsIncluded: true,
          env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV),
        }),
        GATE_REASON.MINORS_INCLUDED,
      );

      // 追加: fixture が synthesized のみのアダプタは autoDetect を名乗れない。
      await expectGate(
        resolveProvider(AUTO_KEY, {
          ...base,
          registry: { ...REGISTRY, [AUTO_KEY]: autoEntry("synthesized") },
          env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV),
        }),
        GATE_REASON.FIXTURE_PROVENANCE,
      );

      // すべて満たせば通る（ガードが常に落とすだけの空振りでないことの確認）。
      const resolved = await resolveProvider(AUTO_KEY, {
        ...base,
        env: dbGateEnvironment(mtx, PRODUCTION_APP_ENV),
      });
      expect(resolved.key).toBe(AUTO_KEY);
    });
  });

  it("check_010: ゲート未通過の自動アダプタでは payment_attempt を 1 行も作らない", async () => {
    await withRollback(migrator, async (mtx) => {
      const suffix = uniq();
      const fixture = await insertClaimedFixture(mtx, suffix, { providerKey: AUTO_KEY });
      // イベントの provider_key に合わせた binding を作る（FK の複合制約を満たす）。
      const [binding] = await mtx<{ id: string }[]>`
        INSERT INTO provider_binding (organizer_user_id, provider_key, status)
        VALUES (${fixture.organizerId}, ${AUTO_KEY}, 'active')
        RETURNING id
      `;
      expect(binding?.id).toBeDefined();
      await setFlag(mtx, "PAYMENTS_ENABLED", "true");

      try {
        await createCheckoutForClaim(mtx, { ...params(fixture), appEnv: PRODUCTION_APP_ENV });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        const appError = error as InstanceType<typeof AppError>;
        expect(appError.status).toBe(409);
        // 未登録のアダプタなので PROVIDER_NOT_ENABLED（登録済みでゲート未通過なら GATE_NOT_PASSED）。
        expect(["GATE_NOT_PASSED", "PROVIDER_NOT_ENABLED"]).toContain(appError.code);
      }

      const rows = await mtx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM payment_attempt WHERE invoice_id = ${fixture.invoiceId}
      `;
      expect(rows[0]?.n).toBe("0");
    });
  });
});
