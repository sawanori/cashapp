/**
 * 再照合ジョブ（§9「再照合ジョブ」/ W9 / W10 / W11 / R-OPS-08 / R-PAY-07 / R-PAY-09）。
 *
 * ★ **時刻カーソルを持たない**（W9）。走査条件は「状態」だけで書く。1 回飛んでも次回の
 *   実行が同じ行を拾う。前回実行時刻を保存した瞬間に「飛んだら取りこぼす」設計へ退行する。
 *
 * ★ 多重起動防止は `pg_try_advisory_xact_lock`（W11 / R-OPS-08）。**トランザクション
 *   スコープ**なので、プロセスが途中で kill されてもロックは残らない。セッションスコープの
 *   `pg_advisory_lock` は Hyperdrive / Supavisor を挟むと「取った接続」と「解放する接続」が
 *   食い違って残留する。`unlock` を書く経路をこのモジュールは一切持たない。
 *
 * ★ 走査 1（未決済）: `settlement_rank < 40 AND lifecycle_state='active'` かつ
 *   試行が生きている（`is_open`）か、**期限切れから 4 日以内**（W10: Stripe の再送が最長 3 日 ＋ 余裕）。
 *   `ORDER BY invoice.updated_at ASC LIMIT 100`。上限に達したら `reconciliation_run.truncated`
 *   と `note='truncated'` を残す（取りこぼしではなく「続きは次回」）。
 *   ★ バッチの最後に**拾った行を必ず触る**（`touchScanned`）。触らないと、状態が変わらない
 *   再照会では `updated_at` が動かず、先頭 100 件だけが 5 分ごとに再照会されて 101 件目
 *   以降が二度と照会されない（順序キーの凍結。GPT 敵対レビュー F-3）。
 *
 * ★ 走査 2（支払済みの再照会・R-PAY-07）: `settlement_rank >= 40 AND paid_at > now() - 30 日` を
 *   **日次 1 回**だけ再照会し、事業者側での返金・紛争を反映する。「日次 1 回」の判定は
 *   `reconciliation_run` に直近 24 時間の paid 再照会があるかで行う（走査 1 の取りこぼしとは
 *   無関係。再照会は毎回 30 日窓を丸ごと見るため、飛んでも次回で拾える）。
 *   並び順は走査 1 と同じ `updated_at ASC`＋触り戻しで巡回させる（`paid_at ASC` は固定値なので
 *   先頭 100 件から進まない。F-4）。適用するのは `POST_PAID_KINDS` だけで、再照会で返る
 *   `succeeded` は Webhook で計上済みの入金と二重になるため捨てる（F-1）。
 *
 * ★ 1 件あたり 3 秒 timeout・並列 5。外部 API が遅いときに Worker の実行時間上限
 *   （Cron Triggers: 15 分 / CPU 30 秒。docs/vendor-docs/cloudflare/cron-triggers.md）へ
 *   当たらないようにする。
 *
 * ★ 事業者への照会は `PaymentProvider.getPaymentStatus`。`capabilities.statusQuery === false`
 *   のアダプタ（Phase 1 の `manual_confirm`）は走査対象から外す。照会結果は
 *   `payment_event`（`ingestion_source='poll'` / `trust='reverified'`）として保存してから
 *   `applyToLedger` に渡す。保存で重複（W1）になれば台帳には触れない。
 */

import "server-only";

import type postgres from "postgres";

import { insertPaymentEvent, redactRawPayload } from "@/lib/db/repositories/events-log";
import { applyToLedger } from "@/lib/ledger/apply";
import { businessIdemKey, ledgerDedupeKey } from "@/lib/ledger/dedupe";
import { rankOf, SETTLEMENT_STATUSES } from "@/lib/ledger/rank";
import type {
  NormalizedEvent,
  PaymentEventKind,
  PaymentSnapshot,
  ProviderBinding,
} from "@/lib/payments/types";

/** 再照合の多重起動防止に使う advisory lock キー（`AUDIT_CHAIN_LOCK_KEY` と衝突しない値）。 */
export const RECONCILE_LOCK_KEY = 8_314_002n;

/** 1 回の走査で見る上限（§9）。 */
export const RECONCILE_BATCH_LIMIT = 100;

/** 1 件あたりの事業者照会の timeout（§9）。 */
export const RECONCILE_QUERY_TIMEOUT_MS = 3_000;

/** 事業者照会の並列数（§9）。 */
export const RECONCILE_CONCURRENCY = 5;

/** 期限切れ試行を走査対象に残す猶予（W10: 最低 4 日）。 */
export const EXPIRED_GRACE_DAYS = 4;

/** 支払済みの再照会窓（§9 走査 2）。 */
export const PAID_RESCAN_DAYS = 30;

/** 走査 2 を回す間隔（日次 1 回）。 */
export const PAID_RESCAN_INTERVAL_HOURS = 24;

/** 「支払済み」とみなすランクの下限（`invoice_recon_idx` の部分索引の述語と同じ値）。 */
const PAID_RANK = 40;

/**
 * 走査 1 が見る `settlement_status` の集合（ランク 40 未満）。`rank.ts` から導出するので、
 * 状態を足しても取りこぼさない。等値集合で書くのは `invoice_recon_idx`
 * （`(settlement_status, updated_at) WHERE settlement_rank < 40 AND lifecycle_state='active'`）
 * の先頭列を等値で固定しないと索引の順序が使えないためである。
 */
export const OPEN_SETTLEMENT_STATUSES: readonly string[] = SETTLEMENT_STATUSES.filter(
  (status) => rankOf(status) < PAID_RANK,
);

/**
 * 走査 2 で**適用してよい**種別（R-PAY-07 / GPT 敵対レビュー F-1）。
 *
 * 走査 2 の目的は「支払済みになった後の変化（返金・紛争）を拾う」ことだけである。
 * すでに入金済みの請求に対して事業者が返す `succeeded` を再び台帳へ流すと、Webhook で
 * 計上済みの入金と**別の dedupe 鍵**（`poll:...`）で二重の credit が入り、残高が壊れる。
 * ここに無い種別は照会しても台帳にも請求にも触らない。
 */
export const POST_PAID_KINDS: ReadonlySet<PaymentEventKind> = new Set<PaymentEventKind>([
  "refunded",
  "refund_pending",
  "refund_failed",
  "disputed",
  "dispute_resolved",
]);

/** 走査で拾った 1 件分。 */
export interface ReconcileTarget {
  readonly invoiceId: string;
  readonly attemptId: string;
  readonly providerKey: string;
  readonly bindingId: string;
  readonly externalRef: string;
  /** 期限切れ猶予の中にいる（＝「落とす前の最終照会」）。 */
  readonly finalQuery: boolean;
}

/** 事業者照会の口。テストはここに差し込む（実アダプタは `PaymentProvider.getPaymentStatus`）。 */
export interface StatusQuerier {
  /** `null` を返すと「このアダプタは照会できない」＝走査対象から外す。 */
  query(
    binding: ProviderBinding,
    externalRef: string,
  ): Promise<PaymentSnapshot> | null;
}

export interface ReconcileDeps {
  readonly querier: StatusQuerier;
  /**
   * 多重起動防止のロックキー。既定は `RECONCILE_LOCK_KEY`。
   * **差し替えてよいのはテストの隔離だけ**（並列に走る別テストファイルの実行と
   * 取り合いにならないようにする）。本番の呼び出し側は指定しない。
   */
  readonly lockKey?: bigint;
  readonly now?: Date;
  /** 走査 2 を強制する / 抑止する（テスト用）。既定は 24 時間に 1 回。 */
  readonly forcePaidRescan?: boolean;
  readonly batchLimit?: number;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly requestId: string;
}

export interface ReconcileResult {
  /** ロックを取れて実際に走ったか。false なら他プロセスが走行中（no-op）。 */
  readonly ran: boolean;
  readonly scanned: number;
  readonly advanced: number;
  readonly mismatches: number;
  readonly paidRescanned: number;
  readonly postPaidChanges: number;
  readonly truncated: boolean;
  readonly runId: string | null;
}

interface TargetRow {
  readonly invoice_id: string;
  readonly attempt_id: string;
  readonly provider_key: string;
  readonly provider_binding_id: string;
  readonly external_ref: string;
  readonly attempt_status: string;
}

interface BindingRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly provider_key: string;
  readonly status: string;
  readonly credential_ref: string | null;
  readonly credential_fp: string | null;
  readonly receiving_identifier: string | null;
  readonly receiving_identifier_kind: string | null;
}

function toBinding(row: BindingRow): ProviderBinding {
  return {
    id: row.id,
    organizerUserId: row.organizer_user_id,
    providerKey: row.provider_key,
    status: row.status as ProviderBinding["status"],
    credentialRef: row.credential_ref,
    credentialFp: row.credential_fp,
    receivingIdentifier: row.receiving_identifier,
    receivingIdentifierKind: row.receiving_identifier_kind as ProviderBinding["receivingIdentifierKind"],
  };
}

/** 約束を `ms` で打ち切る。時間切れは `null`（例外にせず「今回は確定しなかった」として扱う）。 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 並列数を `limit` に抑えて写像する。順序は保つ。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 多重起動防止のロックを取る（W11）。取れたら true。
 *
 * **トランザクションスコープ**（`pg_try_advisory_xact_lock`）だけを使う。解放は
 * トランザクションの終了に任せ、`unlock` を呼ぶ経路をこのモジュールに作らない
 * （プーラを挟むと「取った接続」と「解放する接続」が食い違い、ロックが残留する。R-OPS-08）。
 * bigint はドライバのパラメータ型に無いので文字列で渡して SQL 側でキャストする。
 */
async function acquireRunLock(tx: postgres.TransactionSql, lockKey: bigint): Promise<boolean> {
  const rows = await tx<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(${lockKey.toString()}::bigint) AS locked
  `;
  return rows[0]?.locked === true;
}

/** 走査 1: 未決済（生きた試行、または期限切れ 4 日以内）。 */
export async function selectOpenTargets(
  tx: postgres.TransactionSql,
  now: Date,
  limit: number,
): Promise<readonly ReconcileTarget[]> {
  const graceFrom = new Date(now.getTime() - EXPIRED_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await tx<TargetRow[]>`
    SELECT i.id AS invoice_id, a.id AS attempt_id, a.provider_key,
           a.provider_binding_id, a.external_ref, a.status AS attempt_status
    FROM invoice i
    JOIN payment_attempt a ON a.invoice_id = i.id
    WHERE i.settlement_status = ANY(${[...OPEN_SETTLEMENT_STATUSES]}::text[])
      AND i.settlement_rank < ${PAID_RANK}
      AND i.lifecycle_state = 'active'
      AND (a.is_open OR (a.status = 'expired' AND a.updated_at > ${graceFrom}))
    ORDER BY i.updated_at ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    invoiceId: row.invoice_id,
    attemptId: row.attempt_id,
    providerKey: row.provider_key,
    bindingId: row.provider_binding_id,
    externalRef: row.external_ref,
    finalQuery: row.attempt_status === "expired",
  }));
}

/**
 * 走査 2: 支払済み 30 日以内（事業者側の返金・紛争の反映）。
 * 並びは `updated_at ASC`（＝最も長く触っていない順）。`paid_at` で並べると順序が固定され、
 * 先頭 100 件以外が 30 日窓から外れるまで一度も再照会されない（F-4）。
 */
export async function selectPaidTargets(
  tx: postgres.TransactionSql,
  now: Date,
  limit: number,
): Promise<readonly ReconcileTarget[]> {
  const since = new Date(now.getTime() - PAID_RESCAN_DAYS * 24 * 60 * 60 * 1000);
  const rows = await tx<TargetRow[]>`
    SELECT i.id AS invoice_id, a.id AS attempt_id, a.provider_key,
           a.provider_binding_id, a.external_ref, a.status AS attempt_status
    FROM invoice i
    JOIN payment_attempt a ON a.invoice_id = i.id
    WHERE i.settlement_rank >= ${PAID_RANK}
      AND i.paid_at > ${since}
    ORDER BY i.updated_at ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    invoiceId: row.invoice_id,
    attemptId: row.attempt_id,
    providerKey: row.provider_key,
    bindingId: row.provider_binding_id,
    externalRef: row.external_ref,
    finalQuery: false,
  }));
}

/**
 * 走査で拾った請求の**並び順キーを回す**（GPT 敵対レビュー F-3 / F-4 / R-OPS-08）。
 *
 * 走査は `ORDER BY invoice.updated_at ASC LIMIT 100` で並べる。照会が失敗した・状態が
 * 変わらなかった請求は `applyToLedger` が `invoice` を一切 UPDATE しないため、順序キーが
 * 凍結して**先頭 100 件だけ**が延々と再照会され、101 件目以降が二度と照会されなくなる。
 * バッチの最後に拾った行を一度触れば（`invoice_set_updated_at` トリガが `updated_at` を
 * 進める）、次回は未照会の行が先頭に来る。**時刻カーソルではない**（W9。どこにも「前回時刻」を
 * 保存せず、走査条件は状態だけで書かれている。1 回飛んでも次回が同じ集合を拾う）。
 *
 * 値を変えない自己代入にしているのは、状態遷移を `src/lib/ledger/apply.ts` の外で書かない
 * ため（W3）。触るのは行のバージョンと `updated_at` だけである。
 */
async function touchScanned(
  tx: postgres.TransactionSql,
  invoiceIds: readonly string[],
): Promise<void> {
  if (invoiceIds.length === 0) return;
  await tx`
    UPDATE invoice SET needs_attention = needs_attention
    WHERE id = ANY(${[...invoiceIds]}::uuid[])
  `;
}

/** 直近 24 時間に走査 2 を回したか。 */
async function paidRescanDue(tx: postgres.TransactionSql, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - PAID_RESCAN_INTERVAL_HOURS * 60 * 60 * 1000);
  const rows = await tx<{ recent: number }[]>`
    SELECT count(*)::int AS recent
    FROM reconciliation_run
    WHERE paid_rescanned > 0 AND started_at > ${since}
  `;
  return (rows[0]?.recent ?? 0) === 0;
}

/** スナップショットを台帳が読める正規化イベントへ写す。 */
export function snapshotToEvent(
  snapshot: PaymentSnapshot,
  externalRef: string,
): NormalizedEvent {
  // 同じ状態を何度照会しても `payment_event` が増えないよう、ID は「事業者 × 試行 × 状態」で決める。
  const providerEventId = `poll:${snapshot.providerKey}:${externalRef}:${snapshot.kind}`;
  return {
    providerKey: snapshot.providerKey,
    providerEventId,
    eventType: `poll.${snapshot.kind}`,
    kind: snapshot.kind,
    externalRef,
    businessIdemKey: businessIdemKey({ externalRef, kind: snapshot.kind }),
    ledgerDedupeKey: ledgerDedupeKey({
      providerKey: snapshot.providerKey,
      kind: snapshot.kind,
      providerEventId,
    }),
    money: snapshot.money,
    occurredAt: snapshot.fetchedAt,
    // 再照会で得た事実（§10-2 の `trust`）。台帳の confidence は `provider_polled` になる。
    trust: "reverified",
    raw: null,
  };
}

interface ApplyTally {
  readonly advanced: number;
  readonly mismatches: number;
  readonly changed: number;
}

async function applySnapshot(
  tx: postgres.TransactionSql,
  target: ReconcileTarget,
  snapshot: PaymentSnapshot,
  requestId: string,
  now: Date,
): Promise<ApplyTally> {
  const event = snapshotToEvent(snapshot, target.externalRef);
  const paymentEventId = await insertPaymentEvent(tx, {
    providerKey: event.providerKey,
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    kind: event.kind,
    externalRef: event.externalRef,
    businessIdemKey: event.businessIdemKey,
    invoiceId: target.invoiceId,
    attemptId: target.attemptId,
    amountMinor: event.money?.amountMinor ?? null,
    currency: event.money?.currency ?? null,
    occurredAt: event.occurredAt,
    ingestionSource: "poll",
    trust: event.trust,
    rawRedacted: redactRawPayload({
      eventType: event.eventType,
      kind: event.kind,
      externalRef: event.externalRef,
      providerEventId: event.providerEventId,
      amountMinor: event.money?.amountMinor ?? null,
      currency: event.money?.currency ?? null,
    }),
  });
  // W1: 0 行 = 既に同じ状態を取り込み済み。台帳にも請求にも触らない。
  if (paymentEventId === null) return { advanced: 0, mismatches: 0, changed: 0 };

  const outcome = await applyToLedger(tx, {
    event,
    paymentEventId,
    ingestionSource: "poll",
    requestId,
    recordedBy: `cron:reconcile:${event.providerKey}`,
    now,
  });
  return {
    advanced: outcome.rankAdvanced ? 1 : 0,
    mismatches: outcome.result === "mismatch" ? 1 : 0,
    changed: outcome.rankAdvanced || outcome.ledgerAppended ? 1 : 0,
  };
}

/**
 * 1 走査分を照会 → 適用する。
 *
 * `allowedKinds` が `null` でなければ、その集合に無い種別の照会結果は**捨てる**
 * （走査 2 が支払済みの請求へ `succeeded` を再適用して二重計上するのを防ぐ。F-1）。
 */
async function processTargets(
  tx: postgres.TransactionSql,
  targets: readonly ReconcileTarget[],
  deps: ReconcileDeps,
  now: Date,
  allowedKinds: ReadonlySet<PaymentEventKind> | null,
): Promise<ApplyTally> {
  const timeoutMs = deps.timeoutMs ?? RECONCILE_QUERY_TIMEOUT_MS;
  const concurrency = deps.concurrency ?? RECONCILE_CONCURRENCY;

  const bindingIds = [...new Set(targets.map((t) => t.bindingId))];
  const bindings = new Map<string, ProviderBinding>();
  if (bindingIds.length > 0) {
    const rows = await tx<BindingRow[]>`
      SELECT id, organizer_user_id, provider_key, status, credential_ref, credential_fp,
             receiving_identifier, receiving_identifier_kind
      FROM provider_binding WHERE id = ANY(${bindingIds}::uuid[])
    `;
    for (const row of rows) bindings.set(row.id, toBinding(row));
  }

  // ★ 外部照会だけを並列 5 で先に済ませる。DB への書き込み（台帳・監査）は
  //   1 本のトランザクション上で順に行う（監査連鎖のロックを外部 HTTP の待ちと重ねない。P-08）。
  const snapshots = await mapWithConcurrency(targets, concurrency, async (target) => {
    const binding = bindings.get(target.bindingId);
    if (binding === undefined) return null;
    const pending = deps.querier.query(binding, target.externalRef);
    if (pending === null) return null;
    try {
      return await withTimeout(pending, timeoutMs);
    } catch {
      // 事業者側の失敗は今回の実行では確定させない（次回の走査が同じ行を拾う。W9）。
      return null;
    }
  });

  let advanced = 0;
  let mismatches = 0;
  let changed = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const snapshot = snapshots[i];
    const target = targets[i];
    if (snapshot === null || snapshot === undefined || target === undefined) continue;
    // 走査 2: 支払済み後の変化以外（再照会で返る `succeeded` など）は台帳に触らない（F-1）。
    if (allowedKinds !== null && !allowedKinds.has(snapshot.kind)) continue;
    const tally = await applySnapshot(tx, target, snapshot, deps.requestId, now);
    advanced += tally.advanced;
    mismatches += tally.mismatches;
    changed += tally.changed;
  }
  return { advanced, mismatches, changed };
}

/**
 * 再照合 1 回分。ロックが取れなければ**即 no-op で戻る**（`ran: false`）。
 *
 * 呼び出し側は `sql` を渡すだけでよい。内部で 1 本のトランザクションを張り、その中で
 * advisory lock を取る。トランザクションが終われば（コミットでも異常終了でも）ロックは消える。
 */
export async function runReconcile(
  sql: postgres.Sql,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  return sql.begin((tx) => runReconcileInTransaction(tx, deps)) as Promise<ReconcileResult>;
}

/** すでにトランザクションを持っている呼び出し側（統合テスト）向けの本体。 */
export async function runReconcileInTransaction(
  tx: postgres.TransactionSql,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const now = deps.now ?? new Date();
  const emptyResult: ReconcileResult = {
    ran: false,
    scanned: 0,
    advanced: 0,
    mismatches: 0,
    paidRescanned: 0,
    postPaidChanges: 0,
    truncated: false,
    runId: null,
  };

  if (!(await acquireRunLock(tx, deps.lockKey ?? RECONCILE_LOCK_KEY))) return emptyResult;

  const limit = deps.batchLimit ?? RECONCILE_BATCH_LIMIT;

  // ── 走査 1
  const openTargets = await selectOpenTargets(tx, now, limit);
  const openTally = await processTargets(tx, openTargets, deps, now, null);
  // 拾った行を触って順序キーを回す（触らないと先頭 100 件で止まる。F-3）。
  await touchScanned(tx, openTargets.map((target) => target.invoiceId));

  // ── 走査 2（日次 1 回）
  const runPaidRescan = deps.forcePaidRescan ?? (await paidRescanDue(tx, now));
  let paidTargets: readonly ReconcileTarget[] = [];
  let paidTally: ApplyTally = { advanced: 0, mismatches: 0, changed: 0 };
  if (runPaidRescan) {
    paidTargets = await selectPaidTargets(tx, now, limit);
    paidTally = await processTargets(tx, paidTargets, deps, now, POST_PAID_KINDS);
    // 走査 2 も同じ理由で回す（回さないと先頭 100 件だけを毎日見続ける。F-4）。
    await touchScanned(tx, paidTargets.map((target) => target.invoiceId));
  }

  // 上限に達した走査があれば truncated（「取りこぼし」ではなく「続きは次回」。走査 2 の
  // 打ち切りも報告する。F-4）。
  const truncated = openTargets.length >= limit || paidTargets.length >= limit;

  const rows = await tx<{ id: string }[]>`
    INSERT INTO reconciliation_run
      (started_at, finished_at, scanned, advanced, mismatches,
       paid_rescanned, post_paid_changes, truncated, note)
    VALUES (${now}, ${new Date()}, ${openTargets.length},
            ${openTally.advanced + paidTally.advanced},
            ${openTally.mismatches + paidTally.mismatches},
            ${paidTargets.length}, ${paidTally.changed}, ${truncated},
            ${truncated ? "truncated" : null})
    RETURNING id
  `;

  return {
    ran: true,
    scanned: openTargets.length,
    advanced: openTally.advanced + paidTally.advanced,
    mismatches: openTally.mismatches + paidTally.mismatches,
    paidRescanned: paidTargets.length,
    postPaidChanges: paidTally.changed,
    truncated,
    runId: rows[0]?.id ?? null,
  };
}
