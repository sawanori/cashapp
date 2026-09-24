/**
 * `src/lib/security-headers.ts` と `src/middleware.ts` のユニットテスト。
 *
 * done_definition:「全レスポンスに CSP / HSTS / Referrer-Policy が付く」。
 * acceptance-checks check_075（ヘッダ側）、§7-7 の「`/api/webhooks/*` と `/api/cron/*` は
 * `APP_ENV !== 'production'` で無条件 404」。
 * 対応リスク: R-SEC-12 / R-SEC-05。
 */

import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { NextRequest, type NextResponse } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTENT_TYPE_OPTIONS_HEADER,
  CSP_HEADER,
  HSTS_HEADER,
  NONCE_REQUEST_HEADER,
  PRODUCTION_ONLY_PATH_PREFIXES,
  REFERRER_POLICY_HEADER,
  REQUIRED_SECURITY_HEADERS,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  generateNonce,
  isProductionOnlyPath,
} from "@/lib/security-headers";
import { middleware } from "@/middleware";

/**
 * `process.env` は wrangler が生成した型（worker-configuration.d.ts）で
 * `APP_ENV` を列挙型に絞っているため、テストから任意の値を入れるには緩い参照が要る。
 */
const mutableEnv = process.env as unknown as Record<string, string | undefined>;
const ORIGINAL_APP_ENV = mutableEnv["APP_ENV"];

function setAppEnv(value: string | undefined): void {
  if (value === undefined) {
    delete mutableEnv["APP_ENV"];
  } else {
    mutableEnv["APP_ENV"] = value;
  }
}

afterEach(() => {
  setAppEnv(ORIGINAL_APP_ENV);
});

describe("generateNonce", () => {
  it("128 ビットの base64 を返し、毎回変わる", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64").length).toBe(16);
  });
});

describe("buildContentSecurityPolicy", () => {
  const csp = buildContentSecurityPolicy("NONCEVALUE");

  it("script-src は nonce と strict-dynamic のみ（'unsafe-inline' を置かない）", () => {
    expect(csp).toContain("script-src 'nonce-NONCEVALUE' 'strict-dynamic'");
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("object-src / base-uri / frame-ancestors を締めている", () => {
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("nonce が変われば CSP も変わる", () => {
    expect(buildContentSecurityPolicy("A")).not.toBe(buildContentSecurityPolicy("B"));
  });
});

describe("buildSecurityHeaders", () => {
  it("非 development では CSP / HSTS / nosniff / Referrer-Policy が揃う", () => {
    const headers = buildSecurityHeaders({ nonce: "N", appEnv: "production" });
    expect(headers[CSP_HEADER]).toContain("nonce-N");
    expect(headers[HSTS_HEADER]).toBe("max-age=63072000; includeSubDomains; preload");
    expect(headers[CONTENT_TYPE_OPTIONS_HEADER]).toBe("nosniff");
    expect(headers[REFERRER_POLICY_HEADER]).toBe("no-referrer");
  });

  it("staging にも HSTS が付く", () => {
    expect(buildSecurityHeaders({ nonce: "N", appEnv: "staging" })[HSTS_HEADER]).toBeDefined();
  });

  it("development では HSTS を付けない（ローカルの http を壊さない）", () => {
    const headers = buildSecurityHeaders({ nonce: "N", appEnv: "development" });
    expect(headers[HSTS_HEADER]).toBeUndefined();
    expect(headers[CSP_HEADER]).toBeDefined();
    expect(headers[REFERRER_POLICY_HEADER]).toBe("no-referrer");
  });

  it("REQUIRED_SECURITY_HEADERS は必ず出力に含まれる", () => {
    const headers = buildSecurityHeaders({ nonce: "N", appEnv: "production" });
    for (const name of REQUIRED_SECURITY_HEADERS) {
      expect(headers[name], `${name} must always be present`).toBeDefined();
    }
  });
});

describe("isProductionOnlyPath", () => {
  it.each([
    ["/api/webhooks/paypay/abc", true],
    ["/api/cron/reconcile", true],
    ["/api/cron/outbox", true],
    ["/api/auth/line", false],
    ["/api/health", false],
    ["/", false],
  ])("%s → %s", (pathname, expected) => {
    expect(isProductionOnlyPath(pathname)).toBe(expected);
  });

  it("対象は webhook と cron の 2 つだけ", () => {
    expect([...PRODUCTION_ONLY_PATH_PREFIXES].sort()).toEqual(["/api/cron/", "/api/webhooks/"]);
  });
});

function requestFor(pathname: string): NextRequest {
  return new NextRequest(new Request(`https://example.test${pathname}`));
}

describe("middleware", () => {
  it("通常の経路には全ヘッダが付く（production）", () => {
    setAppEnv("production");
    const response = middleware(requestFor("/api/health"));
    expect(response.status).toBe(200);
    for (const name of [...REQUIRED_SECURITY_HEADERS, HSTS_HEADER]) {
      expect(response.headers.get(name), `${name} must be set`).not.toBeNull();
    }
    expect(response.headers.get(CSP_HEADER)).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("nonce はリクエストごとに変わる", () => {
    setAppEnv("production");
    const first = middleware(requestFor("/")).headers.get(CSP_HEADER);
    const second = middleware(requestFor("/")).headers.get(CSP_HEADER);
    expect(first).not.toBe(second);
  });

  it("クライアントが投げた nonce ヘッダは上書きされる", () => {
    setAppEnv("production");
    const request = new NextRequest(
      new Request("https://example.test/", {
        headers: { [NONCE_REQUEST_HEADER]: "attacker-controlled" },
      }),
    );
    const response = middleware(request);
    expect(response.headers.get(CSP_HEADER)).not.toContain("attacker-controlled");
  });

  it.each([["development"], ["staging"], ["unknown"]])(
    "APP_ENV=%s では /api/webhooks/* が 404",
    (appEnv) => {
      setAppEnv(appEnv);
      const response = middleware(requestFor("/api/webhooks/paypay/binding-1"));
      expect(response.status).toBe(404);
      for (const name of REQUIRED_SECURITY_HEADERS) {
        expect(response.headers.get(name)).not.toBeNull();
      }
    },
  );

  it.each([["development"], ["staging"]])("APP_ENV=%s では /api/cron/* が 404", (appEnv) => {
    setAppEnv(appEnv);
    expect(middleware(requestFor("/api/cron/reconcile")).status).toBe(404);
  });

  it("APP_ENV が未設定でも 404 側に倒れる（fail-safe）", () => {
    setAppEnv(undefined);
    expect(middleware(requestFor("/api/cron/reconcile")).status).toBe(404);
  });

  it("APP_ENV=production なら webhook / cron は通す（404 にしない）", () => {
    setAppEnv("production");
    expect(middleware(requestFor("/api/webhooks/paypay/binding-1")).status).toBe(200);
    expect(middleware(requestFor("/api/cron/reconcile")).status).toBe(200);
  });
});

/**
 * nonce CSP が**実際に機能する**ことの検査（レビュー指摘 high の再発防止）。
 *
 * ヘッダ文字列の比較だけでは足りない。Next.js が自前の `<script>`
 * （ブートストラップと `self.__next_f` のインラインデータ）へ nonce を付ける経路は
 * **リクエストヘッダの `Content-Security-Policy` を読む 1 本だけ**で、
 * `x-csp-nonce` のような独自ヘッダは見ない。
 * レスポンスにだけ CSP を載せると、配信される CSP は nonce を要求するのに
 * script に nonce が付かず、ブラウザがアプリの JS を全部ブロックする。
 *
 * ここでは Next.js 自身の抽出関数（`getScriptNonceFromHeader`）に、middleware が
 * リクエスト側へ載せた CSP をそのまま食わせて、nonce が取り出せることを確かめる。
 * 自前の再実装で照合すると Next の実装が変わったときに気づけないので、
 * わざと Next の関数を直接呼ぶ（import が壊れたら、それ自体が伝播経路の変更の合図になる）。
 */
describe("middleware の nonce が Next.js のレンダリング経路へ届く", () => {
  /**
   * `NextResponse.next({ request: { headers } })` は上書きしたリクエストヘッダを
   * `x-middleware-request-<name>` と `x-middleware-override-headers` に畳んで返す
   * （node_modules/next/dist/server/web/spec-extension/response.js の handleMiddlewareField）。
   * Next のサーバはこれを解いてから app-render に渡すため、ここを読めば
   * 「レンダラが受け取るリクエストヘッダ」を検査できる。
   */
  function overriddenRequestHeaders(response: NextResponse): Map<string, string> {
    const keys = response.headers.get("x-middleware-override-headers");
    const out = new Map<string, string>();
    if (keys === null) return out;
    for (const key of keys.split(",")) {
      const value = response.headers.get(`x-middleware-request-${key}`);
      if (value !== null) out.set(key, value);
    }
    return out;
  }

  /** リクエスト側へ載った CSP。無ければ（＝伝播経路が壊れていれば）その場で落とす。 */
  function requestCspOf(response: NextResponse): string {
    const csp = overriddenRequestHeaders(response).get(CSP_HEADER.toLowerCase());
    if (csp === undefined) {
      throw new Error(
        "middleware did not put Content-Security-Policy on the request headers — " +
          "Next.js cannot attach a nonce to its own <script> tags without it",
      );
    }
    return csp;
  }

  /** Next.js 自身の抽出関数で nonce を取り出す。取れなければ落とす。 */
  function nonceOf(csp: string): string {
    const nonce = getScriptNonceFromHeader(csp);
    if (nonce === undefined) {
      throw new Error(`Next.js could not extract a nonce from: ${csp}`);
    }
    return nonce;
  }

  it("リクエストヘッダにも CSP が載る（Next の nonce 伝播の唯一の入口）", () => {
    setAppEnv("production");
    const requestCsp = requestCspOf(middleware(requestFor("/")));
    expect(requestCsp).toContain("script-src 'nonce-");
    expect(requestCsp).toContain("'strict-dynamic'");
  });

  it("Next.js 自身の抽出関数がリクエスト側 CSP から nonce を取り出せる", () => {
    setAppEnv("production");
    const nonce = nonceOf(requestCspOf(middleware(requestFor("/"))));
    expect(nonce.length).toBeGreaterThan(0);
  });

  it("リクエスト側の CSP と、配信される CSP が同一である", () => {
    setAppEnv("production");
    const response = middleware(requestFor("/"));
    const requestCsp = requestCspOf(response);
    const responseCsp = response.headers.get(CSP_HEADER);
    expect(requestCsp).toBe(responseCsp);
    expect(responseCsp).not.toBeNull();
    expect(nonceOf(requestCsp)).toBe(nonceOf(responseCsp ?? ""));
  });

  it("クライアントが送りつけた CSP ヘッダは上書きされる", () => {
    setAppEnv("production");
    const request = new NextRequest(
      new Request("https://example.test/", {
        headers: { [CSP_HEADER]: "script-src 'nonce-attackerchosen'" },
      }),
    );
    const requestCsp = requestCspOf(middleware(request));
    expect(requestCsp).not.toContain("attackerchosen");
    expect(nonceOf(requestCsp)).not.toBe("attackerchosen");
  });

  it("nonce はリクエストごとに変わる（リクエスト側でも）", () => {
    setAppEnv("production");
    const first = nonceOf(requestCspOf(middleware(requestFor("/"))));
    const second = nonceOf(requestCspOf(middleware(requestFor("/"))));
    expect(first).not.toBe(second);
  });

  it("nonce は Next の CSP_NONCE_SOURCE_REGEX に通る 128 ビット base64 である", () => {
    setAppEnv("production");
    const nonce = nonceOf(requestCspOf(middleware(requestFor("/"))));
    // Next の CSP_NONCE_SOURCE_REGEX は [A-Za-z0-9+/_-]+={0,2} しか受け付けない。
    expect(nonce).toMatch(/^[A-Za-z0-9+/_-]+={0,2}$/);
    expect(Buffer.from(nonce, "base64").length).toBe(16);
  });

  it("404 側（非 production の webhook / cron）はレンダリングしないので CSP はレスポンスだけでよい", () => {
    setAppEnv("staging");
    const response = middleware(requestFor("/api/cron/reconcile"));
    expect(response.status).toBe(404);
    expect(response.headers.get(CSP_HEADER)).toContain("script-src 'nonce-");
  });
});
