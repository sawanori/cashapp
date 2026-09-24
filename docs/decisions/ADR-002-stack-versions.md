# ADR-002: 採用パッケージの実測バージョン

- ステータス: accepted
- Confidence: high（すべて `npm view`／実インストール／実行での実測 [実測]。推測は無い）
- 関連: implementation-plan.md §7-2, §13, A15, A20 / task_003

## Context

implementation-plan.md §7-2 はフレームワーク・ライブラリの採用を確定しているが、具体バージョンは
「task_003 で実測」とされていた（A15）。本 ADR はそのバージョン決定を記録する。

## 決定（実測結果）

取得日: 2026-09-24。取得コマンド: `npm view <pkg> version`（各パッケージ個別）。
Node.js `v22.22.0` / npm `10.9.4`（実測、`engines.node ">=22"` を満たす）。

### dependencies（ランタイム）

| パッケージ | バージョン |
|---|---|
| next | 16.3.6 |
| react | 19.3.0 |
| react-dom | 19.3.0 |
| drizzle-orm | 0.45.3 |
| postgres | 3.4.9 |
| jose | 6.2.12 |
| zod | 4.6.5 |
| @line/liff | 2.31.0 |
| server-only | 0.0.1 |

### devDependencies（開発・ビルド・テスト）

| パッケージ | バージョン |
|---|---|
| typescript | 5.9.3 |
| @types/node | 26.6.2 |
| @types/react | 19.3.0 |
| @types/react-dom | 19.3.0 |
| eslint | 9.39.5 |
| eslint-config-next | 16.3.6 |
| vitest | 5.0.1 |
| @vitejs/plugin-react | 6.1.1 |
| jsdom | 29.1.1 |
| @testing-library/react | 16.3.3 |
| @testing-library/jest-dom | 7.0.1 |
| @playwright/test | 1.63.0 |
| @axe-core/playwright | 4.13.0 |
| drizzle-kit | 0.31.11 |
| @line/liff-mock | 1.0.4 |
| @opennextjs/cloudflare | 1.20.6 |
| wrangler | 4.137.0 |
| yaml | 2.9.1 |
| tsx | 4.23.15 |

すべて `--save-exact`（`.npmrc` の `save-exact=true` も併用）で `^`/`~` 無しの完全固定。

## 依頼リストからの逸脱と理由

1. **`jsdom` は依頼された最新版ではなく `29.1.1` を採用**（依頼時点の最新 `30.1.1` ではない）。
   実測: `jsdom@30.1.1` は `engines.node` が `^22.22.2 || ^24.15.0 || >=26.0.0` を要求し、
   本機の Node `v22.22.0` とは合致しない（`npm error EBADENGINE`、`.npmrc` の
   `engine-strict=true` により即座に失敗）。`jsdom@29.1.1` は `engines.node` が
   `^20.19.0 || ^22.13.0 || >=24.0.0` であり `v22.22.0` を満たすため、これを採用した。
2. **`eslint` は依頼された最新版 `10.11.0` ではなく `9.39.5`（9系最新）を採用**。
   実測: `eslint@10.11.0` + `eslint-config-next@16.3.6` の組で `npx eslint .` を実行すると
   `TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function`
   で **クラッシュする**（`eslint-config-next` が内部で束ねる `eslint-plugin-react@7.37.5` が
   `context.getFilename()` という ESLint 10 で除去された API を呼んでいるため）。
   `eslint-plugin-react@7.37.5` の `peerDependencies.eslint` は `... || ^9.7` までであり、
   `eslint-config-next@16.3.6` 自身の peer 宣言（`eslint: >=9.0.0`、上限無し）は
   この非互換を捕捉できていない（バージョン表記の緩さによる実害）。`eslint@9.39.5` へ
   切り替えると `npx eslint .` は 0 errors / 0 warnings で通ることを実測済み。
   → 後日 `eslint-config-next` が新しい `eslint-plugin-react` を束ね直したら ESLint 10 へ
   の追従を再検討する（本 ADR の対象外。再検討タスクは未起票）。
3. **`server-only@0.0.1` を追加**（依頼リストに無かった）。
   実測: `import "server-only"` を使うには npm パッケージ `server-only` が明示的に必要
   （Next.js に同梱されていない。`node_modules/server-only` が存在しないことを確認済み）。
   implementation-plan.md §7-7 が「DB クライアントとシークレット取得モジュールに
   `import 'server-only'`」を要求しており、task_003 のスパイク③（ADR-012）にも必須のため追加した。

## 互換性の実測（`@opennextjs/cloudflare@1.20.6` の `package.json`）

```json
{
  "peerDependencies": {
    "next": ">=15.5.24 <16 || >=16.3.3",
    "wrangler": "^4.125.0"
  }
}
```

`next@16.3.6` は `>=16.3.3` を満たし、`wrangler@4.137.0` は `^4.125.0` を満たす。

## npm audit（実測、2026-09-24）

`npm audit --audit-level=high` → exit 0（moderate 4件のみ。severity: high/critical は 0 件）。
moderate 4件はすべて `drizzle-kit` の推移依存 `@esbuild-kit/core-utils`（deprecated. tsx へ統合済み）
経由の `esbuild <=0.24.2`（開発サーバーの任意オリジンからのリクエスト受理。GHSA-67mh-4wv8-2f99）。
`drizzle-kit` は本番ランタイムに含まれず、開発時のみの依存であり、`npm audit fix --force` は
`drizzle-kit@0.18.1` への破壊的ダウングレードを要求するため見送った。`npm ls`（`npm ls --all
--parseable | grep -Ei 'paypay|payjp|stripe'`）は 0 件（check_038 準拠、決済 SDK 無し）。

## 既知の非ブロッキング事項

- `vitest.config.ts` 読み込み時に Vite から `configLoader: 'native'` 関連の将来非推奨警告
  （ESM 構文を CJS として読み込んでいる旨）が出る。`package.json` に `"type": "module"` を
  足せば消えるが、他の設定ファイル（playwright/drizzle/next.config）への波及を検証していない
  ため、task_003 では見送り、警告のまま許容する（テストの exit code には影響しない。実測）。
