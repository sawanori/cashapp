# LIFF SDK（@line/liff）の API 面 — 一次資料の退避

**取得日: 2026-09-24**
**取得元: 本リポジトリの `node_modules` に実際にインストールされている配布物そのもの**
（npm レジストリから取得した公式パッケージ。ネットワーク越しの二次情報ではない）

| パッケージ | バージョン | 退避した根拠ファイル |
|---|---|---|
| `@line/liff` | 2.31.0 | `node_modules/@line/liff/package.json`、`index.d.ts`、`@liff/*` の `lib/index.d.ts` |
| `@line/liff-mock` | 1.0.4 | `node_modules/@line/liff-mock/package.json`、`README.md` |

`docs/implementation-plan.md` §7-3 の「LIFF SDK は CDN 直リンクではなく npm でバージョン固定して
バンドルする」（R-LINE-03）に従い、SDK は npm 依存として固定済みである。したがって
**型定義そのものが一次資料**であり、ここに写した名前と引数は推測ではない。

---

## 1. `liff.init`

`node_modules/@liff/init/lib/index.d.ts`:

```ts
type Init = (
  config: Config,
  successCallback?: () => void,
  errorCallback?: (error: Error) => void,
) => Promise<void>;
```

`node_modules/@liff/types/index.d.ts`:

```ts
// init
export interface Config {
  liffId: string;
  analytics?: AnalyticsOption;
  withLoginOnExternalBrowser?: boolean;
}
```

読み取れる事実:

- `init` は `Promise<void>` を返す。**失敗は reject で届く**ので `try/catch`（または `.catch`）で
  機械可読なコードに分類できる（R-LINE-03 の要求）。
- 必須の設定は `liffId` のみ。
- `withLoginOnExternalBrowser` は **外部ブラウザで自動的にログインさせる**オプションである。
  本アプリはこれを **使わない**。使うと `isInClient()` の判定より前に LINE の認可画面へ飛び、
  R-LINE-02（ログインループ）そのものを再現してしまう。

## 2. `liff.isInClient` / `liff.isLoggedIn` / `liff.login` / `liff.getIDToken`

```ts
// node_modules/@liff/is-in-client/lib/index.d.ts
export declare function isInClient(): boolean;

// node_modules/@liff/is-logged-in/lib/index.d.ts
export declare function isLoggedIn(): boolean;

// node_modules/@liff/login/lib/index.d.ts
type Login = (config?: { redirectUri?: string }) => void;

// node_modules/@liff/store/lib/idToken.d.ts
export declare function getIDToken(): string | null;
```

読み取れる事実:

- `isInClient()` と `isLoggedIn()` は **同期の boolean** であり、`init` の解決後に評価できる。
  したがって「`init` → `isInClient` → `isLoggedIn` → `login`」という順序は SDK の API 形状として
  素直に書ける（§7-3）。
- `login()` は `void` を返す。**呼んだ時点でページ遷移が起きる**ので、戻り値から成否は分からない。
  ループの打ち切りは呼ぶ側（`src/lib/liff/client.ts`）が試行回数で持つしかない。
- `getIDToken()` は `string | null`。`null` を返しうるので、非 null を前提に組まない。

## 3. `@line/liff-mock`（E2E 用。本番バンドルに入れない）

`node_modules/@line/liff-mock/README.md` より（原文の引用）:

```ts
import liff from '@line/liff';
import { LiffMockPlugin } from '@line/liff-mock';

liff.use(new LiffMockPlugin());

liff.init({
  liffId: 'liff-xxxx',
  mock: true, // enable mock mode
});
```

読み取れる事実:

- モックは **LIFF Plugin** として `liff.use()` で差し込む。SDK 本体を差し替えるのではない。
- モードの有効化は `init` の設定に `mock: true` を足す形である（`@liff/types` の `Config` には
  `mock` が無い。プラグインが拡張する）。本リポジトリでは `src/lib/liff/client.ts` の
  `LiffInitConfig` に `mock?: boolean` を持たせて渡す。
- 制約 I4（「モック版は動的 import で本番バンドルに入れない」）に従い、`@line/liff-mock` の
  import は `src/lib/liff/mock.ts` の中だけに置き、`src/lib/liff/client.ts` からは
  `process.env.NEXT_PUBLIC_LIFF_MOCK === "1"` のガード内の動的 import でしか到達しない。

## 4. ここに書いていないこと（未取得）

- LINE アプリが要求する OS 最小バージョン（`docs/supported-browsers.md` の [不明] 項目。T-P1-23）。
- `shareTargetPicker` の最低 LINE バージョン（`docs/research/research-line-miniapp.md` §未解決 4。
  公式の推奨は `liff.isApiAvailable()` による実行時判定）。task_016 の担当。
- LIFF エンドポイント URL の設定・審査まわりの運用手順（LINE Developers コンソール側）。task_025。
