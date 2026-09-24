# Cloudflare — Workers Rate Limiting バインディング（一次資料の退避）

- 取得日: 2026-09-24
- 取得元（一次資料）: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- 取得方法: WebFetch
- 利用箇所: `src/lib/auth/rate-limit.ts`（`/api/auth/line` の IP 単位レート制限。A27 / R-SEC-08）

---

## 1. wrangler 設定

```toml
[[ratelimits]]
name = "MY_RATE_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 100
  period = 60
```

必須フィールド（原文）:

- `name`: バインディング識別子
- `namespace_id`: "A string containing a positive integer that uniquely defines this rate limiting namespace"
- `simple.limit`: 期間内に許可するリクエスト数
- `simple.period`: **"Must be either `10` or `60`"**（秒）

→ 期間に選べるのは **10 秒か 60 秒の 2 値のみ**。任意の秒数は書けない。

## 2. ランタイム API

```javascript
const { success } = await env.MY_RATE_LIMITER.limit({ key: "unique-identifier" })
```

- `key` は "any `string` value"。
- 戻り値は `success`（boolean）を持つオブジェクト。

## 3. 明記された制限

- **局所性**: "Rate limits...are local to the Cloudflare location that your Worker runs in.
  For each unique key...there is a unique limit per Cloudflare location."
  → **拠点ごとに別カウンタ**。全球で厳密な上限にはならない。
- **一貫性**: "permissive, eventually consistent, and intentionally designed to not be used
  as an accurate accounting system."
- **性能**: カウンタは Worker が動く同一マシンにキャッシュされ非同期に更新される。

---

## 4. 本アプリでの扱い

| 決めたこと | 理由 |
|---|---|
| `/api/auth/line` の IP 単位制限に **このバインディングを第一候補**にする | 追加インフラなしで拠点単位の閾値が掛かる。乱打の大半はここで落ちる |
| 全球で厳密なカウントが要る箇所には Durable Object を 1 個使う | 上の「拠点ごとに別カウンタ」を厳密上限とみなせないため（§7-2 の記述と一致） |
| **アイソレート内メモリ（`Map`）をカウンタに使わない** | Workers はアイソレート間でメモリを共有しないため本番では機能しない（A27 / R-SEC-02） |
| バックエンドがひとつも束縛されていなければ **fail-closed**（503） | 「制限が掛かっていないのに掛かっているつもり」を作らない |

### 未確認のまま残っている点 [不明]

| 項目 | 状態 | 扱い |
|---|---|---|
| 契約プランで `[[ratelimits]]` と Durable Objects が使えるか（A27） | 未検証。Cloudflare アカウントが未作成 | `wrangler.toml` へのバインディング追加は task_024 / task_035。本タスクはコード側の受け口と fail-closed のみ実装する |
| `namespace_id` の実値 | 未採番 | 同上 |
| 拠点あたりの閾値と全球の実効閾値の関係 | 未実測 | 実測は task_024（本番環境構築）で行う |
