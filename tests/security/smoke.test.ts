import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// task_003 の雛形。実体（IDOR・claim 3 本・冪等キー越境・ID トークン再利用・XSS/CSP・
// 許可外 IP・deepLink ホストなど）は task_022 が追加する（§13, §14-4）。
// ここでは R-SEC-13（サプライチェーン統制）の前提となる `.npmrc` 設定だけを実測で守る。
describe("サプライチェーン統制の前提", () => {
  it(".npmrc に ignore-scripts=true がある", () => {
    const npmrc = readFileSync(resolve(process.cwd(), ".npmrc"), "utf8");
    expect(npmrc).toMatch(/^ignore-scripts=true$/m);
  });
});
