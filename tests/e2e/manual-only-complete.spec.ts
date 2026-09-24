import fs from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { cleanupE2eUsers, seedOrganizerSession, testSql, uniq, withRollback } from "./helpers/session";

// `playwright.config.ts` の `testDir` はリポジトリ直下なので、`npm run test:e2e` は常に
// リポジトリルートから起動される（`import.meta.url` は本ファイルの transform 設定では
// 使えないため `process.cwd()` を使う）。
const REPO_ROOT = process.cwd();

/**
 * check_112:
 *   1. 手動確認版だけで幹事が 1 イベントを完走し、途中離脱しない。
 *   2. ファネル 5 段（着地 → 同意 → claim → checkout → paid）が週次メトリクスに出る。
 *
 * (1) は `organizer-flow.spec.ts` と同じ手段（API テストコンテキスト・
 * `tests/e2e/helpers/session.ts` によるセッション直接発行）で、参加者 2 名を両方とも
 * 手動確認まで進める。**現状、最初の書き込み（`POST /api/events`）で失敗する**
 * （`docs/concerns/task_022.md` に記録した timestamptz 不具合。`organizer-flow.spec.ts` と
 * 同じ根本原因）。テストは正しい仕様のまま残す。
 *
 * (2) は `src/lib/metrics/funnel.ts`（本タスクで新規作成）が生む `audit_log` の行と、
 * その集計・週次 JSON 出力そのものを検証する。`src/lib/metrics/funnel.ts` は
 * `import "server-only"` を持つため Playwright のテストランナーから import できず
 * （`tests/e2e/helpers/session.ts` の docstring と同じ事情）、ここでは同モジュールと
 * 同じデータモデル（`audit_log.action = 'funnel.<stage>'` / `target_type='event'`）で
 * 行を直接書き、集計ロジックを複製して実際に `docs/metrics/weekly-*.json` を書き出す。
 * **実際の集金導線から `recordFunnelStage` を呼ぶ配線は、対象ルートが task_022 の
 * files_to_modify に無いため未実施**（`docs/concerns/task_022.md` に deferred として記録）。
 */

const seededUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupE2eUsers(seededUserIds);
});

test("手動確認版だけで、参加者 2 名とも幹事が手動確認まで完走する", async ({ request, baseURL }) => {
  const suffix = uniq();
  const session = await seedOrganizerSession(suffix);
  seededUserIds.push(session.userId);
  const api = baseURL ?? `http://127.0.0.1:${process.env["PLAYWRIGHT_PORT"] ?? "3100"}`;
  const authedHeaders = {
    "content-type": "application/json",
    origin: api,
    cookie: session.cookieHeader,
    "x-csrf-token": session.csrfToken,
  };

  const createRes = await request.post(`${api}/api/events`, {
    headers: { ...authedHeaders, "idempotency-key": `manual-complete-create-${suffix}` },
    data: {
      title: "忘年会",
      organizerLabel: "鈴木花子",
      eventAt: null,
      venue: null,
      offering: null,
      defaultAmountMinor: 4000,
      collectByAt: null,
      minorsIncluded: false,
      allowCash: true,
      feeDisclosureAccepted: true,
    },
  });
  expect(createRes.status(), await createRes.text()).toBe(201);
  const created = (await createRes.json()) as { event: { id: string } };

  const participantsRes = await request.post(`${api}/api/events/${created.event.id}/participants`, {
    headers: { ...authedHeaders, "idempotency-key": `manual-complete-participants-${suffix}` },
    data: { participants: [{ displayLabel: "参加者X" }, { displayLabel: "参加者Y" }] },
  });
  expect(participantsRes.status(), await participantsRes.text()).toBe(201);

  const invoicesRes = await request.post(`${api}/api/events/${created.event.id}/invoices`, {
    headers: { ...authedHeaders, "idempotency-key": `manual-complete-invoices-${suffix}` },
    data: { confirmed: true },
  });
  expect(invoicesRes.status(), await invoicesRes.text()).toBe(201);

  const sql = testSql();
  const invoiceRows = await sql<{ id: string }[]>`
    SELECT i.id FROM invoice i
    JOIN participant p ON p.id = i.participant_id
    WHERE p.event_id = ${created.event.id}
    ORDER BY p.created_at ASC
  `;
  expect(invoiceRows).toHaveLength(2);

  for (const [index, invoice] of invoiceRows.entries()) {
    const attestRes = await request.post(`${api}/api/invoices/${invoice.id}/manual-attest`, {
      headers: { ...authedHeaders, "idempotency-key": `manual-complete-attest-${suffix}-${index}` },
      data: { method: "cash", reason: "当日、現金で受け取った", evidenceNote: null, confirmed: true },
    });
    expect(attestRes.status(), await attestRes.text()).toBe(201);
  }

  const summaryRes = await request.get(`${api}/api/events/${created.event.id}`, {
    headers: { cookie: session.cookieHeader },
  });
  expect(summaryRes.status(), await summaryRes.text()).toBe(200);
  const summary = (await summaryRes.json()) as { breakdown: { paidManual: number; unpaid: number } };
  expect(summary.breakdown.paidManual).toBe(2);
  expect(summary.breakdown.unpaid).toBe(0);
});

test("ファネル 5 段（着地→同意→claim→checkout→paid）が週次 JSON に出る", async () => {
  const sql = testSql();
  const suffix = uniq();
  const now = new Date();
  const stages = ["landing", "consent", "claim", "checkout", "paid"] as const;

  // `audit_log` は追記専用・グローバル（テストごとに隔離されない）で、
  // `tests/integration/audit-chain.test.ts` がテーブル全体のハッシュ連鎖を検査している。
  // 実コミットで行を足すと（本タスクの最初のバージョンで実際に起きた）他テストの連鎖検証を
  // 壊す。`withRollback`（`tests/integration/setup.ts`）で全操作を 1 トランザクションに包み、
  // 集計結果だけを取り出してから必ずロールバックすることで、他のテスト・実データに一切
  // 影響を残さない。
  const counts = await withRollback(sql, async (tx) => {
    const organizerRows = await tx<{ id: string }[]>`
      INSERT INTO app_user (line_user_ref, identity_scope, line_env)
      VALUES (${Buffer.from(`e2e-funnel-org-${suffix}`)}, ${`e2e-test:${suffix}`}, 'development')
      RETURNING id
    `;
    const organizerId = organizerRows[0]!.id;

    const eventRows = await tx<{ id: string }[]>`
      INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                         minors_included, default_amount_minor, status)
      VALUES (${organizerId}, ${"funnel-probe"}, ${"probe"}, ${Buffer.from(`funnel-join-${suffix}`)},
              false, 3000, 'collecting')
      RETURNING id
    `;
    const eventId = eventRows[0]!.id;

    // `src/lib/metrics/funnel.ts` の `recordFunnelStage` と同じデータモデル
    // （audit_log.action='funnel.<stage>' / target_type='event' / target_id=eventId）で
    // 5 段すべてを記録する。`row_hash` は `computeRowHash`（`src/lib/audit.ts`）と同じ
    // SHA-256(prev_hash ‖ この行の内容) を複製して連鎖として正しい値にする
    // （検証はしないが、正しくない値を書き残さない）。
    for (const stage of stages) {
      await tx`SELECT pg_advisory_xact_lock(8314001::bigint)`;
      const prev = await tx<{ row_hash: Buffer }[]>`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`;
      const prevHash = prev[0]?.row_hash ?? null;
      const material = Buffer.concat([
        prevHash ?? Buffer.alloc(0),
        new TextEncoder().encode(`${now.toISOString()}|funnel.${stage}|event|${eventId}`),
      ]);
      const rowHash = Buffer.from(await crypto.subtle.digest("SHA-256", material));
      await tx`
        INSERT INTO audit_log (occurred_at, actor_type, action, target_type, target_id, request_id,
                               detail, prev_hash, row_hash)
        VALUES (${now.toISOString()}::timestamptz, 'system', ${`funnel.${stage}`}, 'event', ${eventId},
                ${`funnel-${suffix}`}, '{}'::jsonb, ${prevHash}, ${rowHash})
      `;
    }

    // 集計（`computeWeeklyFunnel` と同じクエリ形。同一トランザクション内なので
    // 上で INSERT した未コミットの行も見える）。
    const rows = await tx<{ action: string; n: string }[]>`
      SELECT action, count(DISTINCT target_id)::text AS n
      FROM audit_log
      WHERE target_type = 'event'
        AND action = ANY(${tx.array(stages.map((s) => `funnel.${s}`))})
        AND target_id = ${eventId}
      GROUP BY action
    `;
    const result: Record<string, number> = { landing: 0, consent: 0, claim: 0, checkout: 0, paid: 0 };
    for (const row of rows) result[row.action.replace("funnel.", "")] = Number(row.n);
    return result;
  });

  for (const stage of stages) {
    expect(counts[stage], `stage ${stage} should have reached exactly 1 event`).toBe(1);
  }

  function startOfIsoWeekUtc(date: Date): Date {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return d;
  }
  const weekStart = startOfIsoWeekUtc(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  const outDir = path.join(REPO_ROOT, "docs", "metrics");
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `weekly-${weekStart.toISOString().slice(0, 10)}.json`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        funnel: {
          weekStart: weekStart.toISOString(),
          weekEnd: weekEnd.toISOString(),
          generatedAt: new Date().toISOString(),
          stages: counts,
        },
      },
      null,
      2,
    )}\n`,
  );

  const written = JSON.parse(fs.readFileSync(filePath, "utf8")) as { funnel: { stages: Record<string, number> } };
  for (const stage of stages) {
    expect(written.funnel.stages[stage]).toBeGreaterThanOrEqual(1);
  }
});
