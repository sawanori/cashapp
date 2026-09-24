/**
 * `outbox` の配達先（`OutboxTransport`）ごとの具体実装（task_023 / check_113 / R-OPS-01）。
 *
 * `src/lib/outbox.ts`（task_018 所有）の `OUTBOX_TRANSPORT` が「kind → 抽象配達先」の正本を持つ。
 * ここは「抽象配達先 → 実際に何をするか」だけを持つ。
 *
 *   - `ops_alert` → `internal_webhook`: 運営者向けの内部 Webhook（`OPS_ALERT_WEBHOOK_URL`）に
 *     PII を含まない payload（kind・outboxId・attempts のみ）を送る。未設定ならログのみ
 *     （fail-open。運用アラートの送達先が無くても outbox 本体の配達は止めない）。
 *   - `organizer_notify` → `src/lib/line/messaging.ts` の `notifyOrganizer()`。ADR-007
 *     （パターン B, accepted）により Phase 1 は LINE Messaging API を一切呼ばない。
 *
 * `line_messaging` transport（Phase 2 で `organizer_notify` を LINE push に切り替える際の
 * 拡張点）と `none`（配達不要な kind ができた場合の拡張点）は Phase 1 では未使用。
 *
 * ★ `src/app/api/cron/outbox/route.ts`（task_020 所有）は既定で `logOnlyDeliver` を使う。
 *   この配達関数をそこへ注入する配線は task_020 の files_to_modify に無いため本タスクでは
 *   行っていない（`docs/concerns/task_023.md` 参照）。
 */

import "server-only";

import { logEvent } from "@/lib/logger";
import { notifyOrganizer, type OrganizerNotifyResult } from "@/lib/line/messaging";
import type { OutboxTransport } from "@/lib/outbox";

/** `src/app/api/cron/outbox/route.ts` の `OutboxJob` と同じ形。route.ts には依存しない。 */
export interface OutboxDeliveryJob {
  readonly id: string;
  readonly kind: string;
  readonly transport: OutboxTransport;
  readonly attempts: number;
}

/** `ops_alert` が送る、PII を含まない最小 payload。 */
export interface OpsAlertPayload {
  readonly kind: string;
  readonly outboxId: string;
  readonly attempts: number;
}

export type OpsAlertSender = (payload: OpsAlertPayload) => Promise<void>;
export type OrganizerNotifier = () => Promise<OrganizerNotifyResult>;

/**
 * 既定の ops_alert 送信。`OPS_ALERT_WEBHOOK_URL` 未設定ならログのみ（ローカル・staging 未設定時
 * のデフォルト）。応答が非 2xx なら例外を投げ、呼び出し側（`runOutboxBatch`）の失敗経路
 * （指数バックオフ・dead letter）に委ねる。
 */
export const sendOpsAlertViaWebhook: OpsAlertSender = async (payload) => {
  const url = process.env["OPS_ALERT_WEBHOOK_URL"];
  if (url === undefined || url === "") {
    logEvent("info", "outbox.ops_alert.skipped", { reason: "webhook_not_configured" });
    return;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`ops alert webhook responded with status ${response.status}`);
  }
};

export interface OutboxDeliverOverrides {
  readonly sendOpsAlert?: OpsAlertSender;
  readonly notifyOrganizer?: OrganizerNotifier;
}

/** transport → 配達関数を組み立てる。テストは送信部分だけ差し替える。 */
export function createOutboxDeliver(
  overrides: OutboxDeliverOverrides = {},
): (job: OutboxDeliveryJob) => Promise<void> {
  const sendOpsAlert = overrides.sendOpsAlert ?? sendOpsAlertViaWebhook;
  const notify = overrides.notifyOrganizer ?? notifyOrganizer;

  return async (job) => {
    switch (job.transport) {
      case "ops_alert":
        await sendOpsAlert({ kind: job.kind, outboxId: job.id, attempts: job.attempts });
        return;
      case "organizer_notify":
        await notify();
        return;
      default: {
        const exhaustive: never = job.transport;
        throw new Error(`unhandled outbox transport: ${String(exhaustive)}`);
      }
    }
  };
}

/** 本番既定の配達関数。`runOutboxBatch(tx, { deliver: deliverOutboxJob })` に渡す想定。 */
export const deliverOutboxJob = createOutboxDeliver();
