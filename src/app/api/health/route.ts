// GET /api/health — 外形監視の入口（§7-7 / §9）。
//
// task_012 で追加したのは「環境設定の fingerprint」だけである（check_074 / check_076）:
//   pepperFingerprint / liffIdFingerprint / channelIdFingerprint。
// 3 環境でこれらが期待どおりに一致・相違することを外から確かめられるようにする。
// 値そのものは復元できない（SHA-256 の先頭 16 hex）。
//
// task_023 で追加したのは DB 側の degraded 判定（DB 疎通・reconcile 鮮度・outbox 滞留・
// 直近 Webhook 受信。§17-6 の閾値）。判定ロジック本体は src/lib/health.ts（check_114）。
// 幹事への Messaging API 通知（outbox の配達）は ADR-007 の PO 決定と task_018 / task_020 の
// 着地待ちのため本タスクでは未着手（docs/concerns/task_023.md §1〜§3）。
//
// ★ 設定が不正なら 503 + status="degraded" を返す。ここで 200 を返してしまうと
//   「設定が壊れた本番」を外形監視が正常と報告することになる（R-SEC-05 / R-LINE-04）。
//   ★ 例外の内容はボディに出さない。出すのは code だけ（DB 側の degraded 理由も同様、
//     どの条件で degraded になったかは外に出さない）。

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { configFingerprints, loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { assessDbHealth, createSqlHealthReader } from "@/lib/health";

type RouteEnv = RawEnv & DbEnv;

export async function GET(): Promise<Response> {
  let env: RouteEnv;
  try {
    const context = await getCloudflareContext({ async: true });
    env = context.env as unknown as RouteEnv;
  } catch {
    // ローカルの `next dev` で platform proxy が立ち上がっていない等。
    env = process.env as unknown as RouteEnv;
  }

  // ★ 設定検査は DB に触れる前に単独で行う。既存の CONFIG_INVALID 経路（と、それを見る
  //   既存テスト）が DB へ到達しないことを維持するため（tests/unit/auth/line-route.test.ts の
  //   F-2 と同じ「先にガードで落ちる経路は DB に到達しない」方針）。
  let config: ReturnType<typeof loadAppConfig>;
  try {
    config = loadAppConfig(env);
  } catch {
    return Response.json({ status: "degraded", code: "CONFIG_INVALID" }, { status: 503 });
  }

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    db = await createVerifiedDbClient(env);
    const assessment = await assessDbHealth(createSqlHealthReader(db.sql));
    if (assessment.degraded) {
      return Response.json({ status: "degraded", code: "DEGRADED" }, { status: 503 });
    }

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
    // DB クライアント自体が作れない（接続不可・ロール不一致）場合も、「壊れた本番」を
    // 外形監視が正常と報告することを避けるため degraded 扱いにする。
    return Response.json({ status: "degraded", code: "DEGRADED" }, { status: 503 });
  } finally {
    if (db !== undefined) {
      await db.close().catch(() => undefined);
    }
  }
}
