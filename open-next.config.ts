import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal task_003 scaffold: default overrides (in-memory / no cross-isolate
// cache). Incremental cache / tag cache / queue backends (KV, R2, D1,
// Durable Objects) are a later task's decision once real traffic and
// revalidation needs are known — the plan does not scope caching strategy
// for task_003 (non_scope: UI).
export default defineCloudflareConfig();
