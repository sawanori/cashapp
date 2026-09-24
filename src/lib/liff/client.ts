/**
 * LIFF の起動順序とループ防止（§7-3 / R-LINE-02 / R-LINE-03 / check_029 / check_077）。
 *
 * ★ 順序は 1 つしかない。**この順序を崩す実装を他所に書かないこと。**
 *
 *     SDK を読む（3 秒タイムアウト） → liff.init()（**同じく 3 秒タイムアウト**）
 *       → isInClient() が false なら **login を呼ばずに** outside_line
 *       → isLoggedIn() が false なら 試行回数を見て login か auth_unavailable
 *       → getIDToken()
 *
 * ★ タイムアウトは **2 か所**に要る。SDK チャンクの取得だけでなく、`liff.init()` も
 *   LINE のサーバーへ LIFF アプリ設定を取りに行く**ネットワーク処理**であり、電波が悪い・
 *   応答が返らない場面では reject もせず settle しない。`init` を素の `await` にすると
 *   `bootLiff()` が永久に解決せず、画面は loading のまま＝ R-LINE-03 が防ぎたい白画面になる
 *   （`sdk_unavailable` も `init_failed` も返らないので静的フォールバックが出る機会が無い）。
 *   `liff.init()` が時間内に解決しなければ `init_failed` として扱う。
 *
 *   `isInClient` の判定を `login` より **前** に置くことがこのモジュールの存在理由である。
 *   逆順（`isLoggedIn() ? … : login()` を無条件に書く）にすると、LINE 外から開いた利用者が
 *   login → 認可 → 復帰 → isLoggedIn false → 再 login を往復し、白画面が点滅し続ける（R-LINE-02）。
 *
 * ★ 試行回数は `sessionStorage` に持つ。**永続する側のブラウザストレージは使わない**
 *   （制約 N7 が名指しで禁じている置き場であり、gate:constraints が語として検出する）。
 *   セッション（タブ）を閉じれば消えてよい性質の値であり、支払状態・認証状態ではない。
 *   制約 N7 の注記が `sessionStorage` をこの用途に限って許している。
 *
 *   **`sessionStorage` が使えない環境でも打ち切りは効かせる。** SSR 中・Safari の
 *   プライベートモード等では `sessionStorage` へのアクセス自体が throw する。そこで
 *   「読めない・書けない」を 0 とみなすと、未ログインで戻るたびに `login()` が呼ばれて
 *   R-LINE-02 の往復がそのまま起きる。読み書きが成立しない回はモジュール内の
 *   退避カウンタ（`memoryAttemptsByScope`）で数え、上限に達したら同じように
 *   `auth_unavailable` に落とす（fail-closed）。保存値と退避先は**大きいほう**を採る。
 *   退避先の有効範囲はページ 1 回分なので `sessionStorage` の代用ではない。
 *
 * ★ SDK は npm 依存として固定したものを **動的 import** で読む（R-LINE-03、制約 I4）。
 *   CDN の直リンクは使わない。モック（`@line/liff-mock`）へ到達する経路は
 *   `process.env.NEXT_PUBLIC_LIFF_MOCK === "1"` のガードの内側だけにある。
 *
 *   **この分岐が落ちる条件は「変数が未設定であること」ではない。`"1"` 以外の値が
 *   設定されていることである。** Next.js がクライアント側の `process.env.NEXT_PUBLIC_*` を
 *   定数へ置換するのは `node_modules/next/dist/lib/static-env.js` の
 *   `getNextPublicEnvironmentVariables()` で、実装が `for (const key in process.env)` ＝
 *   **存在するキーだけ**を define にするため、未設定だと置換自体が起きず、
 *   `await import("./mock")` が到達可能なまま `@line/liff-mock` ごとチャンク化される（実測）。
 *   そのため `package.json` の `build` / `build:cf` と `scripts/build-web-only.mjs` は
 *   `NEXT_PUBLIC_LIFF_MOCK=0` を明示的に渡す。`npm run build:web-only` は
 *   その右辺が `0` に**固定**されていること（外部から上書きできる書き方でないこと）まで検査する。
 *
 * ★ 失敗は**必ず**機械可読なコードに分類して `POST /api/telemetry/client-error` へ 1 回だけ送る。
 *   例外メッセージ・スタック・URL は送らない（`src/lib/telemetry.ts`）。
 *
 * ★ このモジュールは `server-only` ではない（クライアントで動くのが仕事）。
 *   秘密値を一切持ち込まないこと。LIFF ID は秘密値ではないが、**バンドルに焼き込まない**
 *   （R-LINE-04 の「production バンドルに dev / review の LIFF ID が含まれない」grep のため）。
 *   実行時に `(liff)` レイアウトが埋める `<meta name="x-liff-id">` から読む。
 */

import {
  CLIENT_ERROR_CODES,
  reportClientError,
  type ClientErrorCode,
} from "@/lib/telemetry";

/** `liff.init()` に渡す設定。`mock` は `@line/liff-mock` が足す拡張（docs/vendor-docs/line/liff-sdk.md §3）。 */
export interface LiffInitConfig {
  readonly liffId: string;
  readonly mock?: boolean;
}

/**
 * 本モジュールが使う LIFF SDK の面だけを写した型。
 *
 * SDK 全体の型をそのまま使わないのは、`getProfile` / `getDecodedIDToken` のような
 * 「サーバーへ送ってはいけない値を返す API」（制約 N2）へ手が伸びないようにするためである。
 * 署名は `docs/vendor-docs/line/liff-sdk.md`（取得日 2026-09-24）に写した型定義と同じ。
 */
export interface LiffLike {
  init(config: LiffInitConfig): Promise<void>;
  isInClient(): boolean;
  isLoggedIn(): boolean;
  login(config?: { redirectUri?: string }): void;
  getIDToken(): string | null;
}

/**
 * SDK の読み込みと `liff.init()` のそれぞれに許す時間。超えたら静的フォールバックへ落とす（R-LINE-03）。
 *
 * ★ 両方に同じ値を掛ける。`init` はネットワーク処理なので、掛けそびれると
 *   「SDK は読めたが init が返らない」経路だけが無制限に待ち続ける。
 */
export const SDK_LOAD_TIMEOUT_MS = 3000;

/**
 * `liff.login()` を呼んでよい回数の上限（§7-3「sessionStorage の試行回数 2 回で打ち切り」）。
 *
 * 数え方: 「未ログインで戻ってきた」状態で `login()` を呼ぶたびに 1 増やす。
 * カウンタが 2 に達している状態でまた未ログインなら、**3 回目は呼ばず** `auth_unavailable` にする。
 * ログインが成立したらカウンタを消す（次の障害を独立に数えるため）。
 */
export const MAX_LOGIN_ATTEMPTS = 2;

/** 試行回数の置き場。衝突しないよう名前空間を付ける。 */
export const LOGIN_ATTEMPT_STORAGE_KEY = "cashapp.liff.loginAttempts";

/** `(liff)` レイアウトが LIFF ID を実行時に渡すための meta 名。 */
export const LIFF_ID_META_NAME = "x-liff-id";

/** 起動の結末。画面はこの値だけを見て `StateView` の状態を決める。 */
export type LiffBootState =
  /** ID トークンまで取れた。`/api/auth/line` へ進んでよい。 */
  | "ready"
  /** LINE アプリの外から開かれた。**`login()` は呼んでいない**（R-LINE-02）。 */
  | "outside_line"
  /** ログインの試行回数を使い切った、または ID トークンが取れなかった。 */
  | "auth_unavailable"
  /** `login()` を呼んだ。この直後にページ遷移が起きる。 */
  | "redirecting_to_login"
  /** SDK を 3 秒以内に読めなかった。静的フォールバックを出す。 */
  | "sdk_unavailable"
  /** `liff.init()` が reject した。静的フォールバックを出す。 */
  | "init_failed";

export interface LiffBootResult {
  readonly state: LiffBootState;
  /** `state === "ready"` のときだけ入る。**ここからサーバーへ送ってよい唯一の値**。 */
  readonly idToken?: string;
  /** テレメトリへ送ったコード（送っていなければ未定義）。テストと画面の突き合わせ用。 */
  readonly reportedCode?: ClientErrorCode;
  /** `login()` を呼んだ後のカウンタ値。テストが打ち切りの根拠を確かめるために見る。 */
  readonly loginAttempts: number;
}

/** 試行回数の読み書きに使う最小面。`sessionStorage` をそのまま渡せる。 */
export interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BootLiffDeps {
  /** SDK を読む関数。既定は `@line/liff`（モック有効時は `./mock`）の動的 import。 */
  readonly loadLiff?: () => Promise<LiffLike>;
  /** 試行回数の置き場。既定はブラウザの `sessionStorage`。 */
  readonly storage?: AttemptStorage | null;
  /** テレメトリ送信。既定は `reportClientError`。 */
  readonly report?: (code: ClientErrorCode) => void | Promise<void>;
  /** SDK 読み込みのタイムアウト。既定は `SDK_LOAD_TIMEOUT_MS`。 */
  readonly timeoutMs?: number;
}

/**
 * モックを使うかどうか。
 *
 * ビルド時に定数へ畳まれるのは **`NEXT_PUBLIC_LIFF_MOCK` が `"1"` 以外の値で設定されている**
 * ときだけである（未設定だと define が作られず、実行時判定のまま残る。冒頭の注記を参照）。
 */
function isMockEnabled(): boolean {
  return process.env["NEXT_PUBLIC_LIFF_MOCK"] === "1";
}

/**
 * SDK を読む既定の実装。
 *
 * モックへ到達する経路は `isMockEnabled()` の内側にしか無い。本番ビルドは
 * `NEXT_PUBLIC_LIFF_MOCK=0` を明示的に渡すので `process.env.NEXT_PUBLIC_LIFF_MOCK` が
 * `"0"` に畳まれ、`./mock` を指す動的 import ごと到達不能になる（制約 I4 / check_079）。
 */
async function defaultLoadLiff(): Promise<LiffLike> {
  if (isMockEnabled()) {
    const mock = await import("./mock");
    return mock.loadMockedLiff();
  }
  const sdk = await import("@line/liff");
  return sdk.default as unknown as LiffLike;
}

/** 既定の置き場。SSR 中やストレージが使えない環境では `null` を返す。 */
function defaultStorage(): AttemptStorage | null {
  try {
    if (typeof globalThis.sessionStorage === "undefined") return null;
    return globalThis.sessionStorage;
  } catch {
    // Safari のプライベートモード等でアクセス自体が throw することがある。
    return null;
  }
}

/**
 * 試行回数の**退避先カウンタ**（スコープごとに 1 つ）。
 *
 * ★ これが無いと打ち切りがまるごと効かない。`storage` が `null`（SSR・
 *   `sessionStorage` へのアクセス自体が throw する Safari のプライベートモード等）や、
 *   読み書きが例外になる環境では、素直に書くと `readAttempts` が毎回 0 を返し
 *   `writeAttempts` が何も残さないため、未ログインで戻ってくるたびに `login()` が呼ばれ、
 *   R-LINE-02 が防ぎたい往復がそのまま起きる。**数えられないなら打ち切らない**ではなく、
 *   **数えられる場所へ退避して打ち切る**（fail-closed）。
 *
 * ★ スコープは**置き場オブジェクトではない**。既定の経路（`deps.storage` 未指定＝本番）は
 *   `defaultStorage()` が返す値が `sessionStorage` だったり `null` だったりしても
 *   常に同じ `DEFAULT_STORAGE_SCOPE` で数える。置き場ごとに分けると、
 *   参照できていた間の数と `null` になった後の数が別勘定になって打ち切りが外れる（C-013-19）。
 *   呼び出し側が置き場を注入したときだけ、その置き場ごとに分ける。
 *
 * ★ 有効範囲はこのモジュールが生きている間 ＝ **このページ（タブの 1 回の読み込み）**である。
 *   `login()` → LINE の認可画面 → 復帰でページが作り直されればここも 0 に戻るので、
 *   これは `sessionStorage` の代わりではなく、`sessionStorage` が使えないときの**最後の砦**である。
 *   再読み込みをまたいで数え続けたい場合は URL などページの外へ持ち出す必要があり、
 *   それは本モジュールの担当ではない（`docs/concerns/task_013.md` C-013-13）。
 */
const memoryAttemptsByScope = new WeakMap<object, number>();

/**
 * 既定の置き場（`defaultStorage()`）を使う経路＝**本番**のスコープ。
 *
 * ★ ここを「`sessionStorage` オブジェクトごと」にしてはいけない。`defaultStorage()` は
 *   `sessionStorage` への参照自体が throw する状況で `null` を返すので、
 *   参照できていた間の数と `null` になった後の数が**別勘定**になり、3 回目の `login()` が通る
 *   （`docs/concerns/task_013.md` C-013-19）。本番でカウンタが属する単位は
 *   置き場オブジェクトではなく**ページ**である。
 */
const DEFAULT_STORAGE_SCOPE: object = {};

/** 呼び出し側が `storage: null` を明示した経路のスコープ。 */
const INJECTED_NULL_SCOPE: object = {};

/**
 * 退避先を引くためのキー。
 *
 * 既定の置き場を使うとき（`deps.storage` 未指定＝本番）は常に同じページ用スコープ。
 * 呼び出し側が置き場を注入したときは、その置き場ごとに分ける（注入した側の期待に合わせる）。
 */
function attemptScope(storage: AttemptStorage | null, injected: boolean): object {
  if (!injected) return DEFAULT_STORAGE_SCOPE;
  return storage ?? INJECTED_NULL_SCOPE;
}

function readMemoryAttempts(scope: object): number {
  return memoryAttemptsByScope.get(scope) ?? 0;
}

/** 退避先は**減らさない**（一度数えた試行はこのページの中で消えない）。 */
function writeMemoryAttempts(scope: object, value: number): void {
  memoryAttemptsByScope.set(scope, Math.max(memoryAttemptsByScope.get(scope) ?? 0, value));
}

function clearMemoryAttempts(scope: object): void {
  memoryAttemptsByScope.delete(scope);
}

/** `storage` に残っている値。読めない・壊れている・置き場が無いときは 0。 */
function readStoredAttempts(storage: AttemptStorage | null): number {
  if (storage === null) return 0;
  try {
    const raw = storage.getItem(LOGIN_ATTEMPT_STORAGE_KEY);
    if (raw === null) return 0;
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * 試行回数。**保存値と退避先の大きいほう**を採る。
 *
 * ★ 保存値を優先してはいけない。「読めるが書けない」ストレージ（quota 超過など）では
 *   `getItem` が古い値を返し続ける一方 `setItem` は落ちるので、保存値を信じると
 *   カウンタが永久に進まず `login()` を呼び続ける（再読み込みをまたがなくても起きる）。
 *   大きいほうを採れば、どちらか一方でも数えられている限り打ち切りに到達する。
 */
function readAttempts(storage: AttemptStorage | null, scope: object): number {
  return Math.max(readMemoryAttempts(scope), readStoredAttempts(storage));
}

/**
 * 試行回数を残す。**退避先は書けたかどうかに関わらず必ず更新する。**
 *
 * ★ 「`setItem` が成功したら退避先は要らない」としてはいけない。2 回保存できた後に
 *   ストレージが使えなくなると（タブ復帰時の quota 逼迫・プライベートモードへの切り替え等）、
 *   保存値も読めず退避先も 0 のままになり、3 回目の `login()` が通る。
 *   同じページの中で起きるので、再読み込みによる消失とは別の経路である。
 */
function writeAttempts(storage: AttemptStorage | null, scope: object, value: number): void {
  writeMemoryAttempts(scope, value);
  if (storage === null) return;
  try {
    storage.setItem(LOGIN_ATTEMPT_STORAGE_KEY, String(value));
  } catch {
    // 書けなくても退避先で数え続けられる。
  }
}

function clearAttempts(storage: AttemptStorage | null, scope: object): void {
  clearMemoryAttempts(scope);
  if (storage === null) return;
  try {
    storage.removeItem(LOGIN_ATTEMPT_STORAGE_KEY);
  } catch {
    // 同上。
  }
}

/** 3 秒で諦めるための競争。タイムアウト側が勝ったら `null`。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `(liff)` レイアウトが埋めた `<meta name="x-liff-id">` から LIFF ID を読む。
 *
 * **ビルド時に値を焼き込まない**ための経路である（R-LINE-04）。
 * 見つからなければ `null`（呼び出し側は静的フォールバックへ落とす）。
 */
export function readLiffIdFromDocument(doc?: Pick<Document, "querySelector">): string | null {
  const target = doc ?? (typeof document === "undefined" ? undefined : document);
  if (target === undefined) return null;
  const element = target.querySelector(`meta[name="${LIFF_ID_META_NAME}"]`);
  if (element === null) return null;
  const content = element.getAttribute("content");
  return content !== null && content.length > 0 ? content : null;
}

/**
 * LIFF ID から「LINE アプリで開く」ためのパーマネントリンクを組み立てる。
 *
 * ★ 出どころは推測ではない。`@line/liff` 2.31.0 の同梱物がそのまま一次資料である
 *   （`docs/vendor-docs/line/liff-sdk.md` §4、取得日 2026-09-24）。
 *   `node_modules/@liff/permanent-link/lib/index.es.js` の `createUrl` は
 *   `PERMANENT_LINK_ORIGIN + getConfig().liffId + パス` を返し、
 *   `@liff/consts` の `PERMANENT_LINK_ORIGIN` は `"https://liff.line.me/"` である。
 *
 * ★ SDK の `liff.permanentLink.createUrl()` は `liff.init()` の成功後にしか使えない
 *   （サーバーから取った context が要る）。**SDK が落ちたときの導線**にはそれでは間に合わないので、
 *   ここでは LIFF ID だけから組み立てる。したがって `StaticFallback` / `StateView` の
 *   「LINE アプリで開く」は `init` が失敗していても出せる（check_078）。
 *
 * @param liffId `(liff)` レイアウトが実行時に渡した LIFF ID。
 * @returns 空文字の `liffId` を渡されたときは `null`（壊れたリンクを出さない）。
 */
export function liffPermanentLink(liffId: string): string | null {
  const trimmed = liffId.trim();
  if (trimmed.length === 0) return null;
  return `https://liff.line.me/${encodeURIComponent(trimmed)}`;
}

/**
 * LIFF を起動する。**例外を投げない**（呼び出し側は必ず `state` で分岐できる）。
 *
 * @param liffId `(liff)` レイアウトが実行時に渡した LIFF ID。
 */
export async function bootLiff(liffId: string, deps: BootLiffDeps = {}): Promise<LiffBootResult> {
  const injectedStorage = deps.storage !== undefined;
  const storage = injectedStorage ? deps.storage : defaultStorage();
  // 退避先のスコープは**置き場が取れたかどうかより前**に決める。既定の経路（本番）は
  // `defaultStorage()` が `null` を返した回も同じスコープで数える（C-013-19）。
  const scope = attemptScope(storage, injectedStorage);
  const report = deps.report ?? ((code: ClientErrorCode) => void reportClientError(code));
  const timeoutMs = deps.timeoutMs ?? SDK_LOAD_TIMEOUT_MS;
  const loadLiff = deps.loadLiff ?? defaultLoadLiff;

  const fail = async (
    state: LiffBootState,
    code: ClientErrorCode,
    attempts: number,
  ): Promise<LiffBootResult> => {
    await report(code);
    return { state, reportedCode: code, loginAttempts: attempts };
  };

  // --- 1. SDK を読む（3 秒で打ち切る） ---
  let liff: LiffLike | null;
  try {
    liff = await withTimeout(loadLiff(), timeoutMs);
  } catch {
    liff = null;
  }
  if (liff === null) {
    return fail("sdk_unavailable", CLIENT_ERROR_CODES.SDK_LOAD_FAILED, readAttempts(storage, scope));
  }

  // --- 2. init（reject だけでなく「返ってこない」も打ち切る） ---
  //   `liff.init()` は LINE のサーバーへ LIFF アプリ設定を取りに行くネットワーク処理なので、
  //   素の `await` にすると settle しない経路で `bootLiff()` ごと止まり、画面は loading のまま
  //   （＝白画面）になる。タイムアウト側が勝ったら `null` が返るので、reject と同じ結末にする。
  let initialized: true | null;
  try {
    initialized = await withTimeout(
      liff.init({ liffId, ...(isMockEnabled() ? { mock: true } : {}) }).then(() => true as const),
      timeoutMs,
    );
  } catch {
    initialized = null;
  }
  if (initialized === null) {
    return fail("init_failed", CLIENT_ERROR_CODES.LIFF_INIT_FAILED, readAttempts(storage, scope));
  }

  // --- 3. isInClient（login より前！ R-LINE-02 / check_029） ---
  if (!liff.isInClient()) {
    // ここで `login()` を呼ばないことがこの分岐の全てである。テレメトリも送らない
    // （LINE 外から開くのは障害ではなく通常の利用状況であり、件数は画面表示側で数える）。
    return { state: "outside_line", loginAttempts: readAttempts(storage, scope) };
  }

  // --- 4. isLoggedIn と試行回数の打ち切り ---
  if (!liff.isLoggedIn()) {
    const attempts = readAttempts(storage, scope);
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      return fail("auth_unavailable", CLIENT_ERROR_CODES.LOGIN_LOOP_ABORTED, attempts);
    }
    const next = attempts + 1;
    writeAttempts(storage, scope, next);
    liff.login();
    return { state: "redirecting_to_login", loginAttempts: next };
  }

  // --- 5. ID トークン ---
  const idToken = liff.getIDToken();
  if (idToken === null || idToken.length === 0) {
    return fail("auth_unavailable", CLIENT_ERROR_CODES.LOGIN_LOOP_ABORTED, readAttempts(storage, scope));
  }

  clearAttempts(storage, scope);
  return { state: "ready", idToken, loginAttempts: 0 };
}
