/**
 * POST /api/e/claim — 参加者が自分の行を名乗る（§9 / P-2 / check_003）。
 *
 * ★ セッション ＋ 同意 ＋ `X-Join-Token` の 3 つが揃って初めて通る。トークンだけでは通らない。
 * ★ `{ participantId, confirmed: true }`（名簿選択。確認ダイアログ必須）または
 *   `{ claimToken }`（個別リンク。自動確定）のどちらか一方。
 * ★ 二重 claim は `participant_claim` の部分一意インデックスが止める → 409 `ALREADY_CLAIMED`。
 *   同じ人が同じ参加者を再送した場合だけは成功として返す（応答の取りこぼし対策）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import {
  assertParticipantConsent,
  claimParticipant,
  loadUserRef,
  parseClaimBody,
} from "@/lib/db/repositories/claims";
import {
  AppError,
  ERROR_CODES,
  badRequest,
  csrfInvalid,
  newRequestId,
  toErrorResponse,
} from "@/lib/errors";
import { readJoinTokenHeader, resolveEventByJoinToken } from "@/lib/join-token";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    const joinToken = readJoinTokenHeader(request);

    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);

    try {
      await assertCsrfToken(
        config,
        request.headers.get(CSRF_HEADER),
        session.claims.jti,
        session.claims.kid,
      );
    } catch {
      throw csrfInvalid("X-CSRF-Token missing or mismatched");
    }

    await assertParticipantConsent(db.sql, session.userId);

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const input = parseClaimBody(bodyJson);

    const event = await resolveEventByJoinToken(db.sql, joinToken);
    const userRef = await loadUserRef(db.sql, session.userId);
    const dbHandle = db;

    const claimed = await dbHandle.sql.begin(async (tx) => {
      const result = await claimParticipant(tx, {
        eventId: event.id,
        lineUserRef: userRef.lineUserRef,
        pepperVersion: userRef.pepperVersion,
        input,
      });
      await appendAuditLog(tx, {
        actorType: "participant",
        actorRef: userRef.lineUserRef,
        action: "participant.claim",
        targetType: "participant",
        targetId: result.participantId,
        requestId,
        detail: { via: result.via },
      });
      return result;
    });

    logEvent("info", "e.claim", {
      requestId,
      userId: session.userId,
      outcome: claimed.via,
    });

    return Response.json(
      {
        participantId: claimed.participantId,
        displayLabel: claimed.displayLabel,
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "e.claim.failed", {
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
