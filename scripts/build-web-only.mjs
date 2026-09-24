#!/usr/bin/env node
/**
 * scripts/build-web-only.mjs — LINE 非依存ビルドの担保（`npm run build:web-only`）。
 *
 * 目的（R-LINE-05 / R-LINE-04 / 制約 I4 / check_079）:
 *   `(web)` ルートグループが LINE SDK に依存していないことと、本番バンドルに
 *   モックと dev / review の LIFF ID が混ざっていないことを、**毎回機械的に**確かめる。
 *
 * ★ このスクリプトが確かめること（4 つ）
 *   0. **本番ビルド経路の env**: `package.json` の `build` / `build:cf` が
 *      `NEXT_PUBLIC_LIFF_MOCK` を**必ず定義**している（下の「畳み込みの条件」参照）。
 *   1. **参照の禁止側の全走査**: `src/lib/liff/**` と `src/app/(liff)/**` 以外のどのファイルも
 *      `@line/liff` / `@line/liff-mock` / `src/lib/liff/**` を参照していない。
 *      あわせて `src/app/**`（`(liff)` を除く）と `src/middleware.ts` を起点に import グラフも辿る。
 *   2. **ビルドが通る**: `next build` が成功する。
 *   3. **成果物が汚れていない**: `.next/static/**` に `@line/liff-mock` 由来の識別子と、
 *      禁止された LIFF ID 文字列が 1 件も無い。
 *
 * ★ 畳み込みの条件（**ここを間違えるとモックが本番バンドルに載る**。実測済み）
 *   Next.js がクライアント側の `process.env.NEXT_PUBLIC_*` を定数へ置換するのは
 *   `node_modules/next/dist/lib/static-env.js` の `getNextPublicEnvironmentVariables()` で、
 *   実装は `for (const key in process.env)` ＝ **存在するキーだけ** define に変換する。
 *   したがって `NEXT_PUBLIC_LIFF_MOCK` を **未設定にすると define が 1 つも作られず**、
 *   `src/lib/liff/client.ts` の `isMockEnabled()` は実行時判定のまま残り、
 *   `await import("./mock")` が到達可能コードとしてチャンク化される。
 *   畳み込みの条件は「未設定」ではなく「**`"1"` 以外の値が設定されていること**」である。
 *
 *   実測（2026-09-24、リポジトリの複製に `bootLiff()` を呼ぶ page を置いてビルド）:
 *     - `NEXT_PUBLIC_LIFF_MOCK` 未設定 → `.next/static` に `liff-mock` / `LiffMockPlugin` が **2 ファイル**
 *     - `NEXT_PUBLIC_LIFF_MOCK=0`     → 同 grep **0 件**（`isInClient` は 2 チャンクに残るので
 *                                        「SDK ごと無い」のではなくモックだけが落ちている）
 *
 * ★ このスクリプトが確かめて **いない** こと（誤読を避けるために明記する）
 *   - 「LINE を外しても集金導線が動く」ことは確かめていない。Phase 1 の `(web)` は
 *     静的法務ページと管理者画面だけであり、幹事・参加者導線の LINE 非依存版は存在しない
 *     （`docs/decisions/ADR-013-web-route-group.md`）。
 *   - `node_modules` から `@line/liff` を物理的に取り除いた状態でのビルドは行っていない。
 *     並行タスクと共有する `node_modules` を壊さないためで、代わりに (1) の静的走査で
 *     「`(web)` と共有ルートが SDK に到達しない」ことを示している。
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

/**
 * LIFF 依存コードを置いてよい唯一の 2 か所（`docs/decisions/ADR-013-web-route-group.md` 決定 1）。
 * ここ以外のファイルが `@line/liff` / `src/lib/liff/**` を参照したら違反にする。
 */
const LIFF_ALLOWED_DIRS = ["src/lib/liff", "src/app/(liff)"];

/** 起点に加えるルートグループ外の共有ファイル（存在すれば）。 */
const EXTRA_ENTRY_FILES = ["src/middleware.ts"];

/** 本番ビルド経路。`NEXT_PUBLIC_LIFF_MOCK` を必ず定義していること（畳み込みの条件）。 */
const PRODUCTION_BUILD_SCRIPTS = ["build", "build:cf"];

/** モック無効を表す値。`"1"` 以外なら何でもよいが、経路をまたいで 1 つに揃える。 */
const MOCK_DISABLED_VALUE = "0";

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

/** `src/lib/liff/**` と `src/app/(liff)/**` の中にあるか。 */
function isLiffOwnedFile(file) {
  return LIFF_ALLOWED_DIRS.some((dir) => file.startsWith(path.join(REPO_ROOT, dir) + path.sep));
}

/**
 * (1-a) 禁止側の全走査。
 *
 * ADR-013 決定 1「LIFF 依存コードは `src/lib/liff/**` と `src/app/(liff)/**` の 2 か所だけ」を
 * **機械的に**守らせる。起点集合の取りこぼし（`src/app/page.tsx` や `src/middleware.ts` が
 * ルートグループに属さないこと）に左右されないよう、`src/**` を全部見る。
 */
function checkForbiddenReferences() {
  const srcDir = path.join(REPO_ROOT, "src");
  const files = walk(srcDir, (file) => /\.(tsx?|jsx?|mjs|css)$/.test(file)).filter(
    (file) => !isLiffOwnedFile(file),
  );

  // 空振り禁止: `src/` 配下に検査対象が 0 件なら、このゲートは何も守っていない。
  if (files.length === 0) {
    return {
      violations: ["src/ 配下に検査対象のファイルが 1 つもありません（ゲートの空振り）"],
      scanned: 0,
    };
  }

  const violations = [];
  const forbiddenDirs = FORBIDDEN_DIRS.map((dir) => path.join(REPO_ROOT, dir) + path.sep);

  for (const file of files) {
    const relativeFrom = path.relative(REPO_ROOT, file);
    for (const specifier of readSpecifiers(file)) {
      if (FORBIDDEN_PACKAGES.includes(specifier)) {
        violations.push(
          `${relativeFrom} が ${specifier} を import しています` +
            "（LIFF SDK を参照してよいのは src/lib/liff/** と src/app/(liff)/** だけです）",
        );
        continue;
      }
      const resolved = resolveSpecifier(specifier, file);
      if (resolved.kind !== "file") continue;
      if (forbiddenDirs.some((dir) => resolved.file.startsWith(dir))) {
        violations.push(
          `${relativeFrom} が ${path.relative(REPO_ROOT, resolved.file)} を import しています` +
            "（LIFF SDK を参照してよいのは src/lib/liff/** と src/app/(liff)/** だけです）",
        );
      }
    }
  }

  return { violations, scanned: files.length };
}

/** (1-b) import グラフの検査。 */
function checkImportGraph() {
  const violations = [];
  const appDir = path.join(REPO_ROOT, "src", "app");
  const liffGroupDir = path.join(REPO_ROOT, "src", "app", "(liff)") + path.sep;

  // 起点は「`(liff)` に属さない src/app 配下の全ファイル」＋ ルートグループの外にある共有ファイル。
  //   `src/app/(web)/**` だけを起点にすると、ルートグループに属さない `src/app/page.tsx` と
  //   `src/middleware.ts` が検査から漏れる（どちらも毎ビルドに載る）。
  const entries = walk(appDir, (file) => /\.tsx?$/.test(file)).filter(
    (file) => !file.startsWith(liffGroupDir),
  );
  for (const relative of EXTRA_ENTRY_FILES) {
    const full = path.join(REPO_ROOT, relative);
    if (existsSync(full)) entries.push(full);
  }

  // 空振り禁止: 対象が 0 件なら、このゲートは何も守っていない。
  if (entries.length === 0) {
    violations.push(
      "検査対象が 0 件です（src/app 配下に (liff) 以外のファイルが無く、" +
        `${EXTRA_ENTRY_FILES.join(" / ")} も無い）。ゲートが空振りしています。`,
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

  // ★ モックの取り込み経路を閉じるには「未設定にする」のでは **不足** で、
  //   `"1"` 以外の値を **設定する** 必要がある（冒頭の「畳み込みの条件」。実測済み）。
  //   未設定にすると Next が define を作らず、`await import("./mock")` が到達可能なまま残る。
  const env = { ...process.env, NEXT_PUBLIC_LIFF_MOCK: MOCK_DISABLED_VALUE };

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

/**
 * (0) 本番ビルド経路の env 検査。
 *
 * このスクリプト自身は `next build` を `NEXT_PUBLIC_LIFF_MOCK=0` で起動するので常に安全だが、
 * 実際に配信される成果物を作るのは `npm run build` / `npm run build:cf` である。
 * そちらが変数を定義していなければ、**このゲートが緑でも本番バンドルにモックが載る**。
 * したがってゲートの対象に含める。
 */
function checkProductionBuildEnv() {
  const pkgPath = path.join(REPO_ROOT, "package.json");
  if (!existsSync(pkgPath)) return ["package.json がありません"];

  const violations = [];
  /** @type {{ scripts?: Record<string, string> }} */
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const scripts = pkg.scripts ?? {};

  for (const name of PRODUCTION_BUILD_SCRIPTS) {
    const script = scripts[name];
    if (typeof script !== "string") {
      violations.push(`package.json に scripts.${name} がありません`);
      continue;
    }
    if (!script.includes("NEXT_PUBLIC_LIFF_MOCK=")) {
      violations.push(
        `package.json の scripts.${name} が NEXT_PUBLIC_LIFF_MOCK を定義していません` +
          "（未定義のままビルドするとモックの分岐が畳み込まれず、@line/liff-mock が" +
          "クライアントチャンクに載ります）",
      );
    }
  }
  return violations;
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
  //   なお「モックだけが落ちる」こと自体は、複製リポジトリに bootLiff() を呼ぶ page を置いた
  //   実測で確認済みである（本ファイル冒頭の「畳み込みの条件」）。
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

  violations.push(...checkProductionBuildEnv());
  console.log(
    `build:web-only: 本番ビルド経路（${PRODUCTION_BUILD_SCRIPTS.join(" / ")}）の ` +
      "NEXT_PUBLIC_LIFF_MOCK 定義を確認しました",
  );

  const references = checkForbiddenReferences();
  violations.push(...references.violations);
  console.log(
    `build:web-only: src/ 配下を ${String(references.scanned)} ファイル全走査しました` +
      `（LIFF 参照を許すのは ${LIFF_ALLOWED_DIRS.join(" / ")} だけ）`,
  );

  const graph = checkImportGraph();
  violations.push(...graph.violations);
  console.log(
    `build:web-only: import グラフを ${String(graph.visited.length)} ファイル走査しました` +
      `（起点: src/app/** の (liff) 以外 と ${EXTRA_ENTRY_FILES.join(" / ")}）`,
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
