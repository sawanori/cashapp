/**
 * GET /api/me — セッションの持ち主が関わっているものを返す（§9）。
 *
 * 返すのは 2 つ。
 *   - `events`: 自分が幹事のイベント（サマリ用の最小列）。
 *   - `claimedInvoices`: 自分が claim 済みの請求（自分の分だけ）。
 *
 * ★ **所有者の判定をリクエストから取らない**（§9「認可の原則」/ 制約 I3・check_006）。
 *   `organizerUserId` に相当する値はセッション由来の `app_user.id` だけを使い、
 *   クエリ文字列・ボディ・ヘッダの userId は一切見ない。
 *
 * ★ CSRF トークンをここでも返す。決済からの復帰やアプリの再起動でメモリ上の
 *   トークンが消えたクライアントが、状態変更の前に取り直せるようにするため
 *   （Cookie に入れない方針の裏返し。R-SEC-12）。
 *
 * ★ 参加者の表示名（`display_label`）はここでは返さない。氏名の相互表示は既定で無効
 *   （§7-5 / R-LAW-06）。幹事向けの名簿は `/api/events/:id/participants`（task_015）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { deriveCsrfToken } from "@/lib/auth/csrf";
import {
  buildSessionCookie,
  issueSession,
  requireSession,
  shouldRefreshSession,
} from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;

interface EventRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly collect_by_at: Date | null;
}

interface ClaimedInvoiceRow {
  readonly id: string;
  readonly event_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly settlement_status: string;
  readonly lifecycle_state: string;
  readonly confirmation_method: string;
  readonly auto_detected: boolean;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);

    const events = await db.sql<EventRow[]>`
      SELECT id, title, status, collect_by_at
      FROM event
      WHERE organizer_user_id = ${session.userId}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const claimedInvoices = await db.sql<ClaimedInvoiceRow[]>`
      SELECT i.id, i.event_id, i.amount_minor, i.currency, i.settlement_status,
             i.lifecycle_state, i.confirmation_method, i.auto_detected
      FROM participant_claim pc
      JOIN app_user u
        ON u.line_user_ref = pc.line_user_ref
       AND u.pepper_version = pc.pepper_version
      JOIN invoice i ON i.participant_id = pc.participant_id
      WHERE u.id = ${session.userId}
        AND pc.released_at IS NULL
      ORDER BY i.created_at DESC
      LIMIT 200
    `;

    // ★ 30 分スライディング（§7-4）。半分を過ぎていたら発行し直す。
    //   `jti` が変わるので CSRF トークンも入れ替わる。**新しいほうを応答で返す**。
    //   クライアントは常にこの応答の `csrfToken` を使うこと（古い値は 403 になる）。
    const refreshed = shouldRefreshSession(session.claims)
      ? await issueSession(config, { userId: session.userId, epoch: session.sessionEpoch })
      : undefined;

    const csrfToken =
      refreshed === undefined
        ? await deriveCsrfToken(config, session.claims.jti, session.claims.kid)
        : await deriveCsrfToken(config, refreshed.jti, refreshed.kid);

    return Response.json(
      {
        userId: session.userId,
        csrfToken,
        events: events.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          collectByAt: row.collect_by_at === null ? null : row.collect_by_at.toISOString(),
        })),
        claimedInvoices: claimedInvoices.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          amountMinor: row.amount_minor,
          currency: row.currency,
          settlementStatus: row.settlement_status,
          lifecycleState: row.lifecycle_state,
          confirmationMethod: row.confirmation_method,
          autoDetected: row.auto_detected,
        })),
        requestId,
      },
      {
        status: 200,
        headers:
          refreshed === undefined
            ? {}
            : { "set-cookie": buildSessionCookie(refreshed.token) },
      },
    );
  } catch (error) {
    logEvent("info", "me.failed", {
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
