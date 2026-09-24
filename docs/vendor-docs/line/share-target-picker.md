# LINE — `shareTargetPicker` / `isApiAvailable` — 一次資料の退避

**取得日: 2026-09-24**
**取得元:**

- SDK の型面: 本リポジトリの `node_modules`（`@line/liff@2.31.0` の実配布物。npm レジストリ由来で
  二次情報ではない）
- API の挙動・有効化手順: `docs/research/research-line-miniapp.md` Q5（WebFetch で取得した
  LINE Developers 公式ドキュメントの原文引用。取得日は同ファイル冒頭を参照）
  - https://developers.line.biz/ja/docs/liff/developing-liff-apps/index.html.md
  - https://developers.line.biz/ja/reference/liff/
  - https://developers.line.biz/ja/docs/line-mini-app/develop/share-messages/index.html.md

**利用箇所:** `src/lib/liff/share.ts`（`isApiAvailable` 判定と `shareTargetPicker` 呼び出し）、
`src/components/ShareSheet.tsx`（補助導線の表示可否）

> この節に無い API 名・パラメータ名をコードに書かない。追記するときは必ず一次資料を取り直し、
> 取得日を更新する（プロジェクト規約。`docs/vendor-docs/line/liff-sdk.md` と同じ方針）。

---

## 1. 型面（`node_modules/@line/liff` 2.31.0 の実体）

`node_modules/@liff/share-target-picker/lib/index.d.ts`:

```ts
type ShareTargetPickerOptions = {
  isMultiple?: boolean;
};
type ShareTargetPickerMethod = (
  messages: SendMessagesParams,
  options?: ShareTargetPickerOptions,
) => Promise<ShareTargetPickerResult | void>;
```

`node_modules/@liff/share-target-picker/lib/def.d.ts`:

```ts
export interface ShareTargetPickerResult {
  status: "success";
}
```

`node_modules/@liff/is-api-available/lib/index.d.ts`:

```ts
export declare function isApiAvailable(apiName: string): boolean;
```

読み取れる事実:

- `shareTargetPicker(messages, options)` は `Promise<{ status: "success" } | void>` を返す。
  **`void`（`undefined`）も成功として扱ってよい**（`@line/liff-mock` の既定実装が `void` を返す。
  §3 を参照）。「失敗」は reject として届くが、reject が「利用者がキャンセルした」のか
  「本当に失敗した」のかを区別する情報は型からは読み取れない（§2 も参照）。
- `isApiAvailable(apiName: string): boolean` は同期関数。`apiName` は文字列（型レベルでは
  `LIFF_PUBLIC_API_NAMES` に列挙されるリテラル群の 1 つで `"shareTargetPicker"` を含む）。
- `shareTargetPicker` は **`sendMessages` とは別の API**（別のモジュール・別の関数）。
  受け取る `messages` の型（`SendMessagesParams` = `LiffMessage[]`）が同じ形をしているだけで、
  呼び出し先は異なる。制約 N9 が禁じているのは `sendMessages(` という並びの文字列であり、
  `shareTargetPicker(` はこれに当たらない。

## 2. 挙動・前提条件（LINE Developers 公式ドキュメントの原文）

有効化手順（原文。`docs/research/research-line-miniapp.md` Q5 からの再掲）:

> 「シェアターゲットピッカーを利用するには、以下の手順に従って『情報利用に関する同意について』に
> 同意する必要があります。この同意は、チャネルごとに必要です。
> 1. LINE Developersコンソールで、LIFFアプリを追加するLINEログインのチャネルを選択します
> 2. ［LIFF］タブの［シェアターゲットピッカー］をクリックすると、『情報利用に関する同意について』が
>    表示されます
> 3. 表示された内容をよく読み、［上記の事項に同意する］をチェックし、［有効化］をクリックします」

利用条件（原文。API リファレンス側）: 「ユーザーがログイン状態」かつ「LINE Developers
コンソールでシェアターゲットピッカーがオン」。外部ブラウザでは「シングルサインオン（SSO）による
ログインセッションが必要」。

可用性判定（原文・公式の推奨手段）:

> 「あらかじめ、`liff.isApiAvailable()`メソッドを実行することで、現在の環境でターゲットピッカーが
> 利用可能であることを確認できます。」
>
> ```javascript
> if (liff.isApiAvailable("shareTargetPicker")) {
>   liff.shareTargetPicker([{ type: "text", text: "Hello, World!" }]);
> }
> ```

送信できるメッセージ形式（原文の要約。API リファレンス）: テキスト／画像／動画／音声／位置情報／
テンプレート／Flex Message（**URI アクションのみ**）、最大 5 件。カルーセルコンテナは
LINE ミニアプリのカスタムシェアの文脈では非推奨（下記§3）。

送信先の制約（原文の要約）: グループ（オープンチャット除く）・友だち（LINE 公式アカウントは
表示されない）・トーク（直近やり取りがある相手）。友だちが「アプリからの情報アクセス」を拒否
している、送信元を友だち追加していない、非表示・ブロックしている場合は候補に出ない。

最低 LINE バージョン（原文）:

> 「`shareTargetPicker` の最低LINEバージョンは一次資料で特定できなかった（`liff.isApiAvailable()`
> での実行時判定が公式の推奨手段）」

## 3. LINE ミニアプリのカスタムシェア（別ドキュメント系統）

`docs/line-mini-app/develop/share-messages` は「LINE ミニアプリ」のドキュメント系統に属し、
「シェアターゲットピッカー」を明示的には呼ばない（下記§4 の未解決点）。ただし同ページは
Flex Message のバブルコンテナでカスタムシェアメッセージを作ることを明示的に指示しており、
`ShareSheet` の Flex テンプレ（`src/lib/share-templates.ts` の `buildFlexShareMessage`）は
この指示に沿ってバブル 1 件のみを組み立てる（カルーセルは使わない）。

## 4. 有効化手順の一次資料未特定（GATE-LINE-SHARE）

**未解決点（`docs/research/research-line-miniapp.md` §未解決 3・4 からの再掲）:**

> 「LINEミニアプリチャネルでのシェアターゲットピッカー有効化の具体的なコンソール手順：
> シェアターゲットピッカーの前提条件は『LINEログインのチャネル』の［LIFF］タブ手順として
> 書かれており、LINEミニアプリチャネルのコンソールガイドには『シェアターゲットピッカー』の語が
> 出てこなかった。ミニアプリ側はカスタムアクションボタンのドキュメントで shareTargetPicker の
> 利用を明確に指示しているので利用可能と考えられるが、有効化手順の一次資料は特定できていない。」

すなわち、本アプリが実際に使うチャネル種別（**LINE ミニアプリチャネル**）で
「LINE Developers コンソールのどこを操作すると `isApiAvailable("shareTargetPicker")` が
`true` になるか」を確認できる一次資料はまだ無い。§2 の有効化手順は「LINE ログインのチャネル」
向けの記述であり、LINE ミニアプリチャネルにそのまま当てはまるとは限らない。

この未解決は `docs/implementation-plan.md` §18-1 の Q-LN7（「ミニアプリチャネルで
`shareTargetPicker` は利用可能か・申請要否」）として LINE ヤフーへの照会対象に登録済みで
（`docs/external-inquiries.json`）、ゲート台帳では `GATE-LINE-SHARE`
（`docs/gates/compliance-gates.json`）として追跡する。本書作成時点（2026-09-24）の
`GATE-LINE-SHARE.status` は `unknown`（回答未着）。

**この未解決が実装に与える結論（すでに反映済み）:**

- `shareTargetPicker` を配布の主導線にしない。主導線は催促文＋URL のクリップボードコピー
  （制約 N8、`docs/implementation-plan.md` §7-3）。
- `src/lib/liff/share.ts` は `isApiAvailable("shareTargetPicker")` を**実行時に**判定し、
  `false`（判定不能・例外を含む）のときは picker の導線そのものを出さない（fail-closed）。
  ビルド時にチャネル種別から決め打ちしない。
- `GATE-LINE-SHARE` が `passed` になる、または「LINE ミニアプリチャネルでの有効化手順」を
  示す一次資料が見つかるまで、この判定ロジックを変えない。
