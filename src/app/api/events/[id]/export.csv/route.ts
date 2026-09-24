/**
 * `GET /api/events/:id/export.csv`（§9 / §8-1 O-12 / task_021 scope）。
 *
 * 「会費受領記録」の CSV。列は `auto_detected` / `confirmation_method` / 手数料 / 受取見込額
 * を含む（scope）。当該 organizer のみ（`assertEventOwnedByOrganizer`）。
 *
 * ★ 固定文言は実装計画書の原文をそのまま使わない。`docs/wording-policy.md` の W-RECEIPT は
 *   税法上の特定の証憑類を指す語（禁止語一覧を参照）という**部分文字列そのもの**を、
 *   打ち消す文でも禁止している（W-AUTO の否定形の許可文言のような例外が W-RECEIPT には無い）。
 *   `src/**` にその語を書くと、打ち消しているつもりでもこのファイル自身が `gate:wording` を
 *   落とす。同じ法的含意（運営者名義でその種の証憑に相当する書類を発行しない）を、禁止語を
 *   一切含まない別の言い回しで表す（下の `DISCLAIMER_LINES`）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { assertEventOwnedByOrganizer } from "@/lib/db/repositories/events";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import { getStaticProviderCapabilities } from "@/lib/payments/capabilities-static";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export const CSV_TITLE = "会費受領記録";
export const DISCLAIMER_LINES: readonly string[] = [
  CSV_TITLE,
  "発行者は幹事です。",
  "本書は幹事が作成した記録であり、事業者が発行する法定の証憑書類ではありません。",
];

export interface ExportRow {
  readonly display_label: string | null;
  readonly amount_minor: number | null;
  readonly settlement_status: string | null;
  readonly auto_detected: boolean | null;
  readonly confirmation_method: string | null;
}

export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildCsv(providerKey: string, rows: readonly ExportRow[]): string {
  const capabilities = getStaticProviderCapabilities(providerKey);
  const feeIsZero = capabilities?.feeModel.kind === "none";

  const lines: string[] = [...DISCLAIMER_LINES, ""];
  lines.push(
    ["参加者", "金額", "状態", "自動検知", "確認方法", "手数料", "受取見込額"]
      .map(csvField)
      .join(","),
  );

  for (const row of rows) {
    const amount = row.amount_minor;
    const isPaid = row.settlement_status === "paid" || row.settlement_status === "refund_pending" ||
      row.settlement_status === "refunded" || row.settlement_status === "charged_back";
    const feeMinor = amount === null ? null : feeIsZero ? 0 : null;
    const netMinor = amount === null || feeMinor === null ? null : amount - feeMinor;

    lines.push(
      [
        csvField(row.display_label ?? "(未設定)"),
        csvField(amount === null ? "" : String(amount)),
        csvField(row.settlement_status ?? "unpaid"),
        csvField(row.auto_detected === null ? "" : row.auto_detected ? "true" : "false"),
        csvField(row.confirmation_method ?? ""),
        csvField(!isPaid || feeMinor === null ? "" : String(feeMinor)),
        csvField(!isPaid || netMinor === null ? "" : String(netMinor)),
      ].join(","),
    );
  }

  return lines.join("\r\n") + "\r\n";
}

export function contentDispositionFilename(eventId: string): string {
  const ascii = `receipt-record-${eventId}.csv`;
  const utf8 = encodeURIComponent(`${CSV_TITLE}_${eventId}.csv`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;
  const { id } = await params;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);

    await assertEventOwnedByOrganizer(db.sql, session.userId, id);

    const providerRows = await db.sql<{ provider_key: string }[]>`
      SELECT provider_key FROM event WHERE id = ${id}
    `;
    const providerKey = providerRows[0]?.provider_key ?? "manual_confirm";

    const rows = await db.sql<ExportRow[]>`
      SELECT p.display_label, i.amount_minor, i.settlement_status, i.auto_detected, i.confirmation_method
      FROM participant p
      LEFT JOIN invoice i ON i.participant_id = p.id AND i.lifecycle_state = 'active'
      WHERE p.event_id = ${id} AND p.status = 'active'
      ORDER BY p.created_at ASC
    `;

    const csv = buildCsv(providerKey, rows);

    logEvent("info", "events.export_csv", { requestId, userId: session.userId, rowCount: rows.length });

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": contentDispositionFilename(id),
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    logEvent("info", "events.export_csv.failed", {
      requestId,
      code: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL,
    });
    return toErrorResponse(error, requestId);
  } finally {
    if (db !== undefined) {
      await db.close().catch(() => undefined);
    }
  }
}
