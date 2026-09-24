#!/usr/bin/env node
/**
 * scripts/audit-verify.mjs — 監査連鎖の検証（`npm run audit:verify`。§10-1 / check_057 / G14）。
 *
 * `audit_log` を `id` 昇順に読み、各行について
 *   - `prev_hash` が直前の行の `row_hash` と一致すること
 *   - `row_hash` が「`prev_hash` を含む行内容全体」の SHA-256 と一致すること
 * を確かめる。1 行でも改変されていれば、その行以降で必ず食い違う。
 *
 * ★ 正準表現は `src/lib/audit.ts` の `computeRowHash` と**同一**でなければならない。
 *   このファイルが TypeScript を import できないのは、`src/lib/audit.ts` が
 *   `import "server-only"` を持ち、素の Node では例外を投げるためである（実測）。
 *   そのため同じ計算をここに写している。**写しがずれていないことは
 *   `tests/integration/webhook-route.test.ts` の「監査連鎖の写しの一致」が機械検査する**
 *   （`appendAuditLog` が実際に書いた行の `row_hash` を、この関数で再計算して突き合わせる）。
 *
 * ★ 出力に秘密値を入れない。出すのは行 ID・件数・理由だけ。
 *
 * 使い方:
 *   node scripts/audit-verify.mjs [--limit <n>] [--url <connection string>] [--quiet]
 *
 * 終了コード:
 *   0  連鎖が一致した（0 行でも 0。まだ監査行が無いのは異常ではない）
 *   1  連鎖が壊れている
 *   2  設定・接続の誤り
 */

import { createHash } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const DEFAULT_LIMIT = 10000;

/** ローカル（`supabase start`）の既定。CI / 本番は `--url` か環境変数で渡す。 */
const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export function resolveConnectionString(env = process.env, argUrl = null) {
  if (typeof argUrl === "string" && argUrl.length > 0) return argUrl;
  const fromEnv = env["AUDIT_VERIFY_DATABASE_URL"] ?? env["DATABASE_URL_MIGRATOR"] ?? env["DATABASE_URL"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return DEFAULT_URL;
}

/** `src/lib/audit.ts` の `sortKeysDeep` と同じ。キー順に依存しない正準表現を作るため。 */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = sortKeysDeep(value[k]);
    }
    return sorted;
  }
  return value;
}

function bufferHex(value) {
  if (value === null || value === undefined) return null;
  return Buffer.from(value).toString("hex");
}

/** `src/lib/audit.ts` の `computeRowHash` と同じ入力・同じ計算。戻り値は Buffer。 */
export function computeRowHash(input) {
  const canonical = JSON.stringify(
    sortKeysDeep({
      prevHash: bufferHex(input.prevHash),
      occurredAt: input.occurredAt.toISOString(),
      actorType: input.actorType,
      actorRef: bufferHex(input.actorRef),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      beforeRank: input.beforeRank ?? null,
      afterRank: input.afterRank ?? null,
      amountMinor: input.amountMinor ?? null,
      providerKey: input.providerKey ?? null,
      externalRef: input.externalRef ?? null,
      requestId: input.requestId,
      sourceIpHash: bufferHex(input.sourceIpHash),
      detail: input.detail,
    }),
  );
  return createHash("sha256").update(canonical, "utf8").digest();
}

function buffersEqual(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  return Buffer.from(a).equals(Buffer.from(b));
}

/** DB 行の配列（`id` 昇順）を検証する。 */
export function verifyChain(rows) {
  let expectedPrevHash = null;
  for (const row of rows) {
    if (!buffersEqual(row.prev_hash, expectedPrevHash)) {
      return {
        ok: false,
        rowsChecked: rows.length,
        brokenAtId: String(row.id),
        reason: "prev_hash does not match the previous row's row_hash",
      };
    }
    const recomputed = computeRowHash({
      prevHash: row.prev_hash,
      occurredAt: row.occurred_at,
      actorType: row.actor_type,
      actorRef: row.actor_ref,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      beforeRank: row.before_rank,
      afterRank: row.after_rank,
      amountMinor: row.amount_minor,
      providerKey: row.provider_key,
      externalRef: row.external_ref,
      requestId: row.request_id,
      sourceIpHash: row.source_ip_hash,
      detail: row.detail,
    });
    if (!buffersEqual(recomputed, row.row_hash)) {
      return {
        ok: false,
        rowsChecked: rows.length,
        brokenAtId: String(row.id),
        reason: "row_hash does not match the recomputed hash of the row content",
      };
    }
    expectedPrevHash = row.row_hash;
  }
  return { ok: true, rowsChecked: rows.length, brokenAtId: null, reason: null };
}

async function main(argv) {
  let limit = DEFAULT_LIMIT;
  let url = null;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") {
      limit = Number(argv[i + 1]);
      i += 1;
      if (!Number.isInteger(limit) || limit < 1) {
        console.error("audit-verify: --limit must be a positive integer");
        return 2;
      }
    } else if (arg === "--url") {
      url = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--quiet") {
      quiet = true;
    } else {
      console.error(`audit-verify: unknown argument: ${arg}`);
      return 2;
    }
  }

  const sql = postgres(resolveConnectionString(process.env, url), {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    const rows = await sql`
      SELECT id, occurred_at, actor_type, actor_ref, action, target_type, target_id,
             before_rank, after_rank, amount_minor, provider_key, external_ref,
             request_id, source_ip_hash, detail, prev_hash, row_hash
      FROM audit_log
      ORDER BY id ASC
      LIMIT ${limit}
    `;
    const result = verifyChain(rows);
    if (!quiet) {
      console.log(
        JSON.stringify({
          gate: "audit:verify",
          ok: result.ok,
          rowsChecked: result.rowsChecked,
          brokenAtId: result.brokenAtId,
          reason: result.reason,
        }),
      );
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    // 接続文字列（パスワードを含む）を出さない。
    console.error(`audit-verify: database error: ${error instanceof Error ? error.name : "unknown"}`);
    return 2;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`audit-verify: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
