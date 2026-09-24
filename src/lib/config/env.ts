/**
 * 環境設定の読み取りと**起動時アサート**（サーバー専用）。
 *
 * ★ この関数が投げたら、そのランタイムは 1 リクエストも処理してはいけない。
 *   「黙って空文字で HMAC する」「staging の鍵で本番を動かす」を構造的に不可能にする
 *   （R-SEC-09 / R-SEC-05 / R-LINE-04）。
 *
 * ★ 検査するのは 5 つ。
 *   1. `APP_ENV` が既知の 3 値のいずれかであること。
 *   2. `LINE_ENV_PROFILE`（LIFF ID ＋ LINE Login チャネル ID のペア）が
 *      `APP_ENV` と一致し、かつ **LIFF ID のハイフン前の数字列 == loginChannelId** であること。
 *      LIFF ID は `<LINE Login チャネル ID>-<8 文字>` の形を取る
 *      （`docs/vendor-docs/line/verify.md` §1）。一致しないときは、どちらかに
 *      別チャネル（Messaging API チャネル等）の ID が混ざっている（N3 / R-LINE-04）。
 *   3. `PEPPER` / `SESSION_KEYS` / `CRON_SECRETS` が存在し、各値が **32 バイト以上**であること。
 *   4. `SESSION_KEYS` が **1〜2 鍵**であること（現行＋直前の 2 世代までしか検証しない。
 *      3 つ書けるようにすると「2 世代前が通る」実装に静かに滑る。R-SEC-10）。
 *   5. `APP_ENV` と Supabase project ref の対応（R-SEC-05）。
 *
 * ★ **秘密値そのものは例外メッセージにもログにも出さない。** 出すのは変数名・長さ・
 *   バージョン番号・fingerprint だけ。
 *
 * ★ この モジュールは `crypto.subtle` を使わない同期関数だけを公開する。
 *   fingerprint（SHA-256）だけは非同期なので別関数に分けてある。
 */

import "server-only";

export type AppEnvName = "development" | "staging" | "production";

const APP_ENV_NAMES: readonly AppEnvName[] = ["development", "staging", "production"];

/** 秘密値に要求する最小バイト長（§7-4「未設定または 32 バイト未満なら起動失敗」）。 */
export const MIN_SECRET_BYTES = 32;

/** `SESSION_KEYS` に書いてよい鍵の数の上限（現行＋直前）。 */
export const MAX_SESSION_KEYS = 2;

/** LIFF ID の形。`<10 桁のチャネル ID>-<8 文字の識別子>`。 */
const LIFF_ID_RE = /^(\d{10})-([0-9A-Za-z]{8})$/;

/** LINE のチャネル ID の形（10 桁の数字）。 */
const CHANNEL_ID_RE = /^\d{10}$/;

/** セッション鍵の `kid` の形。ログにも JWT ヘッダにも出るので、記号を絞る。 */
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Supabase の project ref の形（20 文字の英小文字）。 */
const PROJECT_REF_RE = /^[a-z]{20}$/;

/**
 * `APP_ENV` ごとに期待する Supabase project ref。**ソースに固定する**（R-SEC-05）。
 *
 * なぜ環境変数どうしの突き合わせにしないか: 突き合わせる相手も環境変数なら、
 * 環境変数を一括投入した瞬間に両方が同じ（誤った）値になり、検査が意味を失う。
 * 「本番の ref はこれである」という宣言は、環境から独立した場所＝ソースに置く必要がある。
 *
 * ★ 実値は未採番である。Supabase プロジェクトの作成は staging が task_035、
 *   production が task_024。それまではプレースホルダのままにしておき、
 *   **staging / production で起動しようとすると必ず落ちる**（fail-closed）。
 *   これは不具合ではなく意図した状態で、実値を入れるのが上記タスクの仕事である。
 *   `development`（ローカルの `supabase start`）は project ref を持たないので検査しない。
 */
export const EXPECTED_SUPABASE_PROJECT_REF: Readonly<Record<AppEnvName, string | null>> = {
  development: null,
  staging: "REPLACE_WITH_STAGING_SUPABASE_PROJECT_REF_TASK_035",
  production: "REPLACE_WITH_PRODUCTION_SUPABASE_PROJECT_REF_TASK_024",
};

/** LIFF ID と LINE Login チャネル ID のペア。環境ごとに 1 組だけ持つ。 */
export interface LineEnvProfile {
  readonly env: AppEnvName;
  readonly liffId: string;
  readonly loginChannelId: string;
}

/** バージョン付きの PEPPER。 */
export interface PepperVersion {
  readonly version: number;
  readonly value: string;
}

/** `kid` 付きのセッション署名鍵。 */
export interface SessionKey {
  readonly kid: string;
  readonly value: string;
}

export interface AppConfig {
  readonly appEnv: AppEnvName;
  readonly line: LineEnvProfile;
  /** バージョン降順。`[0]` が現行。 */
  readonly peppers: readonly PepperVersion[];
  /** 記載順。`[0]` が現行、`[1]` があれば直前の 1 世代。 */
  readonly sessionKeys: readonly SessionKey[];
  /** cron の許容シークレット一覧。cron Worker は先頭値を送る（§7-7）。 */
  readonly cronSecrets: readonly string[];
  /** `development` では null。 */
  readonly supabaseProjectRef: string | null;
}

/** 設定不備。`message` に秘密値を含めない。 */
export class EnvConfigError extends Error {
  public readonly code = "env_config_error";

  public constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

/** `loadAppConfig` が読む生の環境。Workers の `env` も `process.env` もこの形に写る。 */
export interface RawEnv {
  readonly APP_ENV?: string | undefined;
  readonly LINE_ENV_PROFILE?: string | undefined;
  readonly PEPPER?: string | undefined;
  readonly SESSION_KEYS?: string | undefined;
  readonly CRON_SECRETS?: string | undefined;
  readonly SUPABASE_PROJECT_REF?: string | undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function requirePresent(raw: string | undefined, name: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new EnvConfigError(`${name} is not set`);
  }
  return raw.trim();
}

function requireSecretLength(value: string, name: string): void {
  const length = byteLength(value);
  if (length < MIN_SECRET_BYTES) {
    // 長さは出す（運用者が直せる情報）。値は出さない。
    throw new EnvConfigError(
      `${name} must be at least ${MIN_SECRET_BYTES} bytes, got ${length} bytes`,
    );
  }
}

function parseAppEnv(raw: string | undefined): AppEnvName {
  const value = requirePresent(raw, "APP_ENV");
  const found = APP_ENV_NAMES.find((name) => name === value);
  if (found === undefined) {
    throw new EnvConfigError(
      `APP_ENV must be one of ${APP_ENV_NAMES.join(" / ")}, got '${value}'`,
    );
  }
  return found;
}

/**
 * `LINE_ENV_PROFILE` は JSON 1 個で持つ。
 * `{"env":"staging","liffId":"1234567890-abcdEFGH","loginChannelId":"1234567890"}`
 *
 * 環境ごとに別々の変数（`LIFF_ID_STAGING` 等）に散らすと、1 つだけ差し替え忘れる事故
 * （R-LINE-04）が起きる。ペアで 1 つの値にしておけば、差し替えは常に全体の置き換えになる。
 */
function parseLineEnvProfile(raw: string | undefined, appEnv: AppEnvName): LineEnvProfile {
  const text = requirePresent(raw, "LINE_ENV_PROFILE");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 中身は出さない（LIFF ID 自体は秘密ではないが、壊れた JSON に何が混ざっているか分からない）。
    throw new EnvConfigError("LINE_ENV_PROFILE is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvConfigError("LINE_ENV_PROFILE must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  const env = record["env"];
  const liffId = record["liffId"];
  const loginChannelId = record["loginChannelId"];

  if (typeof env !== "string" || typeof liffId !== "string" || typeof loginChannelId !== "string") {
    throw new EnvConfigError(
      "LINE_ENV_PROFILE must have string fields: env, liffId, loginChannelId",
    );
  }

  const profileEnv = APP_ENV_NAMES.find((name) => name === env);
  if (profileEnv === undefined) {
    throw new EnvConfigError(
      `LINE_ENV_PROFILE.env must be one of ${APP_ENV_NAMES.join(" / ")}, got '${env}'`,
    );
  }

  // ★ R-LINE-04: 環境の取り違えはここで落とす。
  if (profileEnv !== appEnv) {
    throw new EnvConfigError(
      `LINE_ENV_PROFILE.env ('${profileEnv}') does not match APP_ENV ('${appEnv}')`,
    );
  }

  const liffMatch = LIFF_ID_RE.exec(liffId);
  if (liffMatch === null) {
    throw new EnvConfigError(
      "LINE_ENV_PROFILE.liffId must look like '<10-digit channel id>-<8 chars>'",
    );
  }
  if (!CHANNEL_ID_RE.test(loginChannelId)) {
    throw new EnvConfigError("LINE_ENV_PROFILE.loginChannelId must be a 10-digit channel id");
  }

  // ★ N3: `client_id` に入れるのは LINE Login チャネル ID であって
  //   LIFF ID でも Messaging API チャネル ID でもない。LIFF ID は
  //   `<LINE Login チャネル ID>-<8 文字>` なので、ハイフン前と一致していなければ
  //   どちらかに別チャネルの ID が入っている。
  const channelIdInLiffId = liffMatch[1];
  if (channelIdInLiffId !== loginChannelId) {
    throw new EnvConfigError(
      "LINE_ENV_PROFILE.loginChannelId must equal the channel id embedded in liffId " +
        "(a LIFF ID is '<login channel id>-<8 chars>'; a mismatch means a Messaging API " +
        "channel id or another channel's id was used)",
    );
  }

  return { env: profileEnv, liffId, loginChannelId };
}

/**
 * `PEPPER` は `"<version>:<secret>"` をカンマ区切りで並べる。
 * 例: `PEPPER="1:<32 バイト以上>,2:<32 バイト以上>"`
 *
 * バージョン番号を必須にするのは、`app_user.pepper_version` と 1 対 1 で対応させるため。
 * 番号なしの単一値を許すと、移行のときに「どの行がどの鍵で作られたか」が失われる（R-SEC-09）。
 * 現行は**最大のバージョン番号**の鍵。
 */
function parsePeppers(raw: string | undefined): readonly PepperVersion[] {
  const text = requirePresent(raw, "PEPPER");
  const entries = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (entries.length === 0) {
    throw new EnvConfigError("PEPPER is not set");
  }

  const peppers: PepperVersion[] = [];
  const seen = new Set<number>();

  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new EnvConfigError("PEPPER entries must look like '<version>:<secret>'");
    }
    const versionText = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!/^\d+$/.test(versionText)) {
      throw new EnvConfigError("PEPPER entry version must be a positive integer");
    }
    const version = Number.parseInt(versionText, 10);
    if (version <= 0) {
      throw new EnvConfigError("PEPPER entry version must be a positive integer");
    }
    if (seen.has(version)) {
      throw new EnvConfigError(`PEPPER has duplicate version ${version}`);
    }
    seen.add(version);
    requireSecretLength(value, `PEPPER version ${version}`);
    peppers.push({ version, value });
  }

  // 降順（`[0]` が現行）。
  peppers.sort((a, b) => b.version - a.version);
  return peppers;
}

/**
 * `SESSION_KEYS` は `"<kid>:<secret>"` をカンマ区切りで並べる。**先頭が現行**。
 * 例: `SESSION_KEYS="s2026a:<32 バイト以上>,s2025d:<32 バイト以上>"`
 *
 * 2 個までしか許さない（R-SEC-10: 検証は現行＋直前の 2 鍵）。3 個書けると
 * 「2 世代前も通る」実装に静かに滑るため、設定の段階で落とす。
 */
function parseSessionKeys(raw: string | undefined): readonly SessionKey[] {
  const text = requirePresent(raw, "SESSION_KEYS");
  const entries = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (entries.length === 0) {
    throw new EnvConfigError("SESSION_KEYS is not set");
  }
  if (entries.length > MAX_SESSION_KEYS) {
    throw new EnvConfigError(
      `SESSION_KEYS must contain at most ${MAX_SESSION_KEYS} keys (current + previous), got ${entries.length}`,
    );
  }

  const keys: SessionKey[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new EnvConfigError("SESSION_KEYS entries must look like '<kid>:<secret>'");
    }
    const kid = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!KID_RE.test(kid)) {
      throw new EnvConfigError("SESSION_KEYS kid must match [A-Za-z0-9_-]{1,32}");
    }
    if (seen.has(kid)) {
      throw new EnvConfigError(`SESSION_KEYS has duplicate kid '${kid}'`);
    }
    seen.add(kid);
    requireSecretLength(value, `SESSION_KEYS kid '${kid}'`);
    keys.push({ kid, value });
  }

  return keys;
}

/** `CRON_SECRETS` はカンマ区切りの許容リスト。cron Worker は先頭値を送る（§7-7）。 */
function parseCronSecrets(raw: string | undefined): readonly string[] {
  const text = requirePresent(raw, "CRON_SECRETS");
  const secrets = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (secrets.length === 0) {
    throw new EnvConfigError("CRON_SECRETS is not set");
  }
  secrets.forEach((secret, index) => {
    requireSecretLength(secret, `CRON_SECRETS[${index}]`);
  });
  if (new Set(secrets).size !== secrets.length) {
    throw new EnvConfigError("CRON_SECRETS has duplicate entries");
  }
  return secrets;
}

/**
 * `APP_ENV` と Supabase project ref の対応を確かめる（R-SEC-05）。
 *
 * `development` は ローカルの `supabase start` で project ref を持たないため検査しない。
 * `staging` / `production` は `EXPECTED_SUPABASE_PROJECT_REF` と**完全一致**を要求する。
 */
function parseSupabaseProjectRef(raw: string | undefined, appEnv: AppEnvName): string | null {
  const expected = EXPECTED_SUPABASE_PROJECT_REF[appEnv];
  if (expected === null) {
    return null;
  }

  const actual = requirePresent(raw, "SUPABASE_PROJECT_REF");
  if (actual !== expected) {
    // ref は秘密値ではないので、そのまま出したほうが運用者が直せる。
    throw new EnvConfigError(
      `SUPABASE_PROJECT_REF '${actual}' is not the project ref pinned for APP_ENV='${appEnv}' ('${expected}')`,
    );
  }
  if (!PROJECT_REF_RE.test(actual)) {
    throw new EnvConfigError(
      `SUPABASE_PROJECT_REF '${actual}' is not a valid Supabase project ref ` +
        `(20 lowercase letters). The value pinned in EXPECTED_SUPABASE_PROJECT_REF for ` +
        `APP_ENV='${appEnv}' is still a placeholder — filling it in is task_035 (staging) / task_024 (production).`,
    );
  }
  return actual;
}

/**
 * 設定を読み、不備があれば `EnvConfigError` を投げる。
 *
 * ★ 例外を握りつぶして既定値で続行しない。呼び出し側は起動を諦めること。
 */
export function loadAppConfig(raw: RawEnv): AppConfig {
  const appEnv = parseAppEnv(raw.APP_ENV);
  const line = parseLineEnvProfile(raw.LINE_ENV_PROFILE, appEnv);
  const peppers = parsePeppers(raw.PEPPER);
  const sessionKeys = parseSessionKeys(raw.SESSION_KEYS);
  const cronSecrets = parseCronSecrets(raw.CRON_SECRETS);
  const supabaseProjectRef = parseSupabaseProjectRef(raw.SUPABASE_PROJECT_REF, appEnv);

  return { appEnv, line, peppers, sessionKeys, cronSecrets, supabaseProjectRef };
}

/** 現行の PEPPER（最大バージョン）。 */
export function currentPepper(config: AppConfig): PepperVersion {
  const [current] = config.peppers;
  if (current === undefined) {
    // parsePeppers が空を通さないので到達しないが、型の穴を塞いでおく。
    throw new EnvConfigError("PEPPER is not set");
  }
  return current;
}

/** 現行のセッション署名鍵（先頭）。 */
export function currentSessionKey(config: AppConfig): SessionKey {
  const [current] = config.sessionKeys;
  if (current === undefined) {
    throw new EnvConfigError("SESSION_KEYS is not set");
  }
  return current;
}

/** 指定バージョンの PEPPER。無ければ undefined（旧行の移行元が消えている状態）。 */
export function pepperByVersion(config: AppConfig, version: number): PepperVersion | undefined {
  return config.peppers.find((pepper) => pepper.version === version);
}

/** 指定 kid のセッション鍵。無ければ undefined（2 世代前 = 検証不可）。 */
export function sessionKeyByKid(config: AppConfig, kid: string): SessionKey | undefined {
  return config.sessionKeys.find((key) => key.kid === kid);
}

/**
 * fingerprint（SHA-256 の先頭 16 hex）。
 *
 * 用途は「3 環境で期待どおりに一致・相違することを外形から確かめる」こと（check_074 / check_076）。
 * 秘密値そのものは復元できず、同じ値なら同じ fingerprint になる。
 * ラベルでドメイン分離しておき、別種の値が偶然同じ fingerprint を持つ紛らわしさを避ける。
 */
export async function fingerprint(label: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${label}:${value}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export interface ConfigFingerprints {
  readonly pepperFingerprint: string;
  readonly pepperVersion: number;
  readonly liffIdFingerprint: string;
  readonly channelIdFingerprint: string;
}

/** `/api/health` が返す fingerprint 一式。 */
export async function configFingerprints(config: AppConfig): Promise<ConfigFingerprints> {
  const pepper = currentPepper(config);
  const [pepperFingerprint, liffIdFingerprint, channelIdFingerprint] = await Promise.all([
    fingerprint("pepper", pepper.value),
    fingerprint("liffId", config.line.liffId),
    fingerprint("loginChannelId", config.line.loginChannelId),
  ]);
  return {
    pepperFingerprint,
    pepperVersion: pepper.version,
    liffIdFingerprint,
    channelIdFingerprint,
  };
}
