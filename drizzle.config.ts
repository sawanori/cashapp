import { defineConfig } from "drizzle-kit";

// Drizzle is scoped to types and queries only (implementation-plan.md §7-2).
// The canonical migration source of truth is `supabase/migrations/*.sql`
// (task_011); drizzle-kit is not used to `generate` or `push` migrations
// here, only `introspect`/`check` against that same schema so the TypeScript
// types stay derived from it rather than duplicating it.
//
// `src/db/schema.ts` does not exist yet — it is produced by `drizzle-kit
// introspect` once task_011 stands up the Supabase migrations and a local
// Postgres to introspect (docs/vendor-docs/cloudflare/hyperdrive.md for how
// Workers reach it in prod/staging; introspection itself runs against the
// local `supabase start` Postgres, not through Hyperdrive).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/drizzle-meta",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  },
  strict: true,
  verbose: true,
});
