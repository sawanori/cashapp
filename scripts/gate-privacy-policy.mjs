#!/usr/bin/env node
// scripts/gate-privacy-policy.mjs
//
// `src/content/privacy.md`（プライバシーポリシー）の機械検査。task_021 scope / L7。
//
// L7: 「プライバシーポリシーに事業者名・住所・利用目的・開示等請求手続を掲載する」
// （個人情報保護法32条1項）。scope はこれに加えて 委託先・保管国・外的環境の把握・
// 安全管理措置・プラットフォームログ保持を求める。すべて「存在するか」だけを見る
// （`scripts/gate-terms.mjs` と同じ限界）。
//
// Exit codes: 0 clean / 1 必須項目欠落 / 2 usage・ファイル不在。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  let file = path.join(REPO_ROOT, "src", "content", "privacy.md");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--file") {
      const next = argv[i + 1];
      if (next === undefined) {
        process.stderr.write("gate-privacy-policy: --file requires a value\n");
        process.exit(2);
      }
      file = path.isAbsolute(next) ? next : path.join(REPO_ROOT, next);
      i += 1;
    }
  }
  return { file };
}

export const REQUIRED_ITEMS = [
  { id: "OPERATOR_NAME", label: "事業者名（L7）", pattern: "名称:" },
  { id: "OPERATOR_ADDRESS", label: "住所（L7）", pattern: "所在地:" },
  { id: "CONTACT", label: "連絡先（L7）", pattern: "連絡先:" },
  { id: "PURPOSE", label: "利用目的（L7）", pattern: "利用目的" },
  { id: "ENTRUSTEE", label: "委託先（scope）", pattern: "委託先" },
  { id: "STORAGE_COUNTRY", label: "保管国・外的環境（scope）", pattern: "保管国" },
  { id: "SAFETY_MEASURES", label: "安全管理措置（scope）", pattern: "安全管理措置" },
  { id: "PLATFORM_LOG_RETENTION", label: "プラットフォームログ保持（scope）", pattern: "プラットフォーム" },
  { id: "DISCLOSURE_PROCEDURE", label: "開示等請求手続（L7）", pattern: "開示" },
];

export function checkPrivacyPolicy(content) {
  return REQUIRED_ITEMS.filter((item) => !content.includes(item.pattern));
}

function main() {
  const { file } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(file)) {
    process.stderr.write(`gate-privacy-policy: file not found: ${file}\n`);
    process.exit(2);
  }
  const content = fs.readFileSync(file, "utf8");
  const missing = checkPrivacyPolicy(content);

  let ok = true;
  for (const item of REQUIRED_ITEMS) {
    const isMissing = missing.some((m) => m.id === item.id);
    process.stdout.write(`${isMissing ? "MISSING" : "ok     "} ${item.id} (${item.label})\n`);
    if (isMissing) ok = false;
  }

  process.stdout.write(
    `\ngate:privacy-policy — ${REQUIRED_ITEMS.length - missing.length}/${REQUIRED_ITEMS.length} required items present\n`,
  );
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
