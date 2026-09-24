/**
 * ゲート迂回の統合テスト（check_010 / L11 / R-LAW-14）。
 *
 * Phase 1 の `REGISTRY`（`src/lib/payments/registry.ts`）には `manual_confirm` しか
 * 登録されておらず、`createCheckoutForClaim` は `resolveProvider()` にレジストリを注入する
 * 手段を持たない。そのため「自動アダプタがゲートで止まる」ことそのものは
 * `resolveProvider()` を直接呼んで検査する（`tests/integration/checkout.test.ts` の
 * 「9 パターン」テストと同じ方針・同じ注入手段）。その上で、`manual_confirm` の checkout が
 * どのゲート状態でも `payment_attempt` を作って成立することを `createCheckoutForClaim`
 * （実体）で確認し、非自動アダプタとの非対称性を固定する。
 *
 * `withRollback` のトランザクションで直接呼ぶ（実ルート `POST /api/e/checkout` は
 * `docs/concerns/task_022.md` に記録した timestamptz 不具合で無関係な 500 になるため
 * 経由しない）。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "../integration/setup";

vi.mock("server-only", () => ({}));

const { createCheckoutForClaim } = await import("@/app/api/e/checkout/route");
const { CANONICAL_GATES } = await import("@/lib/payments/gates");
const { REGISTRY, PRODUCTION_APP_ENV, dbGateEnvironment, resolveProvider } = await import(
  "@/lib/payments/registry"
);
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

const AUTO_KEY = "fixture_provider_gate_bypass";

/** 決済を一切作らない自動アダプタのテスト用スタブ（`autoDetect: true` だけを主張する）。 */
function autoEntry(): RegistryEntry {
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
        feeModel: { kind: "undetermined", note: "手数料は未定です。", rateBp: null, fixedMinor: null, undetermined: true },
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
    fixtureProvenance: "captured",
  };
}

async function insertOrganizerWithBinding(
  tx: postgres.TransactionSql,
  suffix: string,
): Promise<{ organizerId: string; bindingId: string }> {
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`gb-${suffix}`)}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const [binding] = await tx<{ id: string }[]>`
    INSERT INTO provider_binding (organizer_user_id, provider_key, status)
    VALUES (${user!.id}, ${AUTO_KEY}, 'active')
    RETURNING id
  `;
  return { organizerId: user!.id, bindingId: binding!.id };
}

function bindingOf(id: string, organizerUserId: string): Parameters<typeof resolveProvider>[1]["binding"] {
  return {
    id,
    organizerUserId,
    providerKey: AUTO_KEY,
    status: "active",
    credentialRef: null,
    credentialFp: null,
    receivingIdentifier: null,
    receivingIdentifierKind: null,
  };
}

async function setFlag(tx: postgres.TransactionSql, key: string, value: string): Promise<void> {
  await tx`
    INSERT INTO feature_flag (key, value, updated_by) VALUES (${key}, ${value}, 'po:test')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/** 例外を捕まえて返すだけ。アサーションは呼び出し側（各 it）が行う。 */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("check_010: PAYMENTS_ENABLED=true でも必須ゲートが通っていなければブロックする", () => {
  it("状態 unknown（行が無い）でブロックされる", async () => {
    await withRollback(migrator, async (tx) => {
      const org = await insertOrganizerWithBinding(tx, uniq());
      await setFlag(tx, "PAYMENTS_ENABLED", "true");
      const registry = { ...REGISTRY, [AUTO_KEY]: autoEntry() };

      const error = await catchError(
        resolveProvider(AUTO_KEY, {
          env: dbGateEnvironment(tx, PRODUCTION_APP_ENV),
          organizerUserId: org.organizerId,
          binding: bindingOf(org.bindingId, org.organizerId),
          minorsIncluded: false,
          registry,
        }),
      );
      expect(error).toBeInstanceOf(ProviderNotEnabledError);
      const gateKey = (error as InstanceType<typeof ProviderNotEnabledError>).gateKey;
      // check_010 のコード判定（`toGateError`）はこの条件で GATE_NOT_PASSED に落とす。
      expect(gateKey.startsWith("GATE-") || gateKey === "G0-USER").toBe(true);
    });
  });

  it("状態 inquired（未確定）でブロックされる", async () => {
    await withRollback(migrator, async (tx) => {
      const org = await insertOrganizerWithBinding(tx, uniq());
      await setFlag(tx, "PAYMENTS_ENABLED", "true");
      await tx`
        UPDATE compliance_gate SET status = 'inquired'
        WHERE gate_key = ANY(${tx.array(CANONICAL_GATES.map((g) => g.gateKey))})
      `;
      const registry = { ...REGISTRY, [AUTO_KEY]: autoEntry() };

      const error = await catchError(
        resolveProvider(AUTO_KEY, {
          env: dbGateEnvironment(tx, PRODUCTION_APP_ENV),
          organizerUserId: org.organizerId,
          binding: bindingOf(org.bindingId, org.organizerId),
          minorsIncluded: false,
          registry,
        }),
      );
      expect(error).toBeInstanceOf(ProviderNotEnabledError);
      const gateKey = (error as InstanceType<typeof ProviderNotEnabledError>).gateKey;
      expect(gateKey.startsWith("GATE-") || gateKey === "G0-USER").toBe(true);
    });
  });

  it("状態 failed（否認）でブロックされる", async () => {
    await withRollback(migrator, async (tx) => {
      const org = await insertOrganizerWithBinding(tx, uniq());
      await setFlag(tx, "PAYMENTS_ENABLED", "true");
      await tx`
        UPDATE compliance_gate SET status = 'failed'
        WHERE gate_key = ANY(${tx.array(CANONICAL_GATES.map((g) => g.gateKey))})
      `;
      const registry = { ...REGISTRY, [AUTO_KEY]: autoEntry() };

      const error = await catchError(
        resolveProvider(AUTO_KEY, {
          env: dbGateEnvironment(tx, PRODUCTION_APP_ENV),
          organizerUserId: org.organizerId,
          binding: bindingOf(org.bindingId, org.organizerId),
          minorsIncluded: false,
          registry,
        }),
      );
      expect(error).toBeInstanceOf(ProviderNotEnabledError);
      const gateKey = (error as InstanceType<typeof ProviderNotEnabledError>).gateKey;
      expect(gateKey.startsWith("GATE-") || gateKey === "G0-USER").toBe(true);
    });
  });

  it("status='passed' でも valid_until を過ぎていれば陳腐化としてブロックされる（R-LAW-14）", async () => {
    await withRollback(migrator, async (tx) => {
      const org = await insertOrganizerWithBinding(tx, uniq());
      await setFlag(tx, "PAYMENTS_ENABLED", "true");
      await tx`
        UPDATE compliance_gate
        SET status = 'passed', evidence_uri = 'test://integration', valid_until = now() - interval '1 day'
        WHERE gate_key = ANY(${tx.array(CANONICAL_GATES.map((g) => g.gateKey))})
      `;
      const registry = { ...REGISTRY, [AUTO_KEY]: autoEntry() };

      const error = await catchError(
        resolveProvider(AUTO_KEY, {
          env: dbGateEnvironment(tx, PRODUCTION_APP_ENV),
          organizerUserId: org.organizerId,
          binding: bindingOf(org.bindingId, org.organizerId),
          minorsIncluded: false,
          registry,
        }),
      );
      expect(error).toBeInstanceOf(ProviderNotEnabledError);
      expect((error as InstanceType<typeof ProviderNotEnabledError>).gateKey).toBe(CANONICAL_GATES[0]!.gateKey);
    });
  });

  it("全ゲート passed（無期限）なら通る — ガードが常に落とすだけの空振りでないことの確認", async () => {
    await withRollback(migrator, async (tx) => {
      const org = await insertOrganizerWithBinding(tx, uniq());
      await setFlag(tx, "PAYMENTS_ENABLED", "true");
      await tx`
        UPDATE compliance_gate
        SET status = 'passed', evidence_uri = 'test://integration', valid_until = NULL
        WHERE gate_key = ANY(${tx.array(CANONICAL_GATES.map((g) => g.gateKey))})
      `;
      // ゲートに加えて PROVIDER_<KEY>_MODE も 'on' でなければ通らない（別レイヤーのガード）。
      await setFlag(tx, `PROVIDER_${AUTO_KEY.toUpperCase()}_MODE`, "on");
      const registry = { ...REGISTRY, [AUTO_KEY]: autoEntry() };

      const resolved = await resolveProvider(AUTO_KEY, {
        env: dbGateEnvironment(tx, PRODUCTION_APP_ENV),
        organizerUserId: org.organizerId,
        binding: bindingOf(org.bindingId, org.organizerId),
        minorsIncluded: false,
        registry,
      });
      expect(resolved.key).toBe(AUTO_KEY);
      expect(resolved.capabilities.autoDetect).toBe(true);
    });
  });
});

describe("ゲートで止まった場合に payment_attempt を 1 行も作らない（check_010 の安全側の帰結）", () => {
  it("イベントの provider_key が未登録アダプタを指していても、実 checkout 経路は 409 で attempt を作らない", async () => {
    await withRollback(migrator, async (tx) => {
      const suffix = uniq();
      const [organizer] = await tx<{ id: string }[]>`
        INSERT INTO app_user (line_user_ref, identity_scope, line_env)
        VALUES (${Buffer.from(`gb-route-${suffix}`)}, ${`test:${suffix}`}, 'development')
        RETURNING id
      `;
      const payerRef = Buffer.from(`gb-payer-${suffix}`);
      const [payer] = await tx<{ id: string }[]>`
        INSERT INTO app_user (line_user_ref, identity_scope, line_env)
        VALUES (${payerRef}, ${`test:${suffix}`}, 'development')
        RETURNING id
      `;
      const [event] = await tx<{ id: string }[]>`
        INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                           minors_included, default_amount_minor, provider_key, status)
        VALUES (${organizer!.id}, ${`event-${suffix}`}, '山田太郎', ${Buffer.from(`join-${suffix}`)},
                false, 3000, ${AUTO_KEY}, 'collecting')
        RETURNING id
      `;
      await tx`
        INSERT INTO provider_binding (organizer_user_id, provider_key, status)
        VALUES (${organizer!.id}, ${AUTO_KEY}, 'active')
      `;
      const [participant] = await tx<{ id: string }[]>`
        INSERT INTO participant (event_id, display_label) VALUES (${event!.id}, ${`p-${suffix}`}) RETURNING id
      `;
      await tx`
        INSERT INTO participant_claim (event_id, participant_id, line_user_ref, pepper_version)
        VALUES (${event!.id}, ${participant!.id}, ${payerRef}, 1)
      `;
      const [invoice] = await tx<{ id: string }[]>`
        INSERT INTO invoice (event_id, participant_id, amount_minor) VALUES (${event!.id}, ${participant!.id}, 3000)
        RETURNING id
      `;
      await setFlag(tx, "PAYMENTS_ENABLED", "true");

      // 実 REGISTRY に AUTO_KEY は無いので PROVIDER_NOT_ENABLED / GATE_NOT_PASSED の
      // どちらのコードで落ちるかは実装の内部事情（未登録が先か、ゲート判定が先か）に
      // 依存する。ここで固定したいのは「安全側の帰結（409・0 行）」であり、コード文字列の
      // 一意性ではない。
      const error = await catchError(
        createCheckoutForClaim(tx, {
          appUserId: payer!.id,
          invoiceId: invoice!.id,
          appEnv: PRODUCTION_APP_ENV,
          liffId: "1234567890-abcdefgh",
          requestId: "gb-route",
        }),
      );
      expect(error).toBeDefined();
      expect((error as { status?: number }).status).toBe(409);

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM payment_attempt WHERE invoice_id = ${invoice!.id}
      `;
      expect(rows[0]?.n).toBe("0");
    });
  });
});

describe("manual_confirm はいずれのゲート状態でも常にゲートを見ずに素通りする（§7-6）", () => {
  it("PAYMENTS_ENABLED=false・ゲート全 unknown でも manual_confirm の checkout は成立する", async () => {
    await withRollback(migrator, async (tx) => {
      const suffix = uniq();
      const [organizer] = await tx<{ id: string }[]>`
        INSERT INTO app_user (line_user_ref, identity_scope, line_env)
        VALUES (${Buffer.from(`m-org-${suffix}`)}, ${`test:${suffix}`}, 'development')
        RETURNING id
      `;
      const payerRef = Buffer.from(`m-payer-${suffix}`);
      const [payer] = await tx<{ id: string }[]>`
        INSERT INTO app_user (line_user_ref, identity_scope, line_env)
        VALUES (${payerRef}, ${`test:${suffix}`}, 'development')
        RETURNING id
      `;
      const [event] = await tx<{ id: string }[]>`
        INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                           minors_included, default_amount_minor, provider_key, status)
        VALUES (${organizer!.id}, ${`event-${suffix}`}, '山田太郎', ${Buffer.from(`join-${suffix}`)},
                false, 3000, ${MANUAL_CONFIRM_PROVIDER_KEY}, 'collecting')
        RETURNING id
      `;
      const [participant] = await tx<{ id: string }[]>`
        INSERT INTO participant (event_id, display_label) VALUES (${event!.id}, ${`p-${suffix}`}) RETURNING id
      `;
      await tx`
        INSERT INTO participant_claim (event_id, participant_id, line_user_ref, pepper_version)
        VALUES (${event!.id}, ${participant!.id}, ${payerRef}, 1)
      `;
      const [invoice] = await tx<{ id: string }[]>`
        INSERT INTO invoice (event_id, participant_id, amount_minor) VALUES (${event!.id}, ${participant!.id}, 3000)
        RETURNING id
      `;

      const outcome = await createCheckoutForClaim(tx, {
        appUserId: payer!.id,
        invoiceId: invoice!.id,
        appEnv: PRODUCTION_APP_ENV,
        liffId: "1234567890-abcdefgh",
        requestId: "gb-manual",
      });
      expect(outcome.statusCode).toBe(201);
      expect(outcome.body["autoDetected"]).toBe(false);

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM payment_attempt WHERE invoice_id = ${invoice!.id}
      `;
      expect(rows[0]?.n).toBe("1");
    });
  });
});
