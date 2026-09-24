# LINE — ID トークン検証エンドポイント（一次資料の退避）

- 取得日: 2026-09-24
- 取得元（一次資料）:
  - https://developers.line.biz/en/reference/line-login/#verify-id-token
  - https://developers.line.biz/ja/reference/line-login/ （`docs/research/research-line-miniapp.md` Q4 に引用済みの和文）
  - https://developers.line.biz/ja/docs/liff/using-user-profile/index.html.md
- 取得方法: WebFetch（本文を要約せず、パラメータ名・フィールド名・エラー文言をそのまま書き写す）
- 利用箇所: `src/lib/auth/line-verify.ts`、`src/lib/config/env.ts`（N3 の整合アサート）

> この節に無い API 名・パラメータ名をコードに書かない。追記するときは必ず一次資料を取り直し、
> 取得日を更新する（プロジェクト規約）。

---

## 1. エンドポイント

```
POST https://api.line.me/oauth2/v2.1/verify
Content-Type: application/x-www-form-urlencoded
```

### リクエストパラメータ

| パラメータ | 必須 | 原文の説明 |
|---|---|---|
| `id_token` | 必須 | "ID token" |
| `client_id` | 必須 | "Expected channel ID. Unique identifier for your channel issued by the LINE Platform" |
| `nonce` | 任意 | "Expected `nonce` value. Use the `nonce` value provided in the authorization request" |
| `user_id` | 任意 | "Expected user ID" |

**`client_id` に入れるのは LINE Login チャネル ID**（LIFF ID でも Messaging API チャネル ID でもない）。
制約 N3（`docs/constraints.json`）はこの一文を根拠にしている。

LIFF ID は `<LINE Login チャネル ID>-<8 文字の識別子>` の形を取る
（例: `1234567890-abcdEFGH`）。したがって
`LINE_ENV_PROFILE.loginChannelId` と `LINE_ENV_PROFILE.liffId` のハイフン前の数字列が
一致しないときは、どちらかに別チャネル（Messaging API チャネル等）の ID が混ざっている。
`src/lib/config/env.ts` はこれを起動時に落とす。

### 成功レスポンス（ペイロード）

| フィールド | 型 | 原文の説明 |
|---|---|---|
| `iss` | String | "URL used to generate the ID token" |
| `sub` | String | "User ID for which the ID token was generated" |
| `aud` | String | "Channel ID" |
| `exp` | Number | "Expiration time of the ID token in UNIX time (in seconds)" |
| `iat` | Number | "Time when the ID token was generated in UNIX time (in seconds)" |
| `auth_time` | Number | "Time the user was authenticated in UNIX time (in seconds)" |
| `nonce` | String | "The `nonce` value specified in the authorization URL"（認可リクエストに `nonce` を指定しなかった場合は含まれない） |
| `amr` | Array | "List of authentication methods used by the user"（`pwd` / `lineautologin` / `lineqr` / `linesso` / `mfa`） |
| `name` | String | "User's display name"（`profile` スコープ未指定なら含まれない） |
| `picture` | String | "User's profile image URL"（同上） |
| `email` | String | "User's email address"（`email` スコープ未指定なら含まれない） |

### エラーレスポンス

一次資料はエラー時の **HTTP ステータスコードを明示していない** [不明]。
記載があるのは `error_description` の文言だけである:

| 条件 | `error_description` |
|---|---|
| 署名不正・形式不正 | "Invalid IdToken." |
| issuer 不一致 | "Invalid IdToken Issuer." |
| 期限切れ | "IdToken expired." |
| audience 不一致 | "Invalid IdToken Audience." |
| nonce 不一致 | "Invalid IdToken Nonce." |
| user_id 不一致 | "Invalid IdToken Subject Identifier." |

→ 実装は **「2xx 以外はすべて検証失敗」** として扱う（ステータスコードの分岐を作らない）。
`error_description` の文言も分岐条件に使わない（LINE 側の文言変更で壊れるため）。
アプリのログには `error_description` を**そのまま**は出さず、`ID_TOKEN_INVALID` に畳む
（R-SEC-04: 資格情報・トークン本体をログに出さない）。

---

## 2. LIFF 側（サーバーへ送ってよいもの / いけないもの）

一次資料（`using-user-profile`）の該当箇所:

> ID トークン（`liff.getIDToken()`）とアクセストークン（`liff.getAccessToken()`）はサーバーに送ってよい。
> 一方「`liff.getDecodedIDToken()` や `liff.getProfile()` で取得したユーザー情報を、
> LIFF アプリからサーバーに送信しないでください」。

- ID トークンの有効期間は「発行から 1 時間」。
- 「ユーザーが LIFF アプリを閉じると、有効期間が経過していなくてもアクセストークンは無効になります。」

→ 本アプリはアクセストークンを使わず、ID トークンのみをサーバーで検証する。
→ 制約 N2 の grep（`getDecodedIDToken` / `getProfile(`）はこの一文が根拠。

---

## 3. nonce について（ADR-009 の根拠）

`nonce` はリクエストパラメータとして**任意**であり、検証に使うには
「認可リクエストに指定した `nonce`」をサーバー側で発行・保持している必要がある。
LIFF ブラウザ内では `liff.login()` の動作が保証されず
（`docs/research/research-line-miniapp.md` Q4: 「LIFF ブラウザ内での LINE ログインによる
認可リクエストの動作は保証されません」）、`liff.getIDToken()` が返すトークンの `nonce` は
LIFF 初期化時にプラットフォーム側が決めるため、こちらのリクエストに紐づけられない。

→ 本アプリは `nonce` を使わず、**単回使用テーブル（`used_id_token`）**で再利用を止める。
判断の記録は `docs/decisions/ADR-009-id-token-single-use.md`。

---

## 4. 未確認のまま残っている点 [不明]

| 項目 | 状態 | 扱い |
|---|---|---|
| エラー時の HTTP ステータスコード | 一次資料に記載なし | 2xx 以外を一律で失敗とする実装にして依存しない |
| レート制限（`/oauth2/v2.1/verify` 側） | 一次資料に記載を確認できず | アプリ側で IP 単位のレート制限を掛ける（R-SEC-08）。LINE 側の 429 も「検証失敗」に畳む |
| `jti` クレーム | ペイロード一覧に無い | 単回使用キーは `sha256(idToken)` を使う（`jti` が将来増えたらそちらを優先する実装にしてある） |
