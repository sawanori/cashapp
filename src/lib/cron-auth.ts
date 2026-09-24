/**
 * `/api/cron/*` の認可（§7-7 / §9 / check_104）。
 *
 * ★ 判定は 2 段。**順序が防御である**:
 *     ① `APP_ENV !== 'production'` → **無条件 404**。DB にも設定にも触れない。
 *        非本番にこの口が開いていること自体が攻撃面になる（Webhook ルートと同じ方針）。
 *     ② `X-Cron-Secret` が `CRON_SECRETS`（カンマ区切りの許容リスト）のどれとも
 *        一致しなければ 401。cron Worker は先頭値だけを送るが、**ローテーション中は
 *        旧値も受理する**ため許容リスト方式にしてある（W12 と同じ発想）。
 *
 * ★ 比較は定数時間。長さが違えば即 false（一致しない前提なので長さの露出は問題にしない）。
 *
 * ★ このモジュールは DB にも Cloudflare ランタイムにも依存しない純関数だけを持つ。
 *   ルートは「404 / 401 / 通す」の 3 値だけを受け取る。
 */

import { AppError, ERROR_CODES, type ErrorCode } from "@/lib/errors";

/** cron Worker が送るヘッダ名（`workers/cron/index.ts` と一致させること）。 */
export const CRON_SECRET_HEADER = "X-Cron-Secret";

/** この口が開いてよい唯一の `APP_ENV`。 */
export const CRON_PRODUCTION_APP_ENV = "production";

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_UNAUTHORIZED = ERROR_CODES.UNAUTHORIZED;

/**
 * cron Worker が呼ぶパスの正本。`workers/cron/index.ts` の `CRON_ROUTES`・
 * `workers/cron/wrangler.toml` の `[triggers] crons`・`src/app/api/cron/` 配下の
 * `route.ts` の三者が一致することを `tests/unit/cron-auth.test.ts` が機械検査する。
 */
export const CRON_PATHS: readonly string[] = [
  "/api/cron/reconcile",
  "/api/cron/outbox",
  "/api/cron/retention",
  "/api/cron/idempotency-cleanup",
  "/api/cron/audit-verify",
  "/api/cron/apply-pending",
];

/** カンマ区切りの許容リストを配列にする。空要素は捨てる。 */
export function parseCronSecrets(raw: string | undefined): readonly string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 定数時間比較。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface CronAuthInput {
  readonly appEnv: string | undefined;
  readonly secrets: readonly string[];
  readonly presented: string | null;
}

/**
 * 認可の判断。通れば `null`、通らなければ投げるべき `AppError` を返す
 * （呼び出し側が `toErrorResponse` に渡す）。
 */
export function checkCronAuth(input: CronAuthInput): AppError | null {
  if (input.appEnv !== CRON_PRODUCTION_APP_ENV) {
    return new AppError(CODE_NOT_FOUND, 404, "not found");
  }
  const presented = input.presented;
  if (presented === null || presented.length === 0 || input.secrets.length === 0) {
    return new AppError(CODE_UNAUTHORIZED, 401, "unauthorized");
  }
  for (const secret of input.secrets) {
    if (timingSafeEqual(presented, secret)) return null;
  }
  return new AppError(CODE_UNAUTHORIZED, 401, "unauthorized");
}

/** `Request` から判断する薄いラッパ。 */
export function checkCronRequest(
  request: Request,
  appEnv: string | undefined,
  secrets: readonly string[],
): AppError | null {
  return checkCronAuth({
    appEnv,
    secrets,
    presented: request.headers.get(CRON_SECRET_HEADER),
  });
}
