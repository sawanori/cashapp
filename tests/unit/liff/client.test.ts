/**
 * `src/lib/liff/client.ts` の起動順序とループ防止（check_029 / check_077 / R-LINE-02 / R-LINE-03）。
 *
 * ここで守りたい不変条件は 2 つだけである。
 *   1. **`isInClient()` が false のとき `login()` を 1 回も呼ばない。**
 *   2. **`login()` は 2 回までしか呼ばれず、3 回目は `auth_unavailable` になる。**
 *
 * どちらも「呼ばれなかったこと」の検査なので、スパイの呼び出し回数を数える形で書く。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOGIN_ATTEMPT_STORAGE_KEY,
  MAX_LOGIN_ATTEMPTS,
  SDK_LOAD_TIMEOUT_MS,
  bootLiff,
  liffPermanentLink,
  readLiffIdFromDocument,
  type AttemptStorage,
  type LiffLike,
} from "@/lib/liff/client";
import { CLIENT_ERROR_CODES, type ClientErrorCode } from "@/lib/telemetry";

const LIFF_ID = "2000000000-abcd1234";

/** `sessionStorage` の代役。`localStorage` は使わない（制約 N7）ので、ここにも出てこない。 */
function memoryStorage(initial: Record<string, string> = {}): AttemptStorage & {
  readonly dump: () => Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

interface FakeLiffOptions {
  readonly inClient?: boolean;
  readonly loggedIn?: boolean;
  readonly idToken?: string | null;
  readonly initRejects?: boolean;
}

function fakeLiff(options: FakeLiffOptions = {}) {
  const init = vi.fn(async () => {
    if (options.initRejects === true) throw new Error("init failed");
  });
  const isInClient = vi.fn(() => options.inClient ?? true);
  const isLoggedIn = vi.fn(() => options.loggedIn ?? true);
  const login = vi.fn();
  const getIDToken = vi.fn(() => (options.idToken === undefined ? "id-token" : options.idToken));

  const liff: LiffLike = { init, isInClient, isLoggedIn, login, getIDToken };
  return { liff, init, isInClient, isLoggedIn, login, getIDToken };
}

describe("bootLiff の起動順序", () => {
  let reported: ClientErrorCode[];

  beforeEach(() => {
    reported = [];
  });

  const report = (code: ClientErrorCode): void => {
    reported.push(code);
  };

  it("check_029: isInClient() が false なら login() を 1 回も呼ばず outside_line になる", async () => {
    const { liff, login, isInClient, isLoggedIn } = fakeLiff({ inClient: false, loggedIn: false });
    const storage = memoryStorage();

    const result = await bootLiff(LIFF_ID, {
      loadLiff: async () => liff,
      storage,
      report,
    });

    expect(result.state).toBe("outside_line");
    // ここが本体。LINE 外から開かれたときに login を呼ぶと R-LINE-02 のループになる。
    expect(login).not.toHaveBeenCalled();
    expect(isInClient).toHaveBeenCalled();
    // isInClient の判定は isLoggedIn より前。false なら isLoggedIn まで進まない。
    expect(isLoggedIn).not.toHaveBeenCalled();
    // 通常の利用状況なのでテレメトリは送らない。
    expect(reported).toEqual([]);
    // 試行回数も増やさない。
    expect(storage.dump()).toEqual({});
  });

  it("check_077: 未ログインのまま戻り続けても login は 2 回まで。3 回目は auth_unavailable", async () => {
    const storage = memoryStorage();
    const { liff, login } = fakeLiff({ inClient: true, loggedIn: false });

    const first = await bootLiff(LIFF_ID, { loadLiff: async () => liff, storage, report });
    expect(first.state).toBe("redirecting_to_login");
    expect(first.loginAttempts).toBe(1);

    const second = await bootLiff(LIFF_ID, { loadLiff: async () => liff, storage, report });
    expect(second.state).toBe("redirecting_to_login");
    expect(second.loginAttempts).toBe(2);

    const third = await bootLiff(LIFF_ID, { loadLiff: async () => liff, storage, report });
    expect(third.state).toBe("auth_unavailable");
    expect(third.loginAttempts).toBe(MAX_LOGIN_ATTEMPTS);

    // login は打ち切られている（3 回目は呼ばれていない）。
    expect(login).toHaveBeenCalledTimes(MAX_LOGIN_ATTEMPTS);
    expect(reported).toEqual([CLIENT_ERROR_CODES.LOGIN_LOOP_ABORTED]);
  });

  it("試行回数は sessionStorage の 1 キーだけに持つ", async () => {
    const storage = memoryStorage();
    const { liff } = fakeLiff({ inClient: true, loggedIn: false });

    await bootLiff(LIFF_ID, { loadLiff: async () => liff, storage, report });

    expect(storage.dump()).toEqual({ [LOGIN_ATTEMPT_STORAGE_KEY]: "1" });
  });

  it("ログインが成立したら試行回数を消して ID トークンを返す", async () => {
    const storage = memoryStorage({ [LOGIN_ATTEMPT_STORAGE_KEY]: "1" });
    const { liff, login } = fakeLiff({ inClient: true, loggedIn: true, idToken: "the-id-token" });

    const result = await bootLiff(LIFF_ID, { loadLiff: async () => liff, storage, report });

    expect(result.state).toBe("ready");
    expect(result.idToken).toBe("the-id-token");
    expect(login).not.toHaveBeenCalled();
    expect(storage.dump()).toEqual({});
    expect(reported).toEqual([]);
  });

  it("ログイン済みでも ID トークンが取れなければ auth_unavailable にする", async () => {
    const { liff } = fakeLiff({ inClient: true, loggedIn: true, idToken: null });

    const result = await bootLiff(LIFF_ID, {
      loadLiff: async () => liff,
      storage: memoryStorage(),
      report,
    });

    expect(result.state).toBe("auth_unavailable");
    expect(reported).toEqual([CLIENT_ERROR_CODES.LOGIN_LOOP_ABORTED]);
  });

  it("liff.init() が reject したら init_failed とテレメトリ liff_init_failed", async () => {
    const { liff, isInClient, login } = fakeLiff({ initRejects: true });

    const result = await bootLiff(LIFF_ID, {
      loadLiff: async () => liff,
      storage: memoryStorage(),
      report,
    });

    expect(result.state).toBe("init_failed");
    expect(result.reportedCode).toBe(CLIENT_ERROR_CODES.LIFF_INIT_FAILED);
    expect(reported).toEqual([CLIENT_ERROR_CODES.LIFF_INIT_FAILED]);
    // init に失敗したら以降の API には触らない。
    expect(isInClient).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("liff.init() には呼び出し元が渡した liffId がそのまま渡る", async () => {
    const { liff, init } = fakeLiff();

    await bootLiff(LIFF_ID, { loadLiff: async () => liff, storage: memoryStorage(), report });

    expect(init).toHaveBeenCalledWith({ liffId: LIFF_ID });
  });

  it("SDK を時間内に読めなければ sdk_unavailable とテレメトリ sdk_load_failed", async () => {
    const result = await bootLiff(LIFF_ID, {
      // 解決しない Promise = SDK のチャンクが返ってこない状況。
      loadLiff: () => new Promise<LiffLike>(() => undefined),
      storage: memoryStorage(),
      report,
      timeoutMs: 20,
    });

    expect(result.state).toBe("sdk_unavailable");
    expect(reported).toEqual([CLIENT_ERROR_CODES.SDK_LOAD_FAILED]);
  });

  it("SDK の読み込みが reject しても sdk_unavailable（例外を外へ投げない）", async () => {
    const result = await bootLiff(LIFF_ID, {
      loadLiff: async () => {
        throw new Error("chunk load error");
      },
      storage: memoryStorage(),
      report,
    });

    expect(result.state).toBe("sdk_unavailable");
    expect(reported).toEqual([CLIENT_ERROR_CODES.SDK_LOAD_FAILED]);
  });

  it("SDK 読み込みのタイムアウトは 3 秒（R-LINE-03）", () => {
    expect(SDK_LOAD_TIMEOUT_MS).toBe(3000);
  });

  it("ストレージが使えなくても（null）起動を止めない", async () => {
    const { liff, login } = fakeLiff({ inClient: true, loggedIn: false });

    const result = await bootLiff(LIFF_ID, { loadLiff: async () => liff, storage: null, report });

    expect(result.state).toBe("redirecting_to_login");
    expect(login).toHaveBeenCalledTimes(1);
  });
});

describe("readLiffIdFromDocument", () => {
  it("meta[name=x-liff-id] の content を返す", () => {
    const doc = {
      querySelector: (selector: string) =>
        selector === 'meta[name="x-liff-id"]'
          ? ({ getAttribute: () => LIFF_ID } as unknown as Element)
          : null,
    };

    expect(readLiffIdFromDocument(doc)).toBe(LIFF_ID);
  });

  it("meta が無ければ null（呼び出し側は静的フォールバックへ落とす）", () => {
    expect(readLiffIdFromDocument({ querySelector: () => null })).toBeNull();
  });
});

/**
 * `liffPermanentLink`（check_078 の「LINE アプリで開く」導線）。
 *
 * URL の形は `@line/liff` 2.31.0 の同梱物が一次資料である
 * （`docs/vendor-docs/line/liff-sdk.md` §4。`@liff/consts` の `PERMANENT_LINK_ORIGIN` が
 * `"https://liff.line.me/"`）。SDK の `liff.permanentLink.createUrl()` は `init` 成功後にしか
 * 使えないので、**SDK が落ちたときの導線**にはこちらを使う。
 */
describe("liffPermanentLink", () => {
  it("LIFF ID から https://liff.line.me/{liffId} を組み立てる", () => {
    expect(liffPermanentLink(LIFF_ID)).toBe(`https://liff.line.me/${LIFF_ID}`);
  });

  it("前後の空白は落とす", () => {
    expect(liffPermanentLink(`  ${LIFF_ID}\n`)).toBe(`https://liff.line.me/${LIFF_ID}`);
  });

  it("空の LIFF ID には null を返す（壊れたリンクを出さない）", () => {
    expect(liffPermanentLink("")).toBeNull();
    expect(liffPermanentLink("   ")).toBeNull();
  });
});
