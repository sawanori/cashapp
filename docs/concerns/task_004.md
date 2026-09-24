# task_004 の残懸念

制約・禁止語の機械可読化と grep ゲート（`scripts/gate-constraints.sh` / `scripts/wording-lint.mjs` /
`docs/constraints.json` / `docs/wording-policy.md` とその 2 つのユニットテスト）。
形式は「指摘 / 再現結果 / 修正 / 残懸念」。

## 2 周目（GPT-6 Astra の敵対レビュー・high 2 / medium 5）で閉じた指摘

封筒は `reviewer: adversarial-reviewer-gpt` / `commit: 8ea93a3` / `verdict: FAIL`。
封筒の 7 件はすべて「再現手順は未実行」と明記されていたので、本周では **まず 7 件すべてを
実際に再現してから直し、同じ手順で塞がったことを実測した**。再現できなかった指摘は 0 件。

### F-1 [high] 日本語ファイル名の違反が両ゲートの走査対象から落ちる

**再現（実測・修正前）**: `git init` した木で `core.quotePath true` にし、`src/ok.ts`（無害）と
`src/集金.ts`（`"寄付"` を含む）を置いて `git add`。`git ls-files -co --exclude-standard` の出力は

```
src/ok.ts
"src/\351\233\206\351\207\221.ts"
```

で、引用符つきの C エスケープ表現になる。この行は `src/**/*.ts` の先頭固定マッチ
（`^(...)$`）に一致しないため走査対象から落ち、`node scripts/wording-lint.mjs` は
`ok W-DONATION (1 file(s))` と表示して **exit 0**。ゲート側も同条件で
`src/app/決済.ts`（`import Stripe from "stripe"`）を置くと P1 を検出せず **exit 0**。

**修正**: 両方の file universe を `git ls-files -z -co --exclude-standard` に変えた。
`-z` は `core.quotePath` に関係なくパスを生のまま NUL 区切りで出す。`-z` にすると今度は
パスに含まれる改行が行境界と区別できなくなるので、bash 側は NUL 個数と行数の一致を、
Node 側は各エントリに `\n` が無いことを検査し、食い違えば **exit 2**（走査せずに落ちる）。

**実測（修正後）**: 同じ木で `W-DONATION src/集金.ts:1 | 寄付` / exit 1、
`P1 src/app/決済.ts:1 | import Stripe from "stripe";` / exit 1。
回帰テスト: `tests/unit/gate-constraints.test.ts`「scans a non-ASCII path inside a git repo with
core.quotePath on」/ `tests/unit/wording-lint.test.ts` の同名ケース（どちらも実際に `git init` +
`git config core.quotePath true` した一時ディレクトリを使う）。

### F-2 [high] 実際に読めた対象が 0 件でも合格する

**再現（実測・修正前）**: (a) `git init` した木に `src/a.ts` を作って `git add` し、
ワークツリーからだけ削除する。`git ls-files` には残るので対象 1 件と数えられ、`statSync` は
失敗して `continue` するだけなので `ok W-AUTO (1 file(s))` / **exit 0**。ゲート側も
`seedCleanTree` 相当の木で `src/app/page.ts`（`import Stripe from "stripe"` 入り）と
`src/app/view.tsx` を `git add` してから削除すると `ok P1 (forbid, 2 file(s))` / **exit 0**。
(b) 唯一の対象 `src/a.ts` を 2 MiB 超のコメント ＋ `"寄付"` にすると、`MAX_FILE_BYTES` 超で
読み飛ばされて **exit 0**。

**修正**: 「パスを数える」と「バイトを読む」を分けた。
- `wording-lint.mjs`: stat 失敗 / 非通常ファイル / サイズ上限超は **1 件ずつ違反として出力**し、
  読めた件数 `readFiles` が 0 なら `UNREADABLE <id>` を stderr に出して empty gate に数える。
- `gate-constraints.sh`: 対象一覧を「実際に `-f` かつ `-r` なもの」に絞り、落ちた対象は
  1 件ずつ違反として出力。読めた件数が 0 なら `UNREADABLE <id>` で empty gate。
  grep には絞った一覧だけを渡す（`require` 側も同じ一覧を使う）。
- 出力の `ok <id> (N file(s))` は `N file(s) read`（読めた件数）に変えた。

**実測（修正後）**: (a) wording は `W-AUTO src/a.ts:1 | target matched the glob but could not be
read` ＋ `UNREADABLE W-AUTO: 1 target(s) matched but 0 could be read` / exit 1。ゲートは
`UNREADABLE P1: 2 target(s) matched but 0 could be read` / exit 1。
(b) `W-DONATION src/a.ts:1 | target is 2097203 bytes, over the 2097152-byte scan limit` / exit 1。
回帰テスト: gate 側 3 件（全滅 / 一部だけ読めない / 非 ASCII）、wording 側 3 件。

### F-3 [medium] `status_rank` への代入だけでランクガード無しの更新が免除される

**再現（実測・修正前）**: `seedCleanTree` の木に
`src/lib/update.ts` = `export const query = "UPDATE payments SET status = 'paid', status_rank = 2 WHERE id = $1";`
を置いて実 `docs/constraints.json` でゲートを走らせると `ok W3 (forbid, 3 file(s))` / **exit 0**。
`allow_if_line_matches` が `"(status_rank|statusRank)"` という **名前の出現** だけを条件に
していたため、ランクを無条件に上書きするだけの UPDATE も免除されていた。

**修正**: 許可条件を「比較演算子を伴うランク比較」に変えた
（`(status_rank|statusRank)[[:space:]]*(<=?|>=?)` と `(<=?|>=?)[[:space:]]*(status_rank|statusRank)`）。

**実測（修正後）**: 同じ木で `W3 src/lib/update.ts:1` / exit 1。
`... WHERE status_rank < $2` の形は引き続き exit 0（回帰テスト 2 件で両方向を固定）。

### F-4 [medium] 決済 SDK の動的 import が P1 を通過する

**再現（実測・修正前）**: `src/lib/load-payment.ts` = `export async function loadPayment() { return import("stripe"); }`
で `ok P1 (forbid, 3 file(s))` / **exit 0**（`from` と `require(` の構文しか見ていなかった）。

**修正**: `import\([[:space:]]*["'](@paypayopa/|paypayopa|stripe|@stripe/|payjp|@payjp/)` を追加。

**実測（修正後）**: `P1 src/lib/load-payment.ts:1` / exit 1。
`src/lib/payments/providers/stripe.ts` に置いた同じ動的 import は `exclude_globs` で引き続き
exit 0（回帰テスト 2 件）。

### F-5 [medium] 一般的な SQL の date 型と裸の timestamp 型を検出できない

**再現（実測・修正前）**: `supabase/migrations/001.sql` = `CREATE TABLE example (due_on date, created_at timestamp);`
で `ok X-TIME (forbid, 1 file(s))` / **exit 0**。date 型のパターンが `^`（行頭に列名）に
固定され、タイムゾーン無しの timestamp は `WITHOUT TIME ZONE` の明記がある場合しか
見ていなかった。

**修正**: 列定義のアンカーを `(^|[(,])` に広げ（`CREATE TABLE` と同一行でも当たる）、
型名の大文字小文字を両方許し、`timestamptz` / `timestamp with time zone` **以外** の
timestamp（`timestamp,` / `timestamp)` / `timestamp NOT NULL` など）を検出するパターンを
足した。`timestamptz` と `timestamp with time zone` は当たらない形にしてある。

**実測（修正後）**: `X-TIME supabase/migrations/001.sql:1` / exit 1。
`CREATE TABLE ok (a timestamptz, b timestamp with time zone NOT NULL, c timestamptz DEFAULT now());`
は exit 0。実 `supabase/migrations/*.sql` 7 本 ＋ `src/lib/db/schema.ts`（`import { timestamp }`
や `mode: "date"` を含む）でも新パターンは 1 件も当たらない（`npm run gate:constraints` = exit 0 で実測）。

### F-6 [medium] コメント内の import 文字列で server-only の必須検査を満たせる

**再現（実測・修正前）**: `src/lib/db/client.ts` = `// import "server-only";\nexport const db = null;`
で `ok GC-SERVER-ONLY (require, 1 file(s))` / **exit 0**。

**修正**: 必須パターンを `^[[:space:]]*import[[:space:]]+["']server-only["'][[:space:]]*;?[[:space:]]*$`
にし、行頭から始まる（= 実行される）import 文だけを認めるようにした。

**実測（修正後）**: `GC-SERVER-ONLY src/lib/db/client.ts:1 | required pattern missing` / exit 1。
素の `import "server-only";` は exit 0（回帰テスト 2 件）。

### F-7 [medium] components 外のクライアント用 ts が DB import 検査から漏れる

**再現（実測・修正前）**: `src/hooks/use-db.ts` = `'use client'; import postgres from 'postgres';`
で `ok I3 (forbid, 1 file(s))` / **exit 0**（I3 の対象が全 tsx ＋ `src/components/**/*.ts` に
限定されていた）。

**修正**: I3 の対象を `src/**/*.tsx` ＋ `src/**/*.ts` に広げ、サーバー側と確定している
`src/lib/**` / `src/app/api/**` / `src/app/**/route.ts` / `src/middleware.ts` だけを除外した。
GC-SERVER-ONLY 側は対象に `src/lib/config/env.ts`（シークレット取得モジュール。
`scripts/assert-server-only.mjs` の `SERVER_ONLY_MODULES` にも既に載っている）を足した。

**実測（修正後）**: `I3 src/hooks/use-db.ts:2` / exit 1。`src/lib/server-db.ts` の同じ import は
exit 0。実リポジトリでは I3 の対象数は 15 件のまま変わらない（`src/hooks` がまだ無く、
`src/middleware.ts` は除外されるため）＝ 他タスクの既存ファイルを新たに落とさない。

---

## 残懸念

### C-004-1 [medium] I3 は「クライアントかどうか」をディレクトリで近似している

grep ゲートは 1 行単位でしか判定できないので、「`'use client'` を宣言したファイルが DB を
import している」という **ファイル単位の条件** は表現できない。今回の修正は
「`src/lib/**` と Route Handler 以外の `src/**` はクライアントに載りうる」という近似で
広げただけであり、`src/lib/` 配下に置いたクライアント用ヘルパは依然として I3 の対象外である。
ファイル単位の伝播検査は `scripts/assert-server-only.mjs`（`npm run gate:server-only`・task_011 所有）
が受け持っており、そちらが `'use client'` からの import を追う。**両者の対象集合は一致していない**。

### C-004-2 [medium] GC-SERVER-ONLY の対象は明示列挙のまま

`src/lib/db/**` のような glob に広げると `src/lib/db/schema.ts`（`server-only` を持たない）や
他タスクが追加中の `src/lib/db/repositories/**` を巻き込み、task_004 の変更が他タスクの
作業を落とす。今回は現に `server-only` を持つ `src/lib/config/env.ts` を足すに留めた。
必須モジュールの正本は `scripts/assert-server-only.mjs` の `SERVER_ONLY_MODULES` であり、
`docs/constraints.json` 側はその部分集合である（二重管理）。

### C-004-3 [medium] 「読めた 0 件で fail」は並行作業中に偽陽性を出しうる

F-2 の修正で、対象にマッチしたパスが 1 つでも読めないと違反として出る。別のエージェントが
同じワークツリーでファイルを移動・削除している最中にゲートを走らせると、実害が無くても
`target matched the glob but could not be read` が出る。fail-open より fail-closed を選んだ
結果であり、意図した挙動として残す。

### C-004-4 [low] パスに改行を含むリポジトリは走査せず exit 2 で落ちる

`-z` にしたことで引用は消えたが、改行を含むパスは行指向の一覧に落とせない。検出して
**exit 2**（設定エラー）で止める形にした。そのようなパスを実際に扱う必要が出たら、
一覧全体を NUL 指向に作り直す必要がある。

### C-004-5 [medium] `npm run test:unit` が exit 1（本タスク起因 0 件）

本周の最終実測（HEAD = 3bdf5d4 + 作業ツリー）で `npm run test:unit` は **exit 1**
（37 ファイル中 5 ファイル・950 件中 16 件が赤）。赤は
`tests/unit/auth/line-route.test.ts` / `tests/unit/auth/pepper.test.ts` /
`tests/unit/auth/csrf.test.ts` / `tests/unit/config/env.test.ts` /
`tests/unit/telemetry.test.ts` で、いずれも他タスクが編集中の未コミットファイル
（`src/lib/auth/pepper.ts` は `AppError` / `ERROR_CODES` が未 import で `npm run typecheck` も
**exit 2**）に起因する。**task_004 所有の 2 ファイルは 44/44 緑**
（`npx vitest run tests/unit/gate-constraints.test.ts tests/unit/wording-lint.test.ts` = exit 0）。
3 周目までに報告されていた `gate-constraints.test.ts` の 5 秒タイムアウトは本周の実測では
再現しなかった（単独実行・フルスイートとも当該ファイルは緑）。
