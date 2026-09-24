import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // App Router only. No `pages/`.
  reactStrictMode: true,
  // Hosting target is Cloudflare Workers via @opennextjs/cloudflare (ADR-012).
  // Runtime concerns specific to Workers (headers, middleware) are layered
  // on top by later tasks (task_012 §7-6/7-7); this file stays minimal for
  // the task_003 scaffold.
};

// Wires `next dev` into the @opennextjs/cloudflare local platform proxy so
// `getCloudflareContext()` (bindings, env) resolves during local development
// too, not only under `wrangler dev`. Intentionally not awaited — see the
// function's own doc comment; it self-limits to local `next dev`.
void initOpenNextCloudflareForDev();

export default nextConfig;
