/**
 * POST /api/consent — 同意の取得を `consent_log` に記録する（§9 / L6 / R-LAW-06）。
 *
 * 記録するのは「どの文言のどのバージョンに、いつ同意したか」だけ。
 * 文言そのものは `src/content/terms.md` / `privacy.md`（task_021）が持ち、
 * ここにはバージョン文字列しか入らない。
 *
 * ★ セッション必須 ＋ `X-CSRF-Token` 必須（状態変更なので CSRF 検査の対象）。
 * ★ 同意は**追記**である。撤回や上書きはしない（`consent_log` は履歴テーブル）。
 * ★ `tos` / `privacy` は `app_user` の受領時刻も更新する（最新の同意時刻を 1 か所で引けるように）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import {
  AppError,
  ERROR_CODES,
  badRequest,
  csrfInvalid,
  newRequestId,
  toErrorResponse,
} from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;

/** `consent_log.consent_kind` の CHECK 制約と同じ集合（supabase/migrations/0001_init.sql）。 */
export const CONSENT_KINDS: readonly string[] = [
  "tos",
  "privacy",
  "organizer_disclosure",
  "fee_display",
];

const MAX_TEXT_VERSION_LENGTH = 64;

export interface ConsentInput {
  readonly consentKind: string;
  readonly textVersion: string;
}

/** ボディの検査。DB の CHECK に頼らず、アプリ側でも同じ集合で弾く。 */
export function parseConsentBody(body: unknown): ConsentInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const consentKind = record["consentKind"];
  const textVersion = record["textVersion"];

  if (typeof consentKind !== "string" || !CONSENT_KINDS.includes(consentKind)) {
    throw badRequest(`consentKind must be one of ${CONSENT_KINDS.join(" / ")}`);
  }
  if (
    typeof textVersion !== "string" ||
    textVersion.trim().length === 0 ||
    textVersion.length > MAX_TEXT_VERSION_LENGTH
  ) {
    throw badRequest("textVersion is required");
  }
  return { consentKind, textVersion: textVersion.trim() };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const input = parseConsentBody(body);

    await db.sql.begin(async (tx) => {
      await tx`
        INSERT INTO consent_log (user_id, consent_kind, text_version)
        VALUES (${session.userId}, ${input.consentKind}, ${input.textVersion})
      `;
      if (input.consentKind === "tos") {
        await tx`UPDATE app_user SET tos_accepted_at = now() WHERE id = ${session.userId}`;
      } else if (input.consentKind === "privacy") {
        await tx`UPDATE app_user SET privacy_consent_at = now() WHERE id = ${session.userId}`;
      }
    });

    logEvent("info", "consent.recorded", {
      requestId,
      userId: session.userId,
      reason: input.consentKind,
    });

    return Response.json({ recorded: true, requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "consent.failed", {
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
