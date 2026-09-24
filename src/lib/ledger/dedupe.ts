/**
 * 冪等キーの組み立てと書式検査（制約 W1 / W2 / §10-1「二重計上防止は 3 段」）。
 *
 * 3 段の内訳と、それぞれの鍵をここで一元的に作る:
 *   1. `payment_event (provider_key, provider_event_id)` の一意制約 … `providerEventIdOf()`
 *   2. `ledger_entry (invoice_id, dedupe_key)` の一意制約 … `ledgerDedupeKey()`
 *   3. `invoice` 更新の代入的冪等（ランク前進のみ） … `src/lib/ledger/rank.ts`
 *
 * ★ `business_idem_key`（W2）は **UNIQUE にしない**。同一 charge への 2 回目の部分返金が
 *   同じキーを生み、正当なイベントが DB 制約で黙って落ちるため（§10-1）。観測用に持つ。
 *
 * ★ 事業者がイベント ID を持たない場合は `'sha256:' + sha256(rawBody)` を使う
 *   （`payment_event.provider_event_id` は NOT NULL）。
 */

import type { NormalizedEvent, PaymentEventKind } from "@/lib/payments/types";

/** `payment_attempt.external_ref` の DB CHECK と同じ書式。 */
export const EXTERNAL_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** URL パスに置かれる `bindingRef`（= `provider_binding.id` の UUID）の書式。 */
export const BINDING_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `provider_key` の DB CHECK と同じ書式。 */
export const PROVIDER_KEY_PATH_RE = /^[a-z0-9_]{1,32}$/;

export function isValidExternalRef(value: string): boolean {
  return EXTERNAL_REF_RE.test(value);
}

export function isValidBindingRef(value: string): boolean {
  return BINDING_REF_RE.test(value.toLowerCase());
}

export function isValidProviderKeyPath(value: string): boolean {
  return PROVIDER_KEY_PATH_RE.test(value);
}

/** 生本文の SHA-256（hex）。`webhook_delivery.body_sha256` の CHECK と同じ 64 桁 hex。 */
export async function bodySha256(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 事業者がイベント ID を持たないときの代替 ID。
 * アダプタが `providerEventId` を埋めていればそれを使う（W1 の一意制約はこの値に掛かる）。
 */
export async function providerEventIdOf(
  event: Pick<NormalizedEvent, "providerEventId">,
  rawBody: string,
): Promise<string> {
  const declared = event.providerEventId.trim();
  if (declared.length > 0) return declared;
  return `sha256:${await bodySha256(rawBody)}`;
}

/**
 * 台帳の二重計上を防ぐ唯一の鍵（W2）。アダプタが `ledgerDedupeKey` を宣言していれば
 * それを尊重し、無ければ `<providerKey>:<kind>:<providerEventId>` を組み立てる。
 *
 * 種別を鍵に含めるのは、同じ決済に対する `succeeded` と `refunded` が**別の台帳行**
 * でなければならないためである。
 */
export function ledgerDedupeKey(input: {
  readonly providerKey: string;
  readonly kind: PaymentEventKind;
  readonly providerEventId: string;
  readonly declared?: string | undefined;
}): string {
  const declared = input.declared?.trim() ?? "";
  if (declared.length > 0) return declared;
  return `${input.providerKey}:${input.kind}:${input.providerEventId}`;
}

/**
 * 業務レベルの観測キー（W2）。`<externalRef>:<kind>`。
 * 一意制約は張らない（同じ組が正当に 2 回現れうる）。
 */
export function businessIdemKey(input: {
  readonly externalRef: string;
  readonly kind: PaymentEventKind;
  readonly declared?: string | undefined;
}): string {
  const declared = input.declared?.trim() ?? "";
  if (declared.length > 0) return declared;
  return `${input.externalRef}:${input.kind}`;
}
