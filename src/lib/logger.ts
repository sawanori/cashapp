/**
 * 構造化ログ（サーバー専用）。
 *
 * ★ 二重の防御にする（R-SEC-04 / R-SEC-02 / §7-7「ログ・ビルド成果物」）。
 *
 *   1. **キーの allowlist**: `LOG_KEY_ALLOWLIST` に無いキーは、値が何であっても落とす。
 *      「うっかり `user` オブジェクトごと渡す」型の事故を、値を見る前に止める。
 *   2. **値のスクラブ**: 通ったキーの値も、既知の危険な形（LINE の生 userId・IP アドレス・
 *      `Bearer` トークン・JWT・長い base64/hex の秘密値らしき文字列）に一致すれば
 *      `[redacted:<種別>]` に置き換える。allowlist 済みのキーに危険な値が入る事故
 *      （`detail` に例外メッセージをそのまま入れる等）を止める。
 *
 * ★ 出力は 1 行 1 JSON（Cloudflare Workers Logs が構造化フィールドとして拾える形）。
 *
 * ★ **生の IP は絶対にログに出さない。** 必要なら `hashIp()` で HMAC にしてから
 *   `ipRef` として渡す（§7-5「監査ログ: IP は HMAC」）。
 *
 * ★ **joinToken / claimToken / ID トークン / セッション JWT / PEPPER / セッション鍵 /
 *   CRON_SECRETS を、キーとしても値としても渡さない。** キーは allowlist に入れておらず、
 *   値はスクラブで落ちるが、そもそも呼び出し側が渡さないのが一次防御である。
 */

import "server-only";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * ログに出してよいキー。ここに無いキーは黙って落とす（例外にはしない。
 * ログのために本処理を落とさない）。
 *
 * 追加するときは「この値が漏れても被害が無いか」を必ず確認すること。
 * 迷ったら追加せず、`detail` に短い説明文を入れる。
 */
export const LOG_KEY_ALLOWLIST: readonly string[] = [
  // 識別・相関
  "event",
  "requestId",
  "route",
  "method",
  "status",
  // 主体（いずれも擬似化済みの参照値のみ）
  "userId", // app_user.id（UUID）。LINE の userId ではない
  "userRefFp", // line_user_ref の fingerprint（先頭 16 hex）
  "ipRef", // HMAC 済みの IP 参照
  "uaClass", // UA の粗い分類（ios / android / other）
  // 認証・鍵
  "kid",
  "pepperVersion",
  "sessionEpoch",
  "identityScope",
  "lineEnv",
  "appEnv",
  "pepperFingerprint",
  "liffIdFingerprint",
  "channelIdFingerprint",
  "credentialFp",
  // 結果
  "code",
  "outcome",
  "reason",
  "detail",
  "durationMs",
  "rateLimitBackend",
  "count",
];

const ALLOWED_KEYS: ReadonlySet<string> = new Set(LOG_KEY_ALLOWLIST);

/**
 * 値のスクラブ規則。順番に適用する。
 *
 * `label` はテスト（tests/security/log-pii.test.ts）が「どの規則で落ちたか」を
 * 確かめるために使う。
 */
export const REDACTION_RULES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  // LINE の生 userId。`U` + 32 桁 hex（check_007 / check_041 の検出形と同じ）。
  { label: "line-user-id", pattern: /U[0-9a-f]{32}/g },
  // `Bearer xxx` / `Basic xxx`。
  { label: "authorization", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi },
  // JWT（3 セグメント）。セッション JWT・LINE の ID トークンの両方に一致する。
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  },
  // postgres / postgresql の接続文字列（パスワードを含む）。
  { label: "connection-string", pattern: /\bpostgres(?:ql)?:\/\/[^\s"']+/gi },
  // IPv4。ログに生 IP を出さない（§7-5）。
  { label: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  // IPv6（`::1` のような短縮形を含む、hex と `:` だけからなる 2 個以上の `:` を持つ塊）。
  { label: "ipv6", pattern: /\b(?=[0-9A-Fa-f:]*:[0-9A-Fa-f:]*:)[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}\b/g },
  // `KEY=value` / `KEY: value` 形の秘密値（PEPPER / SESSION_KEYS / CRON_SECRETS / *_SECRET / *_TOKEN ほか）。
  {
    label: "secret-assignment",
    pattern:
      /\b(?:PEPPER|SESSION_KEYS?|CRON_SECRETS?|[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|APIKEY|SERVICE_ROLE|PRIVATE_KEY|SIGNING_KEY))\b\s*[=:]\s*\S+/g,
  },
  // 32 文字以上の英数字・アンダースコアの塊（上のどれにも当たらない秘密値らしき文字列）。
  // ★ ハイフンをこの規則の文字クラスに入れない。入れると UUID（36 文字）が丸ごと一致し、
  //   `userId`（app_user.id）が毎回 `[redacted]` になってログの相関が取れなくなる。
  { label: "long-opaque", pattern: /\b[A-Za-z0-9_]{32,}\b/g },
  // ハイフンを含む長い不透明文字列。UUID（36 文字）より長い 40 文字以上に限る。
  { label: "long-opaque-b64url", pattern: /\b[A-Za-z0-9_-]{40,}\b/g },
];

/** 文字列から既知の危険な形を落とす。 */
export function redact(input: string): string {
  let out = input;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, `[redacted:${rule.label}]`);
  }
  return out;
}

/** ログに載せる値は string / number / boolean / null だけにする。 */
export type LogValue = string | number | boolean | null;

function scrubValue(value: unknown): LogValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redact(value);
  // オブジェクト・配列・関数・undefined・symbol・bigint は載せない。
  // 「構造ごと渡してしまう」事故を型ではなく実装で止める。
  return undefined;
}

export interface LogFields {
  readonly [key: string]: unknown;
}

/**
 * スクラブを掛けないキー。
 *
 * `requestId` は `newRequestId()` が CSPRNG で作る 32 桁 hex であり、秘密値ではない。
 * スクラブを掛けると `long-opaque` 規則に当たって毎回 `[redacted:long-opaque]` になり、
 * ログとエラー応答の突き合わせができなくなる（それが `requestId` の唯一の用途である）。
 * ここに足すキーは「アプリが自分で生成した、秘密でない識別子」だけに限る。
 */
export const UNSCRUBBED_KEYS: ReadonlySet<string> = new Set(["requestId"]);

/**
 * 出力する 1 行分のレコードを組み立てる（副作用なし。テストはこれを直接見る）。
 *
 * - `level` / `event` / `ts` は常に入る。
 * - それ以外は allowlist を通ったキーだけが入り、値はスクラブされる。
 */
export function buildLogRecord(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): Record<string, LogValue> {
  const record: Record<string, LogValue> = {
    ts: new Date().toISOString(),
    level,
    event: redact(event),
  };

  for (const [key, raw] of Object.entries(fields)) {
    if (key === "ts" || key === "level" || key === "event") continue;
    if (!ALLOWED_KEYS.has(key)) continue;
    if (UNSCRUBBED_KEYS.has(key)) {
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        record[key] = raw;
      }
      continue;
    }
    const value = scrubValue(raw);
    if (value === undefined) continue;
    record[key] = value;
  }

  return record;
}

/** 1 行 1 JSON で出す。`console.error` は level が error のときだけ使う。 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify(buildLogRecord(level, event, fields));
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * IP を HMAC-SHA256 で参照値に変える（生 IP をどこにも残さないため）。
 *
 * `key` には現行 PEPPER を渡す。PEPPER を回すと過去の `ipRef` と繋がらなくなるが、
 * IP 参照は短期の異常検知にしか使わないので問題にしない。
 * 戻り値は先頭 16 hex（64 ビット）。全長を出す必要が無い。
 */
export async function hashIp(ip: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`ip:${ip}`));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
