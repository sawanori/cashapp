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
    // `tests/contract/**` / `tests/conformance/**` / `tests/integration/**`
    // belong to later tasks (task_011/018/019) and are added to `include`
    // there, not here.
    include: [
      "tests/unit/**/*.test.ts",
      "tests/unit/**/*.test.tsx",
      "tests/security/**/*.test.ts",
    ],
    exclude: [
      "node_modules/**",
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "tests/e2e/**",
      "tests/a11y/**",
      "tests/contract/**",
      "tests/conformance/**",
      "tests/integration/**",
    ],
    // Belt-and-suspenders alongside the `TZ=UTC` prefix on the npm script:
    // date-boundary logic in this app must be independent of the host TZ.
    env: {
      TZ: "UTC",
    },
  },
});
