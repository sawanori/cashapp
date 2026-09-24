// GET /api/health — task_003 では静的 ok を返すのみ。
// DB 疎通・reconcile 鮮度・outbox 滞留・直近 Webhook 受信を見て degraded を返す
// 拡張は task_023（§7-7 外形監視）で行う。
export async function GET(): Promise<Response> {
  return Response.json({ status: "ok" });
}
