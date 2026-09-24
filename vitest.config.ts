import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Default environment is Node: most of this app's unit tests exercise
    // Route Handlers, the payment adapter layer, and DB/state-machine logic,
    // not React components. Component tests opt into jsdom per-file with a
    // `// @vitest-environment jsdom` docblock.
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // `npm run test:unit` and `npm run test:security` each pass an explicit
    // directory (`vitest run tests/unit` / `vitest run tests/security`) to
    // stay independently scoped — both dirs must be listed here so that
    // positional filter is discoverable at all. `tests/e2e/**` and
    // `tests/a11y/**` are Playwright's (`*.spec.ts`, different test runner);
    // `tests/contract/**` belongs to task_018 and is added to `include` there,
    // not here. `tests/integration/**` was added by task_011.
    include: [
      "tests/unit/**/*.test.ts",
      "tests/unit/**/*.test.tsx",
      "tests/security/**/*.test.ts",
      // task_011: `npm run test:integration` が実 Postgres（supabase start）に対して走る。
      // DB が要るため、ディレクトリを明示しない素の `vitest run` からは外したいが、
      // vitest は include に無いファイルを位置指定フィルタでも拾えないため、ここに載せる。
      "tests/integration/**/*.test.ts",
      // task_006: `npm run test:gate-meta`（違反フィクスチャで各ゲートが非ゼロ終了することの検証）。
      // vitest の位置指定フィルタは include に無いファイルを拾えないので、`vitest run tests/gates`
      // を成立させるにはここに載せる必要がある（task_011 の tests/integration と同じ理由）。
      "tests/gates/**/*.test.ts",
      // task_019: `npm run test:conformance`（ProviderConformanceKit）。同じ理由で include に必要。
      "tests/conformance/**/*.test.ts",
    ],
    exclude: [
      "node_modules/**",
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "tests/e2e/**",
      "tests/a11y/**",
      "tests/contract/**",
    ],
    // Belt-and-suspenders alongside the `TZ=UTC` prefix on the npm script:
    // date-boundary logic in this app must be independent of the host TZ.
    env: {
      TZ: "UTC",
    },
    // 並列実装（複数エージェントが同時に vitest を起動）での偽陽性対策 [実測 2026-09-24]:
    // 既定のワーカー数（= CPU 数）で 6〜12 プロセスが同時に走ると 10 コア機で load average が
    // 22〜54 に達し、bash を spawn するテスト（gate-constraints 等）が 5 秒で打ち切られて
    // 「Test timed out」が run-log に 62 回記録された。落ちるたびに検証→レビュー→修正の周回が
    // 1 つ増える。ワーカーを 4 に固定し、タイムアウトを 20 秒にする（テストの内容は変えない）。
    maxWorkers: 4,
    testTimeout: 20000,
  },
});
