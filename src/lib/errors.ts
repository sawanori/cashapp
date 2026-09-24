/**
 * API のエラー表現（§9: エラーは `{ code, message, requestId }`）。
 *
 * ★ 規約
 *   - 応答ボディは **必ず** `{ code, message, requestId }` の 3 キーだけにする。
 *     スタックトレース・内部例外の `message`・SQL・接続文字列を外に出さない。
 *   - `code` は機械が読む固定文字列（SCREAMING_SNAKE_CASE）。分岐条件はこれだけを見る。
 *   - `message` は人が読む短文。**利用者に見せる文言はここではなく UI 側が持つ**
 *     （`docs/wording-policy.md` の禁止語検査は UI 文言に掛かる）。ここは運用者向けの説明。
 *   - `requestId` はリクエスト 1 本に 1 個。ログと突き合わせるための唯一の手掛かりで、
 *     秘密値を含まない乱数である。
 *
 * ★ 秘密値を握った例外を素通しさせないため、外に出す形は `toErrorResponse()` だけにする。
 *   未知の例外は `INTERNAL` に畳み、元の `message` を捨てる（R-SEC-04）。
 */

/** `{ code, message, requestId }`。API のエラー応答はこの形しか返さない。 */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
}

/**
 * 本アプリが返すエラーコード。
 * §9 の表に出てくるものと、本タスク（task_012）が新たに必要とするものだけを置く。
 */
export const ERROR_CODES = {
  /** ID トークンの検証に失敗した（改竄・期限切れ・aud 不一致・再利用のすべてを含む）。 */
  ID_TOKEN_INVALID: "ID_TOKEN_INVALID",
  /** セッションが無い・壊れている・失効している。 */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** `X-CSRF-Token` が無い、または一致しない。 */
  CSRF_INVALID: "CSRF_INVALID",
  /** レート制限に掛かった。 */
  RATE_LIMITED: "RATE_LIMITED",
  /** レート制限のバックエンドが無いので、安全側に倒して受け付けない（fail-closed）。 */
  RATE_LIMIT_UNAVAILABLE: "RATE_LIMIT_UNAVAILABLE",
  /** リクエストボディが期待した形ではない。 */
  BAD_REQUEST: "BAD_REQUEST",
  /** 環境設定が不正で、この経路を安全に動かせない。 */
  CONFIG_INVALID: "CONFIG_INVALID",
  /** 利用者が停止されている。 */
  USER_SUSPENDED: "USER_SUSPENDED",
  /** 上のどれでもない。元の例外の内容はここには出さない。 */
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** HTTP ステータスを持つアプリ例外。`toErrorResponse()` はこれだけを信用して外に出す。 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  /** ログにだけ出す補足。応答ボディには入らない。秘密値は入れないこと。 */
  public readonly detail: string | undefined;

  public constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: { readonly detail?: string; readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.detail = options.detail;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** 401。ID トークンの検証失敗はすべてこの 1 コードに畳む（どこで落ちたかを攻撃者に教えない）。 */
export function idTokenInvalid(detail?: string): AppError {
  return new AppError(
    ERROR_CODES.ID_TOKEN_INVALID,
    401,
    "LINE のログイン情報を確認できませんでした。もう一度開いてください。",
    detail === undefined ? {} : { detail },
  );
}

/** 401。セッション不正・失効。 */
export function unauthorized(detail?: string): AppError {
  return new AppError(
    ERROR_CODES.UNAUTHORIZED,
    401,
    "ログインし直してください。",
    detail === undefined ? {} : { detail },
  );
}

/** 403。CSRF トークンの欠落・不一致。 */
export function csrfInvalid(detail?: string): AppError {
  return new AppError(
    ERROR_CODES.CSRF_INVALID,
    403,
    "この操作を受け付けられませんでした。もう一度開いてください。",
    detail === undefined ? {} : { detail },
  );
}

/** 429。 */
export function rateLimited(detail?: string): AppError {
  return new AppError(
    ERROR_CODES.RATE_LIMITED,
    429,
    "時間をおいてからもう一度お試しください。",
    detail === undefined ? {} : { detail },
  );
}

/** 400。 */
export function badRequest(detail?: string): AppError {
  return new AppError(
    ERROR_CODES.BAD_REQUEST,
    400,
    "リクエストの形式が正しくありません。",
    detail === undefined ? {} : { detail },
  );
}

/**
 * リクエスト ID を作る。
 * 32 桁の hex（128 ビット）。秘密値でも推測防止でもなく、ログとの突き合わせ用の識別子である。
 */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 例外を `{ code, message, requestId }` の応答に変換する唯一の出口。
 *
 * `AppError` 以外は **内容を捨てて** `INTERNAL` にする。DB ドライバや `fetch` の例外は
 * 接続文字列・URL・トークンを `message` に載せていることがあるため、外に出してはいけない。
 */
export function toErrorResponse(
  error: unknown,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const appError =
    error instanceof AppError
      ? error
      : new AppError(ERROR_CODES.INTERNAL, 500, "処理に失敗しました。時間をおいてお試しください。");

  const body: ErrorBody = {
    code: appError.code,
    message: appError.message,
    requestId,
  };

  return Response.json(body, {
    status: appError.status,
    headers: { ...extraHeaders },
  });
}
