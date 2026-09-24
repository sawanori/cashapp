#!/usr/bin/env node
/**
 * scripts/assert-server-only.mjs — サーバー専用モジュールの境界検査（`npm run gate:server-only`）。
 *
 * 目的（R-SEC-04 / §7-7「DB クライアントとシークレット取得モジュールに `import 'server-only'`」）:
 *   秘密値に触れるモジュールがクライアントバンドルへ混ざる経路を、ビルドを待たずに落とす。
 *   LIFF のバンドルは実質公開物なので、混ざった時点で PEPPER もセッション鍵も公開される。
 *
 * 検査は 3 つ。
 *   1. **必須**: 下の `SERVER_ONLY_MODULES` に挙げたファイルが存在し、`import "server-only"` を持つ。
 *      （glob ではなく明示列挙にする。glob だと「新しいファイルを足したら勝手に対象になる／
 *        対象から外れる」ので、何を守っているかが分からなくなる。）
 *   2. **伝播**: `"use client"` を宣言したファイルが、サーバー専用モジュールを import していない。
 *   3. **伝播**: `.tsx`（Server Component も含む）から DB クライアントを直接 import していない
 *      （制約 I3。DB は Route Handler 経由のみ）。
 *
 * 使い方: node scripts/assert-server-only.mjs [--root <dir>]
 * 終了コード: 違反 1 件以上で 1。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/**
 * `import "server-only"` が必須のモジュール。
 * ここに載せるのは「秘密値そのものか、秘密値から導いた値を扱う」ものだけ。
 */
const SERVER_ONLY_MODULES = [
  "src/lib/db/client.ts",
  "src/lib/config/env.ts",
  "src/lib/logger.ts",
  "src/lib/auth/pepper.ts",
  "src/lib/auth/session.ts",
  "src/lib/auth/csrf.ts",
  "src/lib/auth/line-verify.ts",
  "src/lib/auth/used-token.ts",
  "src/lib/auth/rate-limit.ts",
];

/** クライアントから import されたら落とす module specifier（`@/` 表記と相対表記の両方を見る）。 */
const SERVER_ONLY_SPECIFIER_RE =
  /from\s*["'](?:@\/lib\/(?:db\/client|config\/env|logger|auth\/[a-z-]+)|(?:\.{1,2}\/)+lib\/(?:db\/client|config\/env|logger|auth\/[a-z-]+))["']/;

const DB_CLIENT_SPECIFIER_RE = /from\s*["'](?:@\/lib\/db\/client|(?:\.{1,2}\/)+lib\/db\/client)["']/;

function parseArgs(argv) {
  const args = { root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--root requires a directory");
      args.root = path.resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const violations = [];
  const ok = [];

  // (1) 必須の `import "server-only"`。
  for (const relative of SERVER_ONLY_MODULES) {
    const file = path.join(args.root, relative);
    if (!existsSync(file)) {
      violations.push(`${relative} is listed as server-only but does not exist`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    if (!/^\s*import\s+["']server-only["'];?\s*$/m.test(source)) {
      violations.push(`${relative} must start with \`import "server-only";\``);
    } else {
      ok.push(`${relative} imports server-only`);
    }
  }

  // (2)(3) 伝播。
  const sources = walk(path.join(args.root, "src"));
  for (const file of sources) {
    const relative = path.relative(args.root, file);
    if (SERVER_ONLY_MODULES.includes(relative.split(path.sep).join("/"))) continue;
    const source = readFileSync(file, "utf8");
    const isClientComponent = /^\s*["']use client["'];?\s*$/m.test(source);

    if (isClientComponent && SERVER_ONLY_SPECIFIER_RE.test(source)) {
      violations.push(`${relative}: a "use client" module imports a server-only module`);
    }
    if (file.endsWith(".tsx") && DB_CLIENT_SPECIFIER_RE.test(source)) {
      violations.push(
        `${relative}: components must not import the DB client directly (constraint I3; go through a Route Handler)`,
      );
    }
  }
  ok.push(`scanned ${sources.length} file(s) under src/ for server-only leakage`);

  for (const line of ok) console.log(`ok        ${line}`);
  for (const line of violations) console.log(`VIOLATION ${line}`);
  console.log(
    `\ngate:server-only — ${violations.length} violation(s), ${ok.length} check(s) passed`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}

main();
