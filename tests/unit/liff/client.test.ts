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
  /** `liff.init()` が **settle しない**（reject もしない）状況。電波が悪いときの実態。 */
  readonly initHangs?: boolean;
}

function fakeLiff(options: FakeLiffOptions = {}) {
  const init = vi.fn(async () => {
    if (options.initHangs === true) return new Promise<void>(() => undefined);
    if (options.initRejects === true) throw new Error("init failed");
    return undefined;
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

  it("liff.init() が解決しないまま時間切れになったら init_failed（白画面にしない / R-LINE-03）", async () => {
    // `init` は LINE のサーバーへ設定を取りに行くネットワーク処理なので、
    // 「reject する」だけでなく「**返ってこない**」経路が実在する。素の await に戻すと
    // この it は 5 秒のテストタイムアウトで落ちる（＝ bootLiff が解決しないことの検出）。
    const { liff, isInClient, login } = fakeLiff({ initHangs: true });

    const result = await bootLiff(LIFF_ID, {
      loadLiff: async () => liff,
      storage: memoryStorage(),
      report,
      timeoutMs: 20,
    });

    expect(result.state).toBe("init_failed");
    expect(result.reportedCode).toBe(CLIENT_ERROR_CODES.LIFF_INIT_FAILED);
    expect(reported).toEqual([CLIENT_ERROR_CODES.LIFF_INIT_FAILED]);
    // 打ち切った後も以降の API には触らない。
    expect(isInClient).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  /**
   * GPT-6 Astra F-2 の repro を **既定のタイムアウト**（`timeoutMs` を注入しない）でなぞる。
   *
   * 封筒の手順は「`loadLiff` は即時に SDK を返す → その SDK の `init` は
   * `() => new Promise(() => {})` → 3100 ミリ秒待つ → `report` が呼ばれていない」だった。
   * 実時間で 3.1 秒待つ代わりに偽タイマーを 3000 ミリ秒進めて同じ点を見る
   * （`SDK_LOAD_TIMEOUT_MS` が `init` 側にも掛かっていることの確認であり、
   * 上の `timeoutMs: 20` のケースと違って**既定値の配線**を見ている）。
   */
  it("既定のタイムアウトは init にも掛かる（F-2 の repro を timeoutMs 未指定でなぞる）", async () => {
    vi.useFakeTimers();
    try {
      const { liff, login } = fakeLiff({ initHangs: true });
      // SDK の読み込みは即時に成功する。止まるのは init だけ。
      const pending = bootLiff(LIFF_ID, {
        loadLiff: async () => liff,
        storage: memoryStorage(),
        report,
      });

      await vi.advanceTimersByTimeAsync(SDK_LOAD_TIMEOUT_MS);
      const result = await pending;

      expect(result.state).toBe("init_failed");
      expect(reported).toEqual([CLIENT_ERROR_CODES.LIFF_INIT_FAILED]);
      expect(login).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  /**
   * ストレージが使えないときの打ち切り（GPT-6 Astra F-1 / high）。
   *
   * 指摘の repro は「`storage: null` で `bootLiff` を 3 回呼ぶと 3 回とも
   * `redirecting_to_login` になり、`login` が 3 回呼ばれる」だった。ストレージが無いと
   * カウンタがどこにも残らないため、打ち切り（§7-3）がまるごと効かない。
   *
   * 退避先は **モジュール内のカウンタ**（このページが生きている間だけ数える）なので、
   * テストの独立性は `vi.resetModules()` ＋ 動的 import で確保する。
   * 静的 import 側のモジュール実体を共有すると、前のテストの残数が次のテストへ漏れる。
   */
  describe("ストレージが使えないときも打ち切る（F-1 / fail-closed）", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    /** 読み書きの両方が throw するストレージ（Safari のプライベートモード等）。 */
    function throwingStorage(): AttemptStorage {
      return {
        getItem: () => {
          throw new Error("storage is not available");
        },
        setItem: () => {
          throw new Error("storage is not available");
        },
        removeItem: () => {
          throw new Error("storage is not available");
        },
      };
    }

    it("storage が null でも 3 回目の未ログインでは login を呼ばず auth_unavailable", async () => {
      const { bootLiff: boot } = await import("@/lib/liff/client");
      const { liff, login } = fakeLiff({ inClient: true, loggedIn: false });
      const deps = { loadLiff: async () => liff, storage: null, report };

      const first = await boot(LIFF_ID, deps);
      expect(first.state).toBe("redirecting_to_login");
      expect(first.loginAttempts).toBe(1);

      const second = await boot(LIFF_ID, deps);
      expect(second.state).toBe("redirecting_to_login");
      expect(second.loginAttempts).toBe(2);

      const third = await boot(LIFF_ID, deps);
      expect(third.state).toBe("auth_unavailable");
      expect(third.loginAttempts).toBe(MAX_LOGIN_ATTEMPTS);

      // ここが F-1 の本体。ストレージが無くても 3 回目は login を呼ばない。
      expect(login).toHaveBeenCalledTimes(MAX_LOGIN_ATTEMPTS);
      expect(reported).toEqual([CLIENT_ERROR_CODES.LOGIN_LOOP_ABORTED]);
    });

    it("storage の読み書きが例外を投げても 3 回目は login を呼ばず auth_unavailable", async () => {
      const { bootLiff: boot } = await import("@/lib/liff/client");
      const { liff, login } = fakeLiff({ inClient: true, loggedIn: false });
      const deps = { loadLiff: async () => liff, storage: throwingStorage(), report };

      expect((await boot(LIFF_ID, deps)).state).toBe("redirecting_to_login");
      expect((await boot(LIFF_ID, deps)).state).toBe("redirecting_to_login");

      const third = await boot(LIFF_ID, deps);
      expect(third.state).toBe("auth_unavailable");
      expect(third.loginAttempts).toBe(MAX_LOGIN_ATTEMPTS);
      expect(login).toHaveBeenCalledTimes(MAX_LOGIN_ATTEMPTS);
      expect(reported).toEqual([CLIENT_ERROR_CODES.LOGIN_LOOP_ABORTED]);
    });

    it("ログインが成立したら退避先のカウンタも消える（次の障害を独立に数える）", async () => {
      const { bootLiff: boot } = await import("@/lib/liff/client");
      const loggedOut = fakeLiff({ inClient: true, loggedIn: false });

      await boot(LIFF_ID, { loadLiff: async () => loggedOut.liff, storage: null, report });
      await boot(LIFF_ID, { loadLiff: async () => loggedOut.liff, storage: null, report });

      // ここでログインが成立する。
      const loggedIn = fakeLiff({ inClient: true, loggedIn: true, idToken: "the-id-token" });
      const ok = await boot(LIFF_ID, { loadLiff: async () => loggedIn.liff, storage: null, report });
      expect(ok.state).toBe("ready");

      // 再び未ログインになっても、カウンタは 0 から数え直す。
      const again = await boot(LIFF_ID, {
        loadLiff: async () => loggedOut.liff,
        storage: null,
        report,
      });
      expect(again.state).toBe("redirecting_to_login");
      expect(again.loginAttempts).toBe(1);
    });

    it("storage が書けなかった回の分も数える（読めるが書けないストレージ）", async () => {
      const { bootLiff: boot } = await import("@/lib/liff/client");
      const { liff, login } = fakeLiff({ inClient: true, loggedIn: false });
      // 読みは成功して常に「未記録」を返し、書きだけ落ちる（容量超過の quota エラー等）。
      const readOnlyStorage: AttemptStorage = {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => undefined,
      };
      const deps = { loadLiff: async () => liff, storage: readOnlyStorage, report };

      expect((await boot(LIFF_ID, deps)).state).toBe("redirecting_to_login");
      expect((await boot(LIFF_ID, deps)).state).toBe("redirecting_to_login");
      expect((await boot(LIFF_ID, deps)).state).toBe("auth_unavailable");
      expect(login).toHaveBeenCalledTimes(MAX_LOGIN_ATTEMPTS);
    });
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
