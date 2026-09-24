/**
 * Webhook の送信元 IP 許可リスト（§9「Webhook 処理手順」①/ R-SEC-11 / check_095）。
 *
 * ★ **許可外は本文を読まず 403**。DB に 1 行も残さない（受信ログすら残さない）。
 *   許可されていない相手にストレージを消費させないための入口防御である。
 *
 * ★ **fail-closed**。許可リストが空・未設定・書式不正のときは**すべて拒否**する。
 *   「設定を忘れたら全通し」は、この防御が最も必要な瞬間（本番投入直後）に穴が開く。
 *
 * ★ 本体の防御は Cloudflare WAF カスタムルール（`infra/waf-rules.json`。task_027）であり、
 *   ここはアプリ側の二重化である。WAF を通り抜けた経路（直叩き・設定ミス）でも止まる。
 *
 * ★ 生 IP はログにも DB にも残さない。残すのは `source_ip_hash`（HMAC）だけ（R-SEC-02）。
 */

import "server-only";

/** 許可規則。IPv4 は CIDR（`/0`〜`/32`）に対応し、IPv6 は完全一致のみ。 */
export type IpRule =
  | { readonly kind: "ipv4"; readonly network: number; readonly maskBits: number }
  | { readonly kind: "exact"; readonly value: string };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(value: string): number | null {
  const m = IPV4_RE.exec(value);
  if (m === null) return null;
  let acc = 0;
  for (let i = 1; i <= 4; i += 1) {
    const part = Number(m[i]);
    if (!Number.isInteger(part) || part < 0 || part > 255) return null;
    acc = acc * 256 + part;
  }
  return acc >>> 0;
}

/**
 * `"203.0.113.0/24, 198.51.100.7"` のような指定を規則に変える。
 * **1 つでも書式が不正なら空配列を返す**（fail-closed。壊れた設定で一部だけ通さない）。
 */
export function parseIpAllowlist(spec: string | undefined | null): readonly IpRule[] {
  if (typeof spec !== "string") return [];
  const entries = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return [];

  const rules: IpRule[] = [];
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    if (slash >= 0) {
      const network = parseIpv4(entry.slice(0, slash));
      const maskBits = Number(entry.slice(slash + 1));
      if (network === null || !Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) {
        return [];
      }
      rules.push({ kind: "ipv4", network, maskBits });
      continue;
    }
    const exact = parseIpv4(entry);
    if (exact !== null) {
      rules.push({ kind: "ipv4", network: exact, maskBits: 32 });
      continue;
    }
    // IPv6 などは完全一致でのみ許可する（正規化はしない。表記ゆれは別エントリで書く）。
    if (/^[0-9A-Fa-f:.]{2,45}$/.test(entry)) {
      rules.push({ kind: "exact", value: entry.toLowerCase() });
      continue;
    }
    return [];
  }
  return rules;
}

/** 規則に合致するか。規則が空、または IP が取れないときは **false**（fail-closed）。 */
export function isIpAllowed(ip: string | null | undefined, rules: readonly IpRule[]): boolean {
  if (rules.length === 0) return false;
  if (typeof ip !== "string" || ip.trim().length === 0) return false;
  const candidate = ip.trim();
  const v4 = parseIpv4(candidate);
  for (const rule of rules) {
    if (rule.kind === "ipv4") {
      if (v4 === null) continue;
      if (rule.maskBits === 0) return true;
      const mask = (0xffffffff << (32 - rule.maskBits)) >>> 0;
      if ((v4 & mask) >>> 0 === (rule.network & mask) >>> 0) return true;
    } else if (rule.value === candidate.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * 送信元 IP を取り出す。Cloudflare では `CF-Connecting-IP` が正であり、
 * `X-Forwarded-For` は**信用しない**（クライアントが自由に付けられる）。
 */
export function sourceIpOf(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip");
  if (cf !== null && cf.trim().length > 0) return cf.trim();
  return null;
}

/**
 * `webhook_delivery.source_ip_hash` / `audit_log.source_ip_hash` に入れる 8 バイト。
 * 生 IP は保存しない（R-SEC-02）。`key` には現行 PEPPER を渡す。
 */
export async function hashSourceIp(ip: string, key: string): Promise<Buffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`ip:${ip}`));
  return Buffer.from(new Uint8Array(mac).slice(0, 8));
}
