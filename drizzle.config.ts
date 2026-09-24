import { defineConfig } from "drizzle-kit";

// Drizzle is scoped to types and queries only (implementation-plan.md §7-2).
// The canonical migration source of truth is `supabase/migrations/*.sql`
// (task_011); drizzle-kit is NEVER used to `generate` or `push` migrations into
// this repository — doing so would duplicate the ledger (R-SEC-03).
//
// This config exists for one purpose: running a **read-only difference check**
// between `src/lib/db/schema.ts` and the live local Postgres, via
// `npm run db:diff:drizzle` (check_071). That script introspects the database
// into a throwaway cache directory (`out`, below) and then asks drizzle-kit what
// it would have to change to reach the TypeScript schema. Nothing is written to
// `supabase/migrations/` and nothing is applied to the database.
//
// Known, documented limitation (measured 2026-09-24, drizzle-kit 0.31.11):
// the difference is NOT zero and cannot be, because `src/lib/db/schema.ts`
// declares columns only — it deliberately does not restate the 9 unique
// constraints, 92 check constraints, 34 indexes and 31 foreign keys that live in
// `supabase/migrations/*.sql`. drizzle-kit therefore reports them as "drop"
// statements. What the check is good for is the table/column layer: a
// `CREATE TABLE` / `DROP TABLE` / `DROP COLUMN` / `ALTER COLUMN` in the output
// means the Drizzle types have genuinely drifted from the canonical schema.
// The exact per-column comparison is enforced automatically instead, by
// `tests/integration/schema.test.ts` ("Drizzle スキーマの全列が実 DB と一致する").
// See docs/HANDOFF.md (task_011) for the unmet portion of check_071.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  // Throwaway. `npm run db:diff:drizzle` points DRIZZLE_DIFF_OUT at a fresh
  // `run-<epoch>` subdirectory per invocation (a stale snapshot left in a reused
  // directory would silently make the next diff look empty). drizzle-kit refuses
  // `--config` together with other CLI flags, so the override has to arrive as an
  // environment variable rather than `--out`. Everything lives inside
  // node_modules/.cache so it can never be mistaken for a migration ledger and is
  // never committed.
  out: process.env["DRIZZLE_DIFF_OUT"] ?? "./node_modules/.cache/drizzle-diff/latest",
  dbCredentials: {
    // Introspection needs to read the full catalog, so prefer the privileged
    // connection (same resolution order as scripts/gates-sync.mjs). The runtime
    // role app_rw is intentionally not privileged enough to be the default here.
    url:
      process.env["DATABASE_URL_MIGRATOR"] ??
      process.env["DATABASE_URL"] ??
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  },
  strict: true,
  verbose: true,
});
