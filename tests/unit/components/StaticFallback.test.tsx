// @vitest-environment jsdom

/**
 * `src/components/StaticFallback.tsx`（R-LINE-03 / check_078）。
 *
 * check_078 の期待は「静的フォールバックが出て**白画面にならない**」であり、そこで
 * 求められる導線は **再試行 / LINE で開く / 幹事への連絡** の 3 つである。
 * ここで固定するのは次の 3 点。
 *
 *   1. `retryHref` を渡さなくても再試行の導線が**必ず**出る
 *      （`src/app/layout.tsx` と `src/app/(liff)/layout.tsx` の呼び出しは現在のパスを
 *      取れないため、既定で出ないと 3 つのうち 2 つが消える）。
 *   2. `permanentLink` を渡せば「LINE アプリで開く」が出る。
 *   3. 「幹事への連絡」は常に出る。
 *
 * 併せて次の 2 つも守る。
 *   - 「押しても何も起きない導線を作らない」（`href="#"` を出さない）。
 *   - 再試行の href が **空文字でない**。`a[href]` を link ロールに対応づける規則は
 *     href が空でないことを条件にしている実装があり（`aria-query` の
 *     `{name:"href", constraints:["set"]}`）、空文字だとスクリーンリーダーにリンクとして届かない。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StaticFallback, type StaticFallbackReason } from "@/components/StaticFallback";
import { liffPermanentLink } from "@/lib/liff/client";

afterEach(() => {
  cleanup();
});

const REASONS: readonly StaticFallbackReason[] = ["legacy", "no_script", "sdk_unavailable"];
const PERMANENT_LINK = liffPermanentLink("2000000000-abcd1234");

describe("StaticFallback の導線（check_078）", () => {
  it.each([...REASONS])(
    "%s: props を 1 つも渡さなくても再試行の導線と幹事への連絡が出る",
    (reason) => {
      render(<StaticFallback reason={reason} />);

      const retry = screen.getByRole("link", { name: "アプリを開き直す" });
      // 必ず実在する入口。空文字でも `#` でもない（どちらもリンクとして機能しない恐れがある）。
      expect(retry).toHaveAttribute("href", "/");

      expect(screen.getByText(/幹事へご連絡/)).toBeInTheDocument();
    },
  );

  it("permanentLink を渡すと『LINE アプリで開く』が加わり、導線が 3 つ揃う", () => {
    expect(PERMANENT_LINK).not.toBeNull();
    const { container } = render(
      <StaticFallback reason="sdk_unavailable" permanentLink={PERMANENT_LINK ?? undefined} />,
    );

    expect(screen.getByRole("link", { name: "アプリを開き直す" })).toBeInTheDocument();
    const open = screen.getByRole("link", { name: "LINE アプリで開く" });
    expect(open).toHaveAttribute("href", PERMANENT_LINK);
    expect(screen.getByText(/幹事へご連絡/)).toBeInTheDocument();

    // 押しても何も起きない導線・スクリーンリーダーに届かない導線を作らない。
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors).toHaveLength(2);
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") ?? "";
      expect(href).not.toBe("#");
      expect(href.length).toBeGreaterThan(0);
    }
  });

  it("retryHref を明示すればその URL を使う（クライアント側は現在の URL を渡す）", () => {
    render(<StaticFallback reason="legacy" retryHref="https://example.test/o/1" />);
    expect(screen.getByRole("link", { name: "もう一度読み込む" })).toHaveAttribute(
      "href",
      "https://example.test/o/1",
    );
  });

  it("理由ごとに見出し文が異なる（同じ文言を使い回していない）", () => {
    const titles = new Set<string>();
    for (const reason of REASONS) {
      const { container } = render(<StaticFallback reason={reason} />);
      titles.add(container.querySelector(".static-fallback__title")?.textContent ?? "");
      cleanup();
    }
    expect(titles.size).toBe(REASONS.length);
  });
});

describe("呼び出し側（レイアウト）が導線を落としていないこと", () => {
  it("src/app/layout.tsx と src/app/(liff)/layout.tsx が StaticFallback を出している", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    );

    const rootLayout = await readFile(path.join(repoRoot, "src", "app", "layout.tsx"), "utf8");
    expect(rootLayout).toContain('reason="legacy"');
    expect(rootLayout).toContain('reason="no_script"');

    const liffLayout = await readFile(
      path.join(repoRoot, "src", "app", "(liff)", "layout.tsx"),
      "utf8",
    );
    expect(liffLayout).toContain('reason="sdk_unavailable"');
  });
});
