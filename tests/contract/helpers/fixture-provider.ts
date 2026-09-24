/**
 * `fixture_provider` — **テスト専用**の決済アダプタ（task_018 scope）。
 *
 * ★ Phase 1 の出荷アダプタは `manual_confirm` だけで、外部 Webhook を一切持たない。
 *   そのため重複・順序逆転・署名不一致の契約（W1 / W2 / W3 / W8 / W12）は、
 *   出荷しないアダプタを**テストの中だけ**に置いて検査する。
 *
 * ★ このアダプタは `src/lib/payments/registry.ts` の `REGISTRY` に**登録しない**。
 *   登録すると実行時に解決可能になってしまう。Webhook ルートには
 *   `WebhookContext.resolveAdapter` で注入する（その差し替え口がある唯一の理由）。
 *
 * ★ fixture は `tests/fixtures/fixture_provider/*.json` に置き、すべて
 *   `captured_from: "synthesized"` を明記する（G12。出所不明の fixture を作らない）。
 *
 * ★ 署名は本文の生バイト列に対する HMAC-SHA256（hex）。**複数シークレットを順に試す**
 *   （W12: ローテーション中は旧シークレットも 24 時間併存する）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type postgres from "postgres";

import type { WebhookContext } from "@/app/api/webhooks/[providerKey]/[bindingRef]/route";
import { yen } from "@/lib/payments/money";
import {
  NotSupportedError,
  SignatureError,
  type CheckoutTicket,
  type NormalizedEvent,
  type PaymentEventKind,
  type PaymentProvider,
  type PaymentSnapshot,
  type ProviderCapabilities,
} from "@/lib/payments/types";

export const FIXTURE_PROVIDER_KEY = "fixture_provider";

/** 署名ヘッダ名。事業者ごとに異なるので、アダプタが自分で知っている。 */
export const FIXTURE_SIGNATURE_HEADER = "x-fixture-signature";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  FIXTURE_PROVIDER_KEY,
);

export type FixtureName =
  | "succeeded"
  | "expired"
  | "tampered"
  | "amount-mismatch"
  | "disputed";

interface FixtureBody {
  readonly event_id: string;
  readonly type: string;
  readonly kind: string;
  external_ref: string;
  amount_minor: number | null;
  readonly currency: string | null;
  readonly occurred_at: string | null;
  [key: string]: unknown;
}

export interface FixtureOverrides {
  readonly externalRef?: string;
  readonly amountMinor?: number | null;
  readonly eventId?: string;
  /**
   * 台帳の dedupe_key を明示する。**W1（`provider_event_id` の一意制約）をすり抜けた
   * 事実が W2（`ledger_entry` の一意制約）で止まること**を検査するために、
   * イベント ID だけを変えて dedupe_key を固定できるようにしてある。
   */
  readonly ledgerDedupeKey?: string;
}

/**
 * fixture を読み、テストごとに動く値（`external_ref` など）だけを差し替えて
 * **生本文の文字列**にして返す。署名は必ずこの文字列に対して計算する。
 *
 * ★ `event_id` には必ず `external_ref` を連結してシナリオごとに一意にする。
 *   `payment_event (provider_key, provider_event_id)` は UNIQUE なので、fixture に
 *   書いた固定 ID をそのまま使うと、**並列に走る別のテストトランザクションが同じキーの
 *   INSERT で待たされる**。待ちが監査連鎖のグローバル advisory lock の待ちと循環すると
 *   `deadlock detected` になる（本セッションで実測。task_019 も同じ現象を記録している）。
 *   同一テスト内では同じ `external_ref` を使うので、重複配信の検査（同じ ID が 2 回届く）は
 *   そのまま成立する。
 */
export function loadFixtureBody(name: FixtureName, overrides: FixtureOverrides = {}): string {
  const raw = readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8");
  const parsed = JSON.parse(raw) as FixtureBody;
  const body: Record<string, unknown> = { ...parsed };
  if (overrides.externalRef !== undefined) body["external_ref"] = overrides.externalRef;
  if (overrides.amountMinor !== undefined) body["amount_minor"] = overrides.amountMinor;
  const eventIdBase = overrides.eventId ?? parsed.event_id;
  body["event_id"] = `${eventIdBase}:${String(body["external_ref"])}`;
  if (overrides.ledgerDedupeKey !== undefined) {
    body["ledger_dedupe_key"] = overrides.ledgerDedupeKey;
  }
  return JSON.stringify(body);
}

/** 生本文に対する HMAC-SHA256（hex）。 */
export async function signFixtureBody(raw: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 定数時間比較（長さが違えば即 false）。 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const KINDS: readonly PaymentEventKind[] = [
  "authorized",
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "refunded",
  "refund_pending",
  "refund_failed",
  "disputed",
  "dispute_resolved",
  "unknown",
];

function toKind(value: unknown): PaymentEventKind {
  return typeof value === "string" && KINDS.includes(value as PaymentEventKind)
    ? (value as PaymentEventKind)
    : "unknown";
}

/**
 * 能力宣言。`autoDetect: true` はテスト専用アダプタとしての宣言であり、
 * `REGISTRY` に載せないので実行時ゲート（G12 の「synthesized のみは autoDetect 不可」）
 * の対象にならない。
 */
const CAPABILITIES: ProviderCapabilities = {
  autoDetect: true,
  webhook: true,
  webhookSignature: "hmac",
  statusQuery: false,
  refund: "none",
  refundWindowDays: null,
  dispute: "webhook",
  disputeResponseWindowDays: null,
  checkoutIdempotent: true,
  credentialCustody: "organizer",
  settlementQuery: false,
  feeModel: {
    kind: "undetermined",
    note: "テスト専用のため手数料は宣言しない",
    rateBp: null,
    fixedMinor: null,
    undetermined: true,
  },
  settlementSchedule: "テスト専用のため入金サイクルは宣言しない",
  payerIdentity: false,
  settlementLagHint: "テスト専用",
};

export const fixtureProvider: PaymentProvider = {
  key: FIXTURE_PROVIDER_KEY,
  capabilities: CAPABILITIES,

  createCheckout(): Promise<CheckoutTicket> {
    return Promise.reject(new NotSupportedError("createCheckout(fixture_provider)"));
  },

  /**
   * 生本文をそのまま受け取り、**複数シークレットを順に試して**署名を検証する（W12）。
   * どれとも一致しなければ `SignatureError`。検証を通ってから初めて本文を構造化する（P2）。
   */
  async parseWebhook(
    _binding,
    raw: string,
    headers: Headers,
    secrets: readonly string[],
  ): Promise<readonly NormalizedEvent[]> {
    const presented = headers.get(FIXTURE_SIGNATURE_HEADER);
    if (presented === null || secrets.length === 0) {
      throw new SignatureError("missing signature header or no secrets configured");
    }
    let ok = false;
    for (const secret of secrets) {
      if (timingSafeEqualHex(presented, await signFixtureBody(raw, secret))) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new SignatureError("no configured secret verifies this body");

    const body = JSON.parse(raw) as FixtureBody;
    const kind = toKind(body.kind);
    const amount = body.amount_minor;
    const occurredAt =
      typeof body.occurred_at === "string" ? new Date(body.occurred_at) : null;
    return [
      {
        providerKey: FIXTURE_PROVIDER_KEY,
        providerEventId: body.event_id,
        eventType: body.type,
        kind,
        externalRef: body.external_ref,
        businessIdemKey: `${body.external_ref}:${kind}`,
        ledgerDedupeKey:
          typeof body["ledger_dedupe_key"] === "string"
            ? body["ledger_dedupe_key"]
            : `${FIXTURE_PROVIDER_KEY}:${kind}:${body.event_id}`,
        money: typeof amount === "number" && amount > 0 ? yen(amount) : null,
        occurredAt,
        trust: "verified",
        raw: null,
      },
    ];
  },

  getPaymentStatus(): Promise<PaymentSnapshot> {
    return Promise.reject(new NotSupportedError("getPaymentStatus(fixture_provider)"));
  },

  refund(): Promise<NormalizedEvent> {
    return Promise.reject(new NotSupportedError("refund(fixture_provider)"));
  },

  cancelCheckout(): Promise<void> {
    return Promise.resolve();
  },
};

// ============================================================================
// 契約テストの土台（フィクスチャ投入・リクエスト組み立て・WebhookContext）
// ============================================================================

/** 許可リストに載せる送信元（テスト用の RFC 5737 文書用アドレス）。 */
export const CONTRACT_ALLOWED_IP = "203.0.113.10";
export const CONTRACT_IP_ALLOWLIST = "203.0.113.0/24";
/** 許可リスト外の送信元。 */
export const CONTRACT_BLOCKED_IP = "198.51.100.9";

/**
 * 署名シークレット。**2 本ある**のが要点で、旧シークレットで署名された本文も
 * 通ることを契約として固定する（W12）。値はテスト専用のリテラルで、秘密ではない。
 */
export const CONTRACT_SECRET_CURRENT = "fixture-secret-current-0123456789abcdef";
export const CONTRACT_SECRET_PREVIOUS = "fixture-secret-previous-0123456789abcd";
export const CONTRACT_SECRETS: readonly string[] = [
  CONTRACT_SECRET_CURRENT,
  CONTRACT_SECRET_PREVIOUS,
];

/** `source_ip_hash` の HMAC 鍵。テスト専用。 */
export const CONTRACT_IP_HASH_KEY = "fixture-ip-hash-key-0123456789abcdef0123";

export interface ContractScenario {
  readonly userId: string;
  readonly bindingId: string;
  readonly eventId: string;
  readonly participantId: string;
  readonly invoiceId: string;
  readonly attemptId: string;
  readonly externalRef: string;
}

export interface ScenarioOptions {
  readonly invoiceAmountMinor?: number;
  /** 突合の基準額。既定は `invoiceAmountMinor` と同じ。 */
  readonly attemptAmountMinor?: number;
  readonly voidInvoice?: boolean;
  /** 試行を作らない（orphan の検査用）。 */
  readonly withoutAttempt?: boolean;
}

/**
 * 幹事 → `fixture_provider` の binding → イベント → 参加者 → 請求 → 試行を作る。
 * `event.provider_key` は binding と一致させる（0007 の複合 FK）。
 */
export async function insertFixtureScenario(
  tx: postgres.TransactionSql,
  suffixInput: string,
  options: ScenarioOptions = {},
): Promise<ContractScenario> {
  const invoiceAmount = options.invoiceAmountMinor ?? 3000;
  const attemptAmount = options.attemptAmountMinor ?? invoiceAmount;
  // 一意キー（app_user の identity_scope / event.join_token_hash）が、並列に走る別プロセスの
  // 同名シナリオと衝突して待ちを作らないよう、呼び出しごとに乱数を足す。
  const suffix = `${suffixInput}-${crypto.randomUUID().slice(0, 8)}`;

  const userRows = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`ct-${suffix}`)}, ${`contract:${suffix.slice(0, 60)}`}, 'development')
    RETURNING id
  `;
  const userId = requireId(userRows);

  const bindingRows = await tx<{ id: string }[]>`
    INSERT INTO provider_binding (organizer_user_id, provider_key, status, capabilities)
    VALUES (${userId}, ${FIXTURE_PROVIDER_KEY}, 'active', '{}'::jsonb)
    RETURNING id
  `;
  const bindingId = requireId(bindingRows);

  const eventRows = await tx<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       minors_included, provider_key, provider_binding_id)
    VALUES (${userId}, ${`ev-${suffix}`}, 'organizer', ${Buffer.from(`jt-${suffix}`)},
            false, ${FIXTURE_PROVIDER_KEY}, ${bindingId})
    RETURNING id
  `;
  const eventId = requireId(eventRows);

  const participantRows = await tx<{ id: string }[]>`
    INSERT INTO participant (event_id, display_label)
    VALUES (${eventId}, ${`p-${suffix}`})
    RETURNING id
  `;
  const participantId = requireId(participantRows);

  const invoiceRows = await tx<{ id: string }[]>`
    INSERT INTO invoice (event_id, participant_id, amount_minor, lifecycle_state, voided_at)
    VALUES (${eventId}, ${participantId}, ${invoiceAmount},
            ${options.voidInvoice === true ? "void" : "active"},
            ${options.voidInvoice === true ? new Date() : null})
    RETURNING id
  `;
  const invoiceId = requireId(invoiceRows);

  const externalRef = `iv_${invoiceId.replace(/-/g, "")}_1`;
  let attemptId = "";
  if (options.withoutAttempt !== true) {
    const attemptRows = await tx<{ id: string }[]>`
      INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id, external_ref,
                                   amount_minor, status)
      VALUES (${invoiceId}, ${FIXTURE_PROVIDER_KEY}, ${bindingId}, ${externalRef},
              ${attemptAmount}, 'redirected')
      RETURNING id
    `;
    attemptId = requireId(attemptRows);
  }

  return { userId, bindingId, eventId, participantId, invoiceId, attemptId, externalRef };
}

function requireId(rows: readonly { readonly id: string }[]): string {
  const row = rows[0];
  if (row === undefined) throw new Error("fixture insert returned no row");
  return row.id;
}

export interface SignedRequestOptions {
  readonly ip?: string;
  /** 署名に使うシークレット。既定は現行。旧シークレットを渡すと W12 の検査になる。 */
  readonly secret?: string;
  /** 署名を計算したあとに本文を差し替える（署名不一致の検査）。 */
  readonly bodyOverride?: string;
  readonly bindingRef: string;
}

/** 署名済みの `Request` を組み立てる。署名は**送る本文**ではなく `raw` に対して計算する。 */
export async function buildSignedRequest(
  raw: string,
  options: SignedRequestOptions,
): Promise<Request> {
  const signature = await signFixtureBody(raw, options.secret ?? CONTRACT_SECRET_CURRENT);
  return new Request(
    `https://example.test/api/webhooks/${FIXTURE_PROVIDER_KEY}/${options.bindingRef}`,
    {
      method: "POST",
      body: options.bodyOverride ?? raw,
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": options.ip ?? CONTRACT_ALLOWED_IP,
        [FIXTURE_SIGNATURE_HEADER]: signature,
      },
    },
  );
}

export interface ContractContextOptions {
  readonly appEnv?: string;
  readonly ipAllowlistSpec?: string;
  readonly secrets?: readonly string[];
  /** 台帳適用のゲート。未指定は「通過」。文字列を返すと保留になる。 */
  readonly holdReason?: string | null;
  readonly now?: Date;
}

/**
 * ルート本体へ渡す文脈。トランザクションは**外側のロールバック用トランザクションの
 * セーブポイント**にする。`ledger_entry` / `audit_log` は追記専用で DELETE できないため、
 * コミットしてしまうと実 DB に永久に残る。
 */
export async function makeContractContext(
  tx: postgres.TransactionSql,
  options: ContractContextOptions = {},
): Promise<WebhookContext> {
  const { parseIpAllowlist } = await import("@/lib/webhook/ip-allowlist");
  const holdReason = options.holdReason ?? null;
  return {
    sql: tx,
    runTransaction: (fn) => tx.savepoint(fn),
    appEnv: options.appEnv ?? "production",
    ipAllowlist: parseIpAllowlist(options.ipAllowlistSpec ?? CONTRACT_IP_ALLOWLIST),
    ipHashKey: CONTRACT_IP_HASH_KEY,
    secrets: options.secrets ?? CONTRACT_SECRETS,
    resolveAdapter: () => fixtureProvider,
    applyGate: () => Promise.resolve(holdReason),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}
