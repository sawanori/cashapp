#!/usr/bin/env node
/**
 * scripts/build-web-only.mjs — LINE 非依存ビルドの担保（`npm run build:web-only`）。
 *
 * 目的（R-LINE-05 / R-LINE-04 / 制約 I4 / check_079）:
 *   `(web)` ルートグループが LINE SDK に依存していないことと、本番バンドルに
 *   モックと dev / review の LIFF ID が混ざっていないことを、**毎回機械的に**確かめる。
 *
 * ★ このスクリプトが確かめること（3 つ）
 *   1. **import グラフ**: `src/app/(web)/**` と共有のルートレイアウトから辿れる範囲に
 *      `@line/liff` / `@line/liff-mock` / `src/lib/liff/**` が 1 つも現れない。
 *   2. **ビルドが通る**: `next build` が成功する。
 *   3. **成果物が汚れていない**: `.next/static/**` に `@line/liff-mock` 由来の識別子と、
 *      禁止された LIFF ID 文字列が 1 件も無い。
 *
 * ★ このスクリプトが確かめて **いない** こと（誤読を避けるために明記する）
 *   - 「LINE を外しても集金導線が動く」ことは確かめていない。Phase 1 の `(web)` は
 *     静的法務ページと管理者画面だけであり、幹事・参加者導線の LINE 非依存版は存在しない
 *     （`docs/decisions/ADR-013-web-route-group.md`）。
 *   - `node_modules` から `@line/liff` を物理的に取り除いた状態でのビルドは行っていない。
 *     並行タスクと共有する `node_modules` を壊さないためで、代わりに (1) の import グラフで
 *     「`(web)` が SDK に到達しない」ことを静的に示している。
 *
 * 使い方:
 *   node scripts/build-web-only.mjs [--skip-build]
 *   環境変数 WEB_ONLY_FORBIDDEN_LIFF_IDS にカンマ区切りで追加の禁止 LIFF ID を渡せる。
 *
 * 終了コード: 違反 1 件以上、またはビルド失敗で 1。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/** `(web)` から到達してはいけない bare specifier。 */
const FORBIDDEN_PACKAGES = ["@line/liff", "@line/liff-mock"];

/** `(web)` から到達してはいけないリポジトリ内のディレクトリ。 */
const FORBIDDEN_DIRS = ["src/lib/liff"];

/** `.next/static` に現れてはいけない識別子（モックが混ざったことの痕跡）。 */
const FORBIDDEN_BUNDLE_MARKERS = ["@line/liff-mock", "LiffMockPlugin", "liffMock"];

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"];

function fail(message) {
  console.error(`build:web-only: ${message}`);
}

/** 再帰的にファイルを集める。 */
function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, filter, out);
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

/** `@/x` と相対パスだけを解決する。bare specifier は解決せずそのまま返す。 */
function resolveSpecifier(specifier, fromFile) {
  let base;
  if (specifier.startsWith("@/")) {
    base = path.join(REPO_ROOT, "src", specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return { kind: "package", specifier };
  }

  if (existsSync(base) && statSync(base).isFile()) return { kind: "file", file: base };
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return { kind: "file", file: candidate };
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = path.join(base, `index${extension}`);
    if (existsSync(candidate)) return { kind: "file", file: candidate };
  }
  return { kind: "unresolved", specifier };
}

/**
 * ファイルが参照する module specifier を拾う。
 *
 * 完全な parser は使わない（依存を増やさない）。静的 import / export from / 動的 import /
 * CSS の `@import` を拾えれば、このゲートの目的には足りる。
 */
function readSpecifiers(file) {
  const source = readFileSync(file, "utf8");
  const found = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /@import\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found];
}

/** (1) import グラフの検査。 */
function checkImportGraph() {
  const violations = [];
  const webGroupDir = path.join(REPO_ROOT, "src", "app", "(web)");
  const rootLayout = path.join(REPO_ROOT, "src", "app", "layout.tsx");

  const entries = walk(webGroupDir, (file) => /\.tsx?$/.test(file));
  if (existsSync(rootLayout)) entries.push(rootLayout);

  // 空振り禁止: 対象が 0 件なら、このゲートは何も守っていない。
  if (entries.length === 0) {
    violations.push(
      "検査対象が 0 件です（src/app/(web)/** が空、かつ src/app/layout.tsx も無い）。" +
        "ゲートが空振りしています。",
    );
    return { violations, visited: [] };
  }

  const visited = new Set();
  const queue = [...entries];
  const forbiddenDirs = FORBIDDEN_DIRS.map((dir) => path.join(REPO_ROOT, dir) + path.sep);

  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of readSpecifiers(file)) {
      const relativeFrom = path.relative(REPO_ROOT, file);

      if (FORBIDDEN_PACKAGES.includes(specifier)) {
        violations.push(`${relativeFrom} が ${specifier} を import しています`);
        continue;
      }

      const resolved = resolveSpecifier(specifier, file);
      if (resolved.kind !== "file") continue;

      if (forbiddenDirs.some((dir) => resolved.file.startsWith(dir))) {
        violations.push(
          `${relativeFrom} が ${path.relative(REPO_ROOT, resolved.file)} を import しています` +
            "（(web) から src/lib/liff/** へ到達してはいけません）",
        );
        continue;
      }
      queue.push(resolved.file);
    }
  }

  return { violations, visited: [...visited] };
}

/** (2) 実ビルド。 */
function runBuild() {
  const nextBin = path.join(REPO_ROOT, "node_modules", ".bin", "next");
  if (!existsSync(nextBin)) {
    return [`next の実行ファイルが見つかりません: ${path.relative(REPO_ROOT, nextBin)}`];
  }

  // モックの取り込み経路を明示的に閉じた状態でビルドする。
  const env = { ...process.env };
  delete env["NEXT_PUBLIC_LIFF_MOCK"];

  const result = spawnSync(nextBin, ["build"], {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    return [`next build が失敗しました（exit ${String(result.status)}）`];
  }
  return [];
}

/** `.env.example` に書かれている dev の LIFF ID を禁止語に足す。 */
function forbiddenLiffIds() {
  const ids = new Set();
  const fromEnv = process.env["WEB_ONLY_FORBIDDEN_LIFF_IDS"];
  if (typeof fromEnv === "string") {
    for (const id of fromEnv.split(",").map((value) => value.trim())) {
      if (id.length > 0) ids.add(id);
    }
  }

  const envExample = path.join(REPO_ROOT, ".env.example");
  if (existsSync(envExample)) {
    const source = readFileSync(envExample, "utf8");
    for (const match of source.matchAll(/"liffId"\s*:\s*"([0-9]{10}-[0-9A-Za-z]{8})"/g)) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

/** (3) ビルド成果物の grep。 */
function checkBundle() {
  const violations = [];
  const staticDir = path.join(REPO_ROOT, ".next", "static");
  if (!existsSync(staticDir)) {
    return [".next/static がありません（ビルドが走っていない可能性）"];
  }

  const files = walk(staticDir, (file) => /\.(js|mjs|css|json|txt|map)$/.test(file));
  if (files.length === 0) {
    return [".next/static に検査対象のファイルが 1 つもありません（ゲートの空振り）"];
  }

  const markers = [...FORBIDDEN_BUNDLE_MARKERS, ...forbiddenLiffIds()];
  let mentionsLiffAtAll = false;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (source.includes("liff")) mentionsLiffAtAll = true;
    for (const marker of markers) {
      if (source.includes(marker)) {
        violations.push(`${path.relative(REPO_ROOT, file)} に "${marker}" が含まれています`);
      }
    }
  }

  // ★ 空振りの明示。
  //   まだどのページも `bootLiff()` を呼んでいない段階では、LIFF SDK 自体がクライアント
  //   バンドルに 1 バイトも載らない。そのときこの grep は「モックが無い」ことを証明しているのではなく
  //   「SDK ごと無い」だけである。緑を過大評価しないよう、その旨を必ず出力に残す
  //   （docs/concerns/task_013.md C-013-2）。
  if (!mentionsLiffAtAll) {
    console.log(
      "build:web-only: 注意 — .next/static に LIFF 由来の文字列が 1 つも無い。" +
        "まだ (liff) のページが bootLiff() を呼んでいないため、モック混入の grep は現時点では" +
        "空振りに近い。(liff) 画面が入る task_014 / task_015 で再確認すること。",
    );
  }

  return violations;
}

function main() {
  const skipBuild = process.argv.includes("--skip-build");
  const violations = [];

  const graph = checkImportGraph();
  violations.push(...graph.violations);
  console.log(
    `build:web-only: import グラフを ${String(graph.visited.length)} ファイル走査しました` +
      `（起点: src/app/(web)/** と src/app/layout.tsx）`,
  );

  if (!skipBuild) {
    violations.push(...runBuild());
  } else {
    console.log("build:web-only: --skip-build が指定されたので next build を省略しました");
  }

  const bundleViolations = checkBundle();
  violations.push(...bundleViolations);
  console.log(
    `build:web-only: .next/static を検査しました（禁止マーカー ${String(
      FORBIDDEN_BUNDLE_MARKERS.length + forbiddenLiffIds().length,
    )} 件）`,
  );

  if (violations.length > 0) {
    for (const violation of violations) fail(violation);
    console.error(`build:web-only: 違反 ${String(violations.length)} 件`);
    process.exit(1);
  }

  console.log("build:web-only: OK（(web) は LINE SDK に依存せず、バンドルにモックも dev LIFF ID も無い）");
}

main();
