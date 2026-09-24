/**
 * 契約テスト: `tests/e2e/helpers/session.ts` の複製が `src/lib/auth/session.ts` /
 * `src/lib/auth/csrf.ts` の仕様から乖離したら落ちる（レビューギャップの是正）。
 *
 * ★ 背景: `tests/e2e/helpers/session.ts` は Playwright のテストランナーが
 *   `import "server-only"` を持つアプリのコードを読み込めないという事情
 *   （同ファイルの docstring）から、セッション JWT / CSRF トークンの生成式を
 *   アプリのコードを import せず独自に複製している。この複製が乖離しても、
 *   E2E テスト自体は何も気付かず「正しくない仕様」を検証し続ける恐れがある
 *   （敵対レビューで指摘された構造的なギャップ）。
 *
 * ★ この契約テストは vitest（Node 環境）からは両方を import できるという事実を使い、
 *   `tests/e2e/helpers/session.ts` が `export` した定数と、アプリ本体の定数を
 *   直接突き合わせる。値そのものを変える権限は無い（アプリ側が正）。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sessionLib = await import("@/lib/auth/session");
const csrfLib = await import("@/lib/auth/csrf");
const e2eHelper = await import("../e2e/helpers/session");

describe("tests/e2e/helpers/session.ts は src/lib/auth/session.ts の仕様と一致する", () => {
  it("Cookie 名・issuer・audience・TTL が一致する", () => {
    expect(e2eHelper.SESSION_COOKIE_NAME).toBe(sessionLib.SESSION_COOKIE_NAME);
    expect(e2eHelper.SESSION_ISSUER).toBe(sessionLib.SESSION_ISSUER);
    expect(e2eHelper.SESSION_AUDIENCE).toBe(sessionLib.SESSION_AUDIENCE);
    expect(e2eHelper.SESSION_TTL_SECONDS).toBe(sessionLib.SESSION_TTL_SECONDS);
  });

  it("CSRF ヘッダ名（x-csrf-token）が src/lib/auth/csrf.ts の CSRF_HEADER と一致する", () => {
    // tests/e2e/helpers/session.ts はヘッダ名をリテラルで送信する側（organizer-flow.spec.ts
    // 等）に委ねている。HTTP ヘッダ名は大小無視だが、値そのものが変わっていないかは検査する。
    expect(csrfLib.CSRF_HEADER.toLowerCase()).toBe("x-csrf-token");
  });
});
