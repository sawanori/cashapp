// @vitest-environment jsdom

/**
 * `src/components/ConsentGate.tsx`（O-1 / 制約 L6 / R-LAW-06 / R-SEC-12）。
 *
 * 検査するのは 4 点。
 *   1. 3 種の同意（利用規約 / プライバシー / **支払状況の幹事への開示**）を個別に取ること。
 *      3 つ目が L6 の本体であり、まとめて 1 個のチェックにしてはいけない。
 *   2. 全部にチェックが入るまで送信できないこと。
 *   3. `POST /api/consent` に `X-CSRF-Token` **ヘッダ**で送ること（Cookie に入れない）。
 *   4. 失敗しても `requestId` つきのエラー表示になり、画面が白くならないこと。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSENT_ENDPOINT,
  CONSENT_ITEMS,
  CSRF_HEADER_NAME,
  ConsentGate,
} from "@/components/ConsentGate";

const CSRF_TOKEN = "csrf-token-for-test";
const TEXT_VERSION = "2026-09-24";

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: RecordedCall[];

function stubFetch(responder: (call: RecordedCall) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return responder(call);
    }),
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("同意項目", () => {
  it("3 種を個別のチェックボックスとして出す（まとめて 1 個にしない）", () => {
    stubFetch(() => new Response(null, { status: 200 }));
    render(<ConsentGate csrfToken={CSRF_TOKEN} textVersion={TEXT_VERSION} />);

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    expect(CONSENT_ITEMS.map((item) => item.kind)).toEqual([
      "tos",
      "privacy",
      "organizer_disclosure",
    ]);
  });

  it("L6: 支払状況が幹事に表示されることへの同意を明示的に含む", () => {
    stubFetch(() => new Response(null, { status: 200 }));
    render(<ConsentGate csrfToken={CSRF_TOKEN} textVersion={TEXT_VERSION} />);

    expect(screen.getByLabelText(/支払状況が幹事に表示される/)).toBeInTheDocument();
  });
});

describe("送信の可否", () => {
  it("すべてにチェックが入るまで送信ボタンは押せない", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    render(<ConsentGate csrfToken={CSRF_TOKEN} textVersion={TEXT_VERSION} />);

    const button = screen.getByRole("button", { name: "同意して進む" });
    expect(button).toBeDisabled();

    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0] as HTMLElement);
    expect(button).toBeDisabled();
    fireEvent.click(boxes[1] as HTMLElement);
    expect(button).toBeDisabled();
    fireEvent.click(boxes[2] as HTMLElement);
    expect(button).toBeEnabled();
  });
});

describe("POST /api/consent", () => {
  it("3 種ぶんを X-CSRF-Token ヘッダ付きで送り、成功したら onConsented を呼ぶ", async () => {
    stubFetch(() => Response.json({ recorded: true, requestId: "r" }, { status: 200 }));
    const onConsented = vi.fn();

    render(
      <ConsentGate
        csrfToken={CSRF_TOKEN}
        textVersion={TEXT_VERSION}
        onConsented={onConsented}
      />,
    );

    for (const box of screen.getAllByRole("checkbox")) {
      fireEvent.click(box);
    }
    fireEvent.click(screen.getByRole("button", { name: "同意して進む" }));

    await waitFor(() => {
      expect(onConsented).toHaveBeenCalledTimes(1);
    });

    expect(calls).toHaveLength(3);
    const kinds: unknown[] = [];
    for (const call of calls) {
      expect(call.url).toBe(CONSENT_ENDPOINT);
      expect(call.init.method).toBe("POST");
      const headers = call.init.headers as Record<string, string>;
      expect(headers[CSRF_HEADER_NAME]).toBe(CSRF_TOKEN);
      const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
      expect(body["textVersion"]).toBe(TEXT_VERSION);
      kinds.push(body["consentKind"]);
    }
    expect(kinds).toEqual(["tos", "privacy", "organizer_disclosure"]);
  });

  it("CSRF ヘッダ名がサーバー側（src/lib/auth/csrf.ts）と一致している", () => {
    expect(CSRF_HEADER_NAME).toBe("X-CSRF-Token");
  });

  it("失敗したら requestId つきのエラー状態を出し、onConsented を呼ばない", async () => {
    stubFetch(() =>
      Response.json(
        { code: "CSRF_INVALID", message: "この操作を受け付けられませんでした。", requestId: "abc123" },
        { status: 403 },
      ),
    );
    const onConsented = vi.fn();

    render(
      <ConsentGate
        csrfToken={CSRF_TOKEN}
        textVersion={TEXT_VERSION}
        onConsented={onConsented}
      />,
    );

    for (const box of screen.getAllByRole("checkbox")) {
      fireEvent.click(box);
    }
    fireEvent.click(screen.getByRole("button", { name: "同意して進む" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(onConsented).not.toHaveBeenCalled();
    // 1 本目で失敗したら以降は送らない（どこまで記録されたかを曖昧にしない）。
    expect(calls).toHaveLength(1);
  });

  it("通信そのものが失敗しても例外を投げず、エラー状態を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    render(<ConsentGate csrfToken={CSRF_TOKEN} textVersion={TEXT_VERSION} />);
    for (const box of screen.getAllByRole("checkbox")) {
      fireEvent.click(box);
    }
    fireEvent.click(screen.getByRole("button", { name: "同意して進む" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});
