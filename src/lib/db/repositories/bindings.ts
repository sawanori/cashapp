/**
 * `provider_binding` のリポジトリ層（`docs/implementation-plan.md` §7-6 / §9）。
 *
 * ★ **資格情報の値をここで扱わない**。`credential_ref` は外部シークレットストアのキー名で、
 *   復号はアダプタが API 呼び出しの直前に行う（§7-7）。この層が返すのは
 *   `src/lib/payments/types.ts` の `ProviderBinding`（値ではなく参照だけを持つ形）である。
 *
 * ★ **幹事から任意 URL を受け取らない**（§7-6 の `ManualConfirmAdapter`）。受け取るのは
 *   `receiving_identifier`（DB の CHECK で `^[A-Za-z0-9_-]{1,64}$`）だけで、リンクは
 *   `src/lib/payments/providers/manual-confirm.ts` がサーバー側テンプレートから組み立てる。
 *
 * ★ `provider_binding` の作成はレジストリのゲートが止める対象である（§7-6「止めるのは
 *   `createCheckout` と `provider_binding` 作成のみ」）。自動アダプタの binding を作る経路は
 *   `assertProviderBindingAllowed()`（`src/lib/payments/registry.ts`）を必ず通す。
 *   `manual_confirm` は資金移動を起こさないためゲートを見ない。
 */

import "server-only";

import type postgres from "postgres";

import { AppError, type ErrorCode } from "@/lib/errors";
import {
  MANUAL_CONFIRM_PROVIDER_KEY,
  PROVIDER_KEY_RE,
  type ProviderBinding,
  type ProviderBindingStatus,
} from "@/lib/payments/types";

/** 読み書きの口。プールの `Sql` とトランザクションの `TransactionSql` の共通部分。 */
type SqlLike = postgres.ISql;

const CODE_NO_PAYMENT_METHOD = "NO_PAYMENT_METHOD" as ErrorCode;

/** 409。この請求に使える決済手段が 1 つも無い（§9 の `POST /api/e/checkout`）。 */
export function noPaymentMethod(detail?: string): AppError {
  return new AppError(
    CODE_NO_PAYMENT_METHOD,
    409,
    "いまこの会費に使えるお支払い方法がありません。幹事にご連絡ください。",
    detail === undefined ? {} : { detail },
  );
}

interface ProviderBindingDbRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly provider_key: string;
  readonly status: string;
  readonly credential_ref: string | null;
  readonly credential_fp: string | null;
  readonly receiving_identifier: string | null;
  readonly receiving_identifier_kind: string | null;
}

const BINDING_STATUSES: readonly string[] = ["pending", "active", "suspended", "revoked"];
const IDENTIFIER_KINDS: readonly string[] = ["merchant_id", "bank_account_ref", "none"];

function toBinding(row: ProviderBindingDbRow): ProviderBinding {
  // DB 側に CHECK 制約があるので通常は必ず一致する。一致しないなら安全側（未有効）に倒す。
  const status: ProviderBindingStatus = BINDING_STATUSES.includes(row.status)
    ? (row.status as ProviderBindingStatus)
    : "pending";
  const kind =
    row.receiving_identifier_kind !== null && IDENTIFIER_KINDS.includes(row.receiving_identifier_kind)
      ? (row.receiving_identifier_kind as "merchant_id" | "bank_account_ref" | "none")
      : null;
  return {
    id: row.id,
    organizerUserId: row.organizer_user_id,
    providerKey: row.provider_key,
    status,
    credentialRef: row.credential_ref,
    credentialFp: row.credential_fp,
    receivingIdentifier: row.receiving_identifier,
    receivingIdentifierKind: kind,
  };
}

export async function getProviderBindingById(
  sql: SqlLike,
  bindingId: string,
): Promise<ProviderBinding | null> {
  const rows = await sql<ProviderBindingDbRow[]>`
    SELECT id, organizer_user_id, provider_key, status, credential_ref,
           credential_fp, receiving_identifier, receiving_identifier_kind
    FROM provider_binding WHERE id = ${bindingId}
  `;
  const row = rows[0];
  return row === undefined ? null : toBinding(row);
}

export async function getProviderBindingForOrganizer(
  sql: SqlLike,
  organizerUserId: string,
  providerKey: string,
): Promise<ProviderBinding | null> {
  const rows = await sql<ProviderBindingDbRow[]>`
    SELECT id, organizer_user_id, provider_key, status, credential_ref,
           credential_fp, receiving_identifier, receiving_identifier_kind
    FROM provider_binding
    WHERE organizer_user_id = ${organizerUserId} AND provider_key = ${providerKey}
  `;
  const row = rows[0];
  return row === undefined ? null : toBinding(row);
}

/**
 * イベントに紐づいた binding を返す。`event.provider_binding_id` が未設定なら、
 * `event.provider_key` と幹事から引く（イベント作成時点では binding を作らないため。
 * `src/lib/db/repositories/events.ts` の `createEvent`）。
 */
export async function getProviderBindingForEvent(
  sql: SqlLike,
  eventId: string,
): Promise<ProviderBinding | null> {
  const rows = await sql<ProviderBindingDbRow[]>`
    SELECT b.id, b.organizer_user_id, b.provider_key, b.status, b.credential_ref,
           b.credential_fp, b.receiving_identifier, b.receiving_identifier_kind
    FROM event e
    JOIN provider_binding b
      ON b.id = e.provider_binding_id
      OR (e.provider_binding_id IS NULL
          AND b.organizer_user_id = e.organizer_user_id
          AND b.provider_key = e.provider_key)
    WHERE e.id = ${eventId}
    ORDER BY (b.id = e.provider_binding_id) DESC
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : toBinding(row);
}

/**
 * `manual_confirm` の binding を取得し、無ければ作る。
 *
 * `manual_confirm` は外部の資金移動を起こさない（資格情報を持たず、決済も作らない）ため、
 * レジストリのゲート（§7-6）の対象外である。`receivingIdentifier` は任意で、渡された場合も
 * **URL ではなく識別子**として保存する（DB の CHECK が URL を弾く）。
 */
export async function ensureManualConfirmBinding(
  sql: SqlLike,
  organizerUserId: string,
  receiving?: {
    readonly identifier: string;
    readonly kind: "merchant_id" | "bank_account_ref" | "none";
  },
): Promise<ProviderBinding> {
  const identifier = receiving?.identifier ?? null;
  const kind = receiving?.kind ?? null;
  const rows = await sql<ProviderBindingDbRow[]>`
    INSERT INTO provider_binding (organizer_user_id, provider_key, status,
                                  receiving_identifier, receiving_identifier_kind)
    VALUES (${organizerUserId}, ${MANUAL_CONFIRM_PROVIDER_KEY}, 'active',
            ${identifier}, ${kind})
    ON CONFLICT (organizer_user_id, provider_key) DO UPDATE
      SET receiving_identifier = COALESCE(EXCLUDED.receiving_identifier,
                                          provider_binding.receiving_identifier),
          receiving_identifier_kind = COALESCE(EXCLUDED.receiving_identifier_kind,
                                               provider_binding.receiving_identifier_kind)
    RETURNING id, organizer_user_id, provider_key, status, credential_ref,
              credential_fp, receiving_identifier, receiving_identifier_kind
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("provider_binding upsert returned no row");
  return toBinding(row);
}

/** 幹事が停止（`app_user.status='suspended'`）されているか。レジストリのガードが使う。 */
export async function isOrganizerSuspended(
  sql: SqlLike,
  organizerUserId: string,
): Promise<boolean> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM app_user WHERE id = ${organizerUserId}
  `;
  // 行が無い場合も安全側に倒す（存在しない幹事の binding は使わせない）。
  return rows[0]?.status !== "active";
}

/** `provider_key` の書式検査（DB の CHECK と同じ）。 */
export function isValidProviderKey(providerKey: string): boolean {
  return PROVIDER_KEY_RE.test(providerKey);
}
