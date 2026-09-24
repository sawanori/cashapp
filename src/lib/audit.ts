/**
 * 監査ログの追記とハッシュ連鎖（§9 / §10-1 / check_057 / task_014 scope）。
 *
 * ★ `audit_log` は追記専用（`GRANT SELECT, INSERT` のみ・トリガで UPDATE/DELETE 例外。
 *   `supabase/migrations/0001_init.sql`）。行の意味を変えることは物理的にできない。
 *
 * ★ 連鎖は `id` 順で確定する。`prev_hash` は「直前の行の `row_hash`」であり、
 *   `row_hash` は「`prev_hash` を含む行の内容全体」の SHA-256 である。1 行でも改変されれば
 *   以降のどこかで `prev_hash` / `row_hash` の再計算が食い違う。
 *
 * ★ 直列化は `pg_advisory_xact_lock`（**ブロッキング**版。トランザクションスコープ）で行う。
 *   `pg_try_advisory_xact_lock`（`src/lib/db/client.ts` の `tryAdvisoryXactLock`）は
 *   「取れなければ諦める」用途向けで、監査行の追記のような「待ってでも直列に書く」操作には
 *   使わない。ロックはトランザクション終了で自動解放されるため、接続プーラを挟んでも残留しない
 *   （`src/lib/db/client.ts` の advisory lock 規約と同じ理由）。
 *
 * ★ 呼び出し側は**既にトランザクション（`tx`）の中にいること**。監査行の追記と、
 *   それが記録する業務上の変更（例: `event` の INSERT）は同一トランザクションでなければ、
 *   片方だけがコミットされる不整合を起こしうる。
 *
 * ★ `errors.ts` は task_014 の `files_to_modify` に含まれないため、本モジュールは
 *   独自の例外を持たない（呼び出し側の例外をそのまま伝播させる）。
 *
 * ★ `audit_log.id` は `bigint`（Postgres `int8`）だが、`id` を型として返す関数はここでは
 *   **常に `string`** を返す。postgres.js は既定で int8 を精度欠落のない文字列としてデコードし
 *   （`node_modules/postgres/src/types.js` の `types.number.from` に OID 20 が含まれない）、
 *   JS の `bigint` へは自動変換しない。ここで型を `bigint` と宣言すると実行時の値と食い違う
 *   （`tests/integration/audit-chain.test.ts` で実測: `"38" > "39"` の文字列比較が誤って
 *   false を返すのと同種の不一致）。`id` は比較・ソートに使わず不透明な識別子として扱うため、
 *   `string` のままで足りる。
 *
 * ★ `detail`（jsonb）のキー順は Postgres の JSONB 格納で正規化され、**挿入時に渡したオブジェクト
 *   のキー順とは一致しない**（実測: `{"foo":"bar","n":1}` で INSERT した行を SELECT すると
 *   `{"n":1,"foo":"bar"}` で返る）。`computeRowHash` はこの `detail` を JSON 文字列化してハッシュに
 *   含めるため、キー順をそろえずに `JSON.stringify` すると、**挿入直後に計算したハッシュと、
 *   同じ行を読み直して再計算したハッシュが、内容を一切改変していなくても不一致になる**
 *   （`detail` に 2 キー以上あると `tests/integration/audit-chain.test.ts` の
 *   「並行 20 本の追記」で 100% 再現した）。`detail` は `sortKeysDeep` で正準化してから
 *   ハッシュに含める（`src/lib/idempotency.ts` の `computeRequestHash` と同じ考え方）。
 */

import "server-only";

import type postgres from "postgres";

import { AUDIT_CHAIN_LOCK_KEY } from "@/lib/db/client";

export type AuditActorType = "organizer" | "participant" | "system" | "webhook" | "admin";

export interface AppendAuditInput {
  readonly actorType: AuditActorType;
  /** `line_user_ref` か管理者 ID の bytea。生の userId は入れない（audit_log.actor_ref）。 */
  readonly actorRef?: Buffer | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly beforeRank?: number | null;
  readonly afterRank?: number | null;
  readonly amountMinor?: number | null;
  readonly providerKey?: string | null;
  readonly externalRef?: string | null;
  readonly requestId: string;
  readonly sourceIpHash?: Buffer | null;
  readonly detail?: Record<string, unknown>;
  /** テスト専用。既定は `new Date()`。 */
  readonly now?: Date;
}

export interface AppendedAuditRow {
  /** `audit_log.id`（bigint）。postgres.js の既定デコードに合わせ string で表す（上の docstring）。 */
  readonly id: string;
  readonly rowHash: Buffer;
  readonly prevHash: Buffer | null;
}

function bufferHex(value: Buffer | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return Buffer.from(value).toString("hex");
}

/**
 * `detail`（jsonb）のキーを再帰的にソートする。Postgres の JSONB 格納はキー順を保持しない
 * ため、挿入時に渡したオブジェクトそのままを `JSON.stringify` すると、読み直して再計算した
 * ハッシュと食い違う（上の docstring）。`src/lib/idempotency.ts` の `sortKeysDeep` と同じ方針。
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(record).sort()) {
      sorted[k] = sortKeysDeep(record[k]);
    }
    return sorted;
  }
  return value;
}

interface RowHashInput {
  readonly prevHash: Buffer | null;
  readonly occurredAt: Date;
  readonly actorType: AuditActorType;
  readonly actorRef: Buffer | null | undefined;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly beforeRank: number | null | undefined;
  readonly afterRank: number | null | undefined;
  readonly amountMinor: number | null | undefined;
  readonly providerKey: string | null | undefined;
  readonly externalRef: string | null | undefined;
  readonly requestId: string;
  readonly sourceIpHash: Buffer | null | undefined;
  readonly detail: Record<string, unknown>;
}

/**
 * 行内容全体（`prev_hash` を含む）の SHA-256。キー順に依存しない正準表現から計算する。
 *
 * ★ トップレベルのフィールドはこの関数の中で常に同じソースコード上の並びで書かれるため
 *   `JSON.stringify` の出力順は実行のたびに変わらないが（V8 は ES2015 以降、文字列キーの
 *   列挙順を挿入順と規定している）、**将来別のオブジェクト構築経路が増えたときに同じ前提が
 *   壊れても気づけない**という指摘（敵対レビュー gemini F-1）を受け、`detail` だけでなく
 *   オブジェクト全体を `sortKeysDeep` に通してから `JSON.stringify` する。エンジン間の
 *   列挙順の違いにも構造的に依存しなくなる。
 */
async function computeRowHash(input: RowHashInput): Promise<Buffer> {
  const canonical = JSON.stringify(sortKeysDeep({
    prevHash: bufferHex(input.prevHash),
    occurredAt: input.occurredAt.toISOString(),
    actorType: input.actorType,
    actorRef: bufferHex(input.actorRef),
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    beforeRank: input.beforeRank ?? null,
    afterRank: input.afterRank ?? null,
    amountMinor: input.amountMinor ?? null,
    providerKey: input.providerKey ?? null,
    externalRef: input.externalRef ?? null,
    requestId: input.requestId,
    sourceIpHash: bufferHex(input.sourceIpHash),
    detail: input.detail,
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Buffer.from(digest);
}

/**
 * 監査行を 1 件追記する。
 *
 * 手順: ① ブロッキング advisory xact lock で直列化 → ② 直近行の `row_hash` を読む
 * （無ければ `null` = 先頭行）→ ③ `row_hash` を計算 → ④ INSERT。
 * ①〜④ は同一トランザクション内で行われるため、ロックはコミット/ロールバックまで保持される。
 */
export async function appendAuditLog(
  tx: postgres.TransactionSql,
  input: AppendAuditInput,
): Promise<AppendedAuditRow> {
  await tx`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY.toString()}::bigint)`;

  const prevRows = await tx<{ row_hash: Buffer }[]>`
    SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1
  `;
  const prevHash = prevRows[0]?.row_hash ?? null;
  const occurredAt = input.now ?? new Date();
  const detail = input.detail ?? {};

  const rowHash = await computeRowHash({
    prevHash,
    occurredAt,
    actorType: input.actorType,
    actorRef: input.actorRef,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    beforeRank: input.beforeRank,
    afterRank: input.afterRank,
    amountMinor: input.amountMinor,
    providerKey: input.providerKey,
    externalRef: input.externalRef,
    requestId: input.requestId,
    sourceIpHash: input.sourceIpHash,
    detail,
  });

  const jsonSafeDetail = JSON.parse(JSON.stringify(detail)) as postgres.JSONValue;

  const inserted = await tx<{ id: string; row_hash: Buffer; prev_hash: Buffer | null }[]>`
    INSERT INTO audit_log (
      occurred_at, actor_type, actor_ref, action, target_type, target_id,
      before_rank, after_rank, amount_minor, provider_key, external_ref,
      request_id, source_ip_hash, detail, prev_hash, row_hash
    ) VALUES (
      ${occurredAt}, ${input.actorType}, ${input.actorRef ?? null}, ${input.action},
      ${input.targetType}, ${input.targetId},
      ${input.beforeRank ?? null}, ${input.afterRank ?? null}, ${input.amountMinor ?? null},
      ${input.providerKey ?? null}, ${input.externalRef ?? null},
      ${input.requestId}, ${input.sourceIpHash ?? null}, ${tx.json(jsonSafeDetail)},
      ${prevHash}, ${rowHash}
    )
    RETURNING id, row_hash, prev_hash
  `;
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("audit_log insert returned no row");
  }
  return { id: row.id, rowHash: row.row_hash, prevHash: row.prev_hash };
}

export interface AuditChainVerifyResult {
  readonly ok: boolean;
  readonly rowsChecked: number;
  /** 連鎖が壊れていた最初の行の id。壊れていなければ `null`。 */
  readonly brokenAtId: string | null;
  readonly reason?: string;
}

interface AuditChainRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly actor_type: AuditActorType;
  readonly actor_ref: Buffer | null;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly before_rank: number | null;
  readonly after_rank: number | null;
  readonly amount_minor: number | null;
  readonly provider_key: string | null;
  readonly external_ref: string | null;
  readonly request_id: string;
  readonly source_ip_hash: Buffer | null;
  readonly detail: Record<string, unknown>;
  readonly prev_hash: Buffer | null;
  readonly row_hash: Buffer;
}

/**
 * 監査連鎖の先頭から末尾までを再計算し、`prev_hash` / `row_hash` が保存値と一致することを
 * 確かめる。`limit` は走査上限（既定 10000）。
 *
 * ★ 正式な `npm run audit:verify`（CLI・cron・required check への登録）は task_018/020 の担当。
 *   本関数はその下敷きとなる検証ロジックであり、`tests/integration/audit-chain.test.ts` が
 *   直接呼び出して使う。
 */
export async function verifyAuditChain(
  sql: postgres.Sql,
  options: { readonly limit?: number } = {},
): Promise<AuditChainVerifyResult> {
  const limit = options.limit ?? 10_000;
  const rows = await sql<AuditChainRow[]>`
    SELECT id, occurred_at, actor_type, actor_ref, action, target_type, target_id,
           before_rank, after_rank, amount_minor, provider_key, external_ref,
           request_id, source_ip_hash, detail, prev_hash, row_hash
    FROM audit_log
    ORDER BY id ASC
    LIMIT ${limit}
  `;

  let expectedPrevHash: Buffer | null = null;
  for (const row of rows) {
    if (!buffersEqual(row.prev_hash, expectedPrevHash)) {
      return {
        ok: false,
        rowsChecked: rows.length,
        brokenAtId: row.id,
        reason: "prev_hash does not match the previous row's row_hash",
      };
    }
    const recomputed = await computeRowHash({
      prevHash: row.prev_hash,
      occurredAt: row.occurred_at,
      actorType: row.actor_type,
      actorRef: row.actor_ref,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      beforeRank: row.before_rank,
      afterRank: row.after_rank,
      amountMinor: row.amount_minor,
      providerKey: row.provider_key,
      externalRef: row.external_ref,
      requestId: row.request_id,
      sourceIpHash: row.source_ip_hash,
      detail: row.detail,
    });
    if (!buffersEqual(recomputed, row.row_hash)) {
      return {
        ok: false,
        rowsChecked: rows.length,
        brokenAtId: row.id,
        reason: "row_hash does not match the recomputed hash of the row content",
      };
    }
    expectedPrevHash = row.row_hash;
  }

  return { ok: true, rowsChecked: rows.length, brokenAtId: null };
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return Buffer.from(a).equals(Buffer.from(b));
}
