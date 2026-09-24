/**
 * workers/cron — Cron Triggers 専用 Worker（雛形。§7-7）
 *
 * この Worker 自体は状態を持たない。Cloudflare Cron Triggers に叩かれたら、
 * 対応する本体（メインアプリ Worker）の `/api/cron/*` ルートへ HTTP で通知するだけ。
 * 実際の照合・outbox 配送・保持期限処理・監査検証のロジックは本体側（task_012/018/021）。
 *
 * 認可: `CRON_SECRETS`（カンマ区切りの許容リスト。本 Worker はそのうち先頭の値を送る。
 * 本体側は許容リストのどれかに一致すれば受理する運用を想定）を `X-Cron-Secret` ヘッダで送る。
 * ヘッダ名・POST 採用は本タスク（task_003）での暫定設計。本体側の実装（task_012）で
 * 固まった規約と食い違いがあれば、この Worker 側を合わせる。
 */

export interface Env {
  /** 本体（メインアプリ）Worker のベース URL。環境ごとに wrangler.toml の [env.*.vars] で切り替える */
  readonly APP_BASE_URL: string;
  /** カンマ区切りの許容シークレットリスト。`wrangler secret put CRON_SECRETS` で投入する */
  readonly CRON_SECRETS?: string;
}

interface CronRoute {
  readonly cron: string;
  readonly path: string;
}

// wrangler.toml の [triggers] crons と 1:1 で対応させること。
// パス一覧は src/lib/cron-auth.ts の CRON_PATHS と一致していなければならない
// （tests/unit/cron-auth.test.ts が三者一致を機械検査する）。
export const CRON_ROUTES: readonly CronRoute[] = [
  { cron: "*/5 * * * *", path: "/api/cron/reconcile" },
  { cron: "* * * * *", path: "/api/cron/outbox" },
  { cron: "*/10 * * * *", path: "/api/cron/apply-pending" },
  { cron: "0 19 * * *", path: "/api/cron/retention" }, // JST 04:00
  { cron: "10 19 * * *", path: "/api/cron/idempotency-cleanup" }, // JST 04:10
  { cron: "20 19 * * *", path: "/api/cron/audit-verify" }, // JST 04:20
];

function resolveRoute(cron: string): CronRoute | undefined {
  return CRON_ROUTES.find((route) => route.cron === cron);
}

async function callCronRoute(route: CronRoute, env: Env): Promise<void> {
  const secret = env.CRON_SECRETS?.split(",")[0]?.trim();
  if (!secret) {
    console.error("workers/cron: CRON_SECRETS is not configured, skipping", route.path);
    return;
  }

  const target = new URL(route.path, env.APP_BASE_URL);
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "X-Cron-Secret": secret },
    });
    // ★ 1 発火につき 1 行。`wrangler dev --test-scheduled` での疎通確認（task_020 の
    //   done_definition）はこの行を数える。シークレットは出さない。
    console.log(`workers/cron: fetched ${route.path} cron="${route.cron}" status=${res.status}`);
    if (!res.ok) {
      console.error(`workers/cron: ${route.path} responded ${res.status}`);
    }
  } catch (err) {
    console.error(`workers/cron: ${route.path} fetch failed`, err);
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const route = resolveRoute(event.cron);
    if (!route) {
      console.error(`workers/cron: unrecognized cron pattern: ${event.cron}`);
      return;
    }
    ctx.waitUntil(callCronRoute(route, env));
  },

  // Cron Triggers を GET で手動テストできるように、fetch ハンドラでも同じ一覧を返す
  // （本体を叩くわけではなく、この Worker 自身の設定確認用）。
  async fetch(): Promise<Response> {
    return new Response(
      JSON.stringify({ routes: CRON_ROUTES.map((r) => ({ cron: r.cron, path: r.path })) }),
      { headers: { "content-type": "application/json" } },
    );
  },
} satisfies ExportedHandler<Env>;
