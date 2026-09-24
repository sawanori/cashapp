/**
 * アプリ層のレート制限（`/api/auth/line` の IP 単位。R-SEC-08 / A27）。
 *
 * ★ **アイソレート内メモリ（`Map`）をカウンタに使わない。**
 *   Cloudflare Workers はアイソレート間でメモリを共有しないため、`Map` のカウンタは
 *   本番で「掛かっているつもりで掛かっていない」になる（§7-2 / R-SEC-02）。
 *   このモジュールは in-memory のカウンタを一切持たない。
 *
 * ★ バックエンドは 2 つだけ。
 *   1. **Workers の Rate Limiting バインディング**（第一候補）。
 *      `env.<BINDING>.limit({ key })` → `{ success }`。
 *      拠点ごとに別カウンタ・結果整合であることは一次資料に明記がある
 *      （`docs/vendor-docs/cloudflare/rate-limiting.md` §3）。乱打の大半はここで落ちる。
 *   2. **Durable Object を 1 個**（厳密なカウントが要るとき）。固定ウィンドウのカウンタを
 *      DO のストレージに持つ。1 キー = 1 オブジェクトなので全球で 1 本になる。
 *
 * ★ どちらも束縛されていない場合は **通さない**（fail-closed）。
 *   「制限が無い状態で開いている」より「認証が受け付けられない」ほうが安全側である。
 *   ローカル開発のための逃げ道は 1 つだけ用意し、`src/lib/db/client.ts` の
 *   `ALLOW_PRIVILEGED_DB_ROLE` と同じ多重条件にする（下記 `isLocalBypass`）。
 */

import "server-only";

/** Rate Limiting バインディングのうち、本モジュールが使う部分だけを写した型。 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Durable Object の namespace のうち、本モジュールが使う部分だけを写した型。 */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** Durable Object の `state` のうち、本モジュールが使う部分だけを写した型。 */
export interface DurableObjectStateLike {
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

export type RateLimitBackend =
  | "workers-rate-limit-binding"
  | "durable-object"
  | "local-dev-bypass";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly backend: RateLimitBackend;
}

/** バックエンドがひとつも束縛されていない。呼び出し側は 503 を返すこと。 */
export class RateLimiterUnavailableError extends Error {
  public readonly code = "rate_limiter_unavailable";

  public constructor() {
    super(
      "no rate limiting backend is bound: bind a Workers Rate Limiting namespace " +
        "or a Durable Object namespace (in-memory counters are not allowed)",
    );
    this.name = "RateLimiterUnavailableError";
  }
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitDecision>;
}

/** 固定ウィンドウの既定値。Rate Limiting バインディングの period は 10 か 60 しか取れない。 */
export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;
export const AUTH_RATE_LIMIT_MAX_REQUESTS = 20;

/** `resolveRateLimiter` が読むバインディング一式。 */
export interface RateLimitEnv {
  /** wrangler.toml の `[[ratelimits]] name = "AUTH_RATE_LIMITER"`（task_024 / task_035 で追加）。 */
  readonly AUTH_RATE_LIMITER?: RateLimitBinding | undefined;
  /** Rate Limiting バインディングが使えない場合の Durable Object namespace。 */
  readonly AUTH_RATE_LIMITER_DO?: DurableObjectNamespaceLike | undefined;
  readonly APP_ENV?: string | undefined;
  /** ローカル開発専用の opt-in。`.env.local` にだけ置く（`.env.example` の local 節を参照）。 */
  readonly ALLOW_LOCAL_RATE_LIMIT_BYPASS?: string | undefined;
  /** Workers ランタイムでのみ存在する。ローカル判定に使う（値は読まない）。 */
  readonly HYPERDRIVE?: unknown;
}

/**
 * ローカル開発の逃げ道。次の 3 条件が**すべて**成立するときだけ true。
 *
 *   1. `ALLOW_LOCAL_RATE_LIMIT_BYPASS` が厳密に `"1"`
 *   2. `APP_ENV` が厳密に `"development"`
 *   3. Hyperdrive バインディングが**無い**（＝デプロイ済み Worker として動いていない）
 *
 * 3 を入れる理由は `src/lib/db/client.ts` と同じである。`wrangler.toml` の既定環境
 * （`name = "cashapp-dev"`）はデプロイ可能で `[vars] APP_ENV = "development"` を持つため、
 * `APP_ENV` だけでは「ローカルに限る」条件にならない（task_011 のレビューで判明した穴）。
 */
function isLocalBypass(env: RateLimitEnv): boolean {
  if (env.ALLOW_LOCAL_RATE_LIMIT_BYPASS !== "1") return false;
  if (env.APP_ENV !== "development") return false;
  return env.HYPERDRIVE === undefined || env.HYPERDRIVE === null;
}

/** Durable Object へ投げる 1 リクエスト分のパス。 */
export const RATE_LIMIT_DO_PATH = "/limit";

function bindingLimiter(binding: RateLimitBinding): RateLimiter {
  return {
    async check(key: string): Promise<RateLimitDecision> {
      const { success } = await binding.limit({ key });
      return { allowed: success === true, backend: "workers-rate-limit-binding" };
    },
  };
}

function durableObjectLimiter(namespace: DurableObjectNamespaceLike): RateLimiter {
  return {
    async check(key: string): Promise<RateLimitDecision> {
      const stub = namespace.get(namespace.idFromName(key));
      const response = await stub.fetch(
        new Request(`https://rate-limiter.invalid${RATE_LIMIT_DO_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key,
            limit: AUTH_RATE_LIMIT_MAX_REQUESTS,
            windowSeconds: AUTH_RATE_LIMIT_WINDOW_SECONDS,
          }),
        }),
      );
      if (!response.ok) {
        // DO が落ちているときに素通りさせない。
        return { allowed: false, backend: "durable-object" };
      }
      const body = (await response.json()) as { allowed?: unknown };
      return { allowed: body.allowed === true, backend: "durable-object" };
    },
  };
}

/**
 * 使えるバックエンドを 1 つ選ぶ。どれも無ければ `RateLimiterUnavailableError`。
 * 呼び出し側はこの例外を 503 `RATE_LIMIT_UNAVAILABLE` に写すこと。
 */
export function resolveRateLimiter(env: RateLimitEnv): RateLimiter {
  if (env.AUTH_RATE_LIMITER !== undefined && env.AUTH_RATE_LIMITER !== null) {
    return bindingLimiter(env.AUTH_RATE_LIMITER);
  }
  if (env.AUTH_RATE_LIMITER_DO !== undefined && env.AUTH_RATE_LIMITER_DO !== null) {
    return durableObjectLimiter(env.AUTH_RATE_LIMITER_DO);
  }
  if (isLocalBypass(env)) {
    return {
      async check(): Promise<RateLimitDecision> {
        return { allowed: true, backend: "local-dev-bypass" };
      },
    };
  }
  throw new RateLimiterUnavailableError();
}

interface WindowState {
  readonly windowStartedAtMs: number;
  readonly count: number;
}

/**
 * 固定ウィンドウのカウンタを持つ Durable Object。
 *
 * `cloudflare:workers` を import せずに書いてある（`DurableObjectStateLike` で受ける）ので、
 * ユニットテストから素の JS オブジェクトを渡して挙動を確かめられる。
 * wrangler.toml への `[[durable_objects]]` バインディング追加と `migrations` は
 * Cloudflare アカウントが作られてから（task_024 / task_035）。
 */
export class FixedWindowRateLimiterDurableObject {
  readonly #state: DurableObjectStateLike;
  readonly #now: () => number;

  public constructor(state: DurableObjectStateLike, now: () => number = Date.now) {
    this.#state = state;
    this.#now = now;
  }

  public async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      key?: unknown;
      limit?: unknown;
      windowSeconds?: unknown;
    };
    const limit = typeof body.limit === "number" ? body.limit : AUTH_RATE_LIMIT_MAX_REQUESTS;
    const windowSeconds =
      typeof body.windowSeconds === "number" ? body.windowSeconds : AUTH_RATE_LIMIT_WINDOW_SECONDS;

    const nowMs = this.#now();
    const previous = await this.#state.storage.get<WindowState>("window");
    const windowMs = windowSeconds * 1000;

    const fresh =
      previous === undefined || nowMs - previous.windowStartedAtMs >= windowMs
        ? { windowStartedAtMs: nowMs, count: 0 }
        : previous;

    const next: WindowState = { windowStartedAtMs: fresh.windowStartedAtMs, count: fresh.count + 1 };
    await this.#state.storage.put<WindowState>("window", next);

    return Response.json({ allowed: next.count <= limit, count: next.count });
  }
}
