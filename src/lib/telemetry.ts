/**
 * フロントエンドの最小テレメトリ（R-LINE-03 / check_078）。
 *
 * ★ このモジュールは **クライアントにもサーバーにも載る**。`import "server-only"` を付けない。
 *   その代わり、ここには秘密値も DB も一切持ち込まない。
 *
 * ★ 送るのは「機械可読なコード 1 つだけ」である。
 *   クライアントが送るボディは `{ code }` **のみ**。自由入力欄・例外メッセージ・スタック・
 *   URL・UA 文字列・利用者識別子のどれも送らない（check_078「PII と自由入力が含まれない」）。
 *   受信側が足すのは、クライアントが渡していない 3 つだけ:
 *     - `requestId`        … サーバーが生成する不透明 ID
 *     - `uaClass`          … サーバーが `User-Agent` ヘッダから作る粗い分類（ios/android/other）
 *     - `liffIdFingerprint`… サーバーが自分の設定から作る SHA-256 の先頭 16 hex
 *   つまり「クライアントを信じて記録する値」は `code` だけであり、**コードは allowlist**である。
 *
 * ★ 送信は best-effort。失敗しても例外を投げない・再送しない。
 *   テレメトリのために画面を壊すのは本末転倒であり、再送はループ障害（R-LINE-02）のときに
 *   そのまま増幅装置になる。
 */

/**
 * 送ってよいエラーコード。**ここに無いコードは送れないし、受け取らない。**
 *
 * 文字列を自由に作れるようにすると、そこが実質的な自由入力欄になり PII が載る。
 * 新しいコードを足すときは、それが「機械が分類に使う語」であって「人が書く説明」でないことを
 * 確かめること。
 */
export const CLIENT_ERROR_CODES = {
  /** `liff.init()` が reject した（LIFF ID 不正・エンドポイント URL 不一致など）。 */
  LIFF_INIT_FAILED: "liff_init_failed",
  /** LIFF SDK のチャンクを取得できなかった、または 3 秒で間に合わなかった。 */
  SDK_LOAD_FAILED: "sdk_load_failed",
  /** ページ全体のスクリプトエラー（古い WebView の構文エラーを含む）。 */
  SCRIPT_ERROR: "script_error",
  /** ログイン試行回数の上限に達したので打ち切った（R-LINE-02）。 */
  LOGIN_LOOP_ABORTED: "login_loop_aborted",
} as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES];

/** allowlist の実体。`isClientErrorCode` 以外からは参照しない。 */
const CLIENT_ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.values(CLIENT_ERROR_CODES));

/** 受信側・送信側の両方が使う判定。 */
export function isClientErrorCode(value: unknown): value is ClientErrorCode {
  return typeof value === "string" && CLIENT_ERROR_CODE_SET.has(value);
}

/** 送信先。クライアントとテストが同じ定数を見るために 1 か所に置く。 */
export const TELEMETRY_ENDPOINT = "/api/telemetry/client-error";

/** クライアントが送るボディの形。**このキー以外を増やさないこと。** */
export interface ClientErrorPayload {
  readonly code: ClientErrorCode;
}

/**
 * 送信ボディを組み立てる唯一の関数。
 *
 * テストはこの戻り値のキー集合が `["code"]` ちょうどであることを検査する。
 * 「ついでにこれも送ろう」を型ではなくテストで止めるための入口である。
 */
export function buildClientErrorPayload(code: ClientErrorCode): ClientErrorPayload {
  return { code };
}

/** `User-Agent` の粗い分類。**UA 文字列そのものはどこにも残さない。** */
export type UaClass = "ios" | "android" | "other";

/**
 * UA を 3 値に畳む。
 *
 * 目的は「どの WebView 系統で起動に失敗しているか」の集計だけなので、これ以上細かくしない。
 * バージョン・端末名まで残すと、少数端末の利用者が事実上特定できる粒度になる。
 */
export function classifyUserAgent(userAgent: string | null | undefined): UaClass {
  if (typeof userAgent !== "string" || userAgent.length === 0) return "other";
  if (/iPhone|iPad|iPod|iOS/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

/** `reportClientError` が使う最小の依存。テストから差し替える。 */
export interface TelemetryDeps {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
}

/**
 * クライアントから 1 件送る。**決して throw しない。**
 *
 * - `keepalive: true` を付けるのは、`liff.login()` による遷移や画面離脱と競合しても
 *   送信が打ち切られないようにするため。
 * - 認証は要らない（セッションを張れない状態こそが送りたい事象である）。
 *   代わりにサーバー側で IP 単位のレート制限を掛ける。
 * - Cookie を積む理由が無いので `credentials: "omit"`。
 *
 * @returns 送信できたら true。送れなかった場合も false を返すだけで例外にしない。
 */
export async function reportClientError(
  code: ClientErrorCode,
  deps: TelemetryDeps = {},
): Promise<boolean> {
  const endpoint = deps.endpoint ?? TELEMETRY_ENDPOINT;
  const fetchImpl =
    deps.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
  if (fetchImpl === undefined) return false;

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildClientErrorPayload(code)),
      credentials: "omit",
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}
