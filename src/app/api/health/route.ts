// GET /api/health — 外形監視の入口（§7-7 / §9）。
//
// task_012 で追加したのは「環境設定の fingerprint」だけである（check_074 / check_076）:
//   pepperFingerprint / liffIdFingerprint / channelIdFingerprint。
// 3 環境でこれらが期待どおりに一致・相違することを外から確かめられるようにする。
// 値そのものは復元できない（SHA-256 の先頭 16 hex）。
//
// DB 疎通・reconcile 鮮度・outbox 滞留・直近 Webhook 受信を見た degraded 判定は task_023。
//
// ★ 設定が不正なら 503 + status="degraded" を返す。ここで 200 を返してしまうと
//   「設定が壊れた本番」を外形監視が正常と報告することになる（R-SEC-05 / R-LINE-04）。
//   ★ 例外の内容はボディに出さない。出すのは code だけ。

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { configFingerprints, loadAppConfig, type RawEnv } from "@/lib/config/env";

export async function GET(): Promise<Response> {
  let env: RawEnv;
  try {
    const context = await getCloudflareContext({ async: true });
    env = context.env as unknown as RawEnv;
  } catch {
    // ローカルの `next dev` で platform proxy が立ち上がっていない等。
    env = process.env as unknown as RawEnv;
  }

  try {
    const config = loadAppConfig(env);
    const fingerprints = await configFingerprints(config);
    return Response.json(
      {
        status: "ok",
        appEnv: config.appEnv,
        pepperVersion: fingerprints.pepperVersion,
        pepperFingerprint: fingerprints.pepperFingerprint,
        liffIdFingerprint: fingerprints.liffIdFingerprint,
        channelIdFingerprint: fingerprints.channelIdFingerprint,
      },
      { status: 200 },
    );
  } catch {
    return Response.json({ status: "degraded", code: "CONFIG_INVALID" }, { status: 503 });
  }
}
