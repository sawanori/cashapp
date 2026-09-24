#!/usr/bin/env node
// scripts/ci/record-worker-size.mjs
//
// Measures the OpenNext build output and prints an estimate of the eventual
// deployed Worker script size, for A25 / check_040 (upper bound: 64 MiB
// uncompressed, unchanged between Workers Free and Paid — see
// docs/vendor-docs/cloudflare/opennext.md, retrieved 2026-09-24).
//
// IMPORTANT — this is an ESTIMATE, not the true wrangler-bundled size.
// `.open-next/worker.js` is only a thin entry point; the code it statically
// and dynamically imports (`.open-next/cloudflare/**`, `middleware/**`,
// `server-functions/**`, `.build/**`, `cache/**`) is bundled, tree-shaken and
// minified by `wrangler`/esbuild only at deploy time (`wrangler deploy` /
// `wrangler versions upload`). Both of those are in this project's banned
// command list (they touch the real, authenticated Cloudflare account), so
// this script sums the *raw, unbundled* size of everything that could feed
// into the Worker script instead — i.e. all of `.open-next/` EXCEPT
// `.open-next/assets/**` (served through the ASSETS binding, not part of the
// Worker script, and not subject to this limit). That sum is a generous
// upper bound: it includes full unminified copies of framework packages
// that real tree-shaking would mostly discard, so it over-counts, never
// under-counts. See ADR-012 for the concrete numbers observed in task_003
// and why the true bundled size is not verified here.
//
// This intentionally does NOT write to docs/run-log/** itself (R-TH-02: only
// scripts/record-run.sh may write there). It runs as the second half of
// `npm run build:cf`, so `scripts/record-run.sh <task_id> npm run build:cf`
// captures this output in the run-log's stdout_tail automatically.

import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const WORKER_SCRIPT_LIMIT_BYTES = 64 * 1024 * 1024; // 64 MiB, uncompressed
const WARN_THRESHOLD_RATIO = 0.8;

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const openNextDir = path.join(repoRoot, ".open-next");
const workerEntryPath = path.join(openNextDir, "worker.js");
const assetsDir = path.join(openNextDir, "assets");

function sumSizeRecursive(dir, { skip = [] } = {}) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (skip.includes(full)) continue;
    if (entry.isDirectory()) {
      total += sumSizeRecursive(full, { skip });
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
}

let entrySize;
try {
  entrySize = statSync(workerEntryPath).size;
} catch {
  console.error(`record-worker-size: ${workerEntryPath} not found. Did the OpenNext build step fail?`);
  process.exit(1);
}

const estimatedBundleInputBytes = sumSizeRecursive(openNextDir, { skip: [assetsDir] });
const estimateMiB = estimatedBundleInputBytes / (1024 * 1024);
const limitMiB = WORKER_SCRIPT_LIMIT_BYTES / (1024 * 1024);
const ratio = estimatedBundleInputBytes / WORKER_SCRIPT_LIMIT_BYTES;

console.log(`worker-size: .open-next/worker.js entry point = ${entrySize} bytes (thin, dynamic-imports the rest).`);
console.log(
  `worker-size: ESTIMATED upper bound (all of .open-next/ except assets/, raw/unbundled) = ` +
    `${estimatedBundleInputBytes} bytes (${estimateMiB.toFixed(2)} MiB) = ${(ratio * 100).toFixed(1)}% of ` +
    `the ${limitMiB} MiB uncompressed limit (A25, check_040). This over-counts vs. the real ` +
    `wrangler-bundled+minified size — see this script's header comment and ADR-012.`,
);

if (ratio >= WARN_THRESHOLD_RATIO) {
  console.error(
    `record-worker-size: WARNING — estimated upper bound is at or above the ` +
      `${(WARN_THRESHOLD_RATIO * 100).toFixed(0)}% threshold (check_040 expects < 80%). ` +
      `The true bundled size is smaller than this estimate, but get a real measurement ` +
      `(staging deploy, task_035+) before assuming this is safe.`,
  );
  process.exit(1);
}
