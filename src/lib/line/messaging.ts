/**
 * LINE Messaging API 向けの幹事通知モジュール（task_023 / ADR-007 / check_113）。
 *
 * `docs/decisions/ADR-007-raw-userid-consent.md`（accepted, パターン B）:
 * Phase 1 では幹事の生 LINE userId を一切保存しない。Messaging API の `push` は宛先指定に
 * 生 userId を要求するため、生 userId を持たない Phase 1 では呼びようがない。
 *
 * 要対応の伝達は Phase 1 では次の 2 経路のみ:
 *   1. 運営者向け内部通知（`src/lib/outbox-transports.ts` の `ops_alert` → `internal_webhook`）
 *   2. 幹事画面の要対応バッジ（O-2, task_014, `src/app/(liff)/events/page.tsx`）
 *
 * この関数はその決定を型で表明するだけで、**外部への fetch は一切行わない**。
 * Phase 2 で同意設計（ADR-007 の更新）が固まったら、ここに実際の `push` 呼び出しを追加する。
 */

import "server-only";

/** 幹事向け通知の配達先。`line_messaging_push` は Phase 2 の拡張点（Phase 1 では到達しない）。 */
export type OrganizerNotifyChannel = "in_app_badge" | "line_messaging_push";

export interface OrganizerNotifyResult {
  readonly delivered: boolean;
  readonly channel: OrganizerNotifyChannel;
  readonly reason: string;
}

/**
 * 幹事への要対応通知。Phase 1 は常に `in_app_badge` に決定して返す（LINE API への fetch なし）。
 * `src/lib/outbox-transports.ts` の `organizer_notify` 配達はこの関数を呼ぶだけで
 * outbox 行を `done` にしてよい（実際の可視化は O-2 が DB を直接読んで行うため、
 * ここでの「配達」は ADR-007 の決定を実行時にも守っていることの確認でしかない）。
 */
export function notifyOrganizer(): Promise<OrganizerNotifyResult> {
  return Promise.resolve({
    delivered: true,
    channel: "in_app_badge",
    reason: "ADR-007 pattern B (accepted): LINE messaging push deferred to phase 2",
  });
}
