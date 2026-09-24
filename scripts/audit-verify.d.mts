// 型宣言: tests/** から scripts/audit-verify.mjs の純関数だけを import するため
// （tsconfig は allowJs=false。CLI 本体は npm run audit:verify として spawn して検証する）。
// scripts/record-evidence.d.mts と同じ方針。

export interface AuditRowHashInput {
  prevHash: Uint8Array | null;
  occurredAt: Date;
  actorType: string;
  actorRef: Uint8Array | null;
  action: string;
  targetType: string;
  targetId: string;
  beforeRank: number | null;
  afterRank: number | null;
  amountMinor: number | null;
  providerKey: string | null;
  externalRef: string | null;
  requestId: string;
  sourceIpHash: Uint8Array | null;
  detail: Record<string, unknown>;
}

export interface AuditChainRowLike {
  id: string | number;
  occurred_at: Date;
  actor_type: string;
  actor_ref: Uint8Array | null;
  action: string;
  target_type: string;
  target_id: string;
  before_rank: number | null;
  after_rank: number | null;
  amount_minor: number | null;
  provider_key: string | null;
  external_ref: string | null;
  request_id: string;
  source_ip_hash: Uint8Array | null;
  detail: Record<string, unknown>;
  prev_hash: Uint8Array | null;
  row_hash: Uint8Array;
}

export interface AuditChainResult {
  ok: boolean;
  rowsChecked: number;
  brokenAtId: string | null;
  reason: string | null;
}

export function sortKeysDeep(value: unknown): unknown;
export function computeRowHash(input: AuditRowHashInput): Buffer;
export function verifyChain(rows: readonly AuditChainRowLike[]): AuditChainResult;
export function resolveConnectionString(
  env?: Record<string, string | undefined>,
  argUrl?: string | null,
): string;
