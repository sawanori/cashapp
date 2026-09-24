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

## 3 周目（同じ周の G5 で新たに出た medium 7 件）

コミット `26eb304` に対する G5（`scripts/review-drive.sh` → `scripts/merge-review.sh`）は
**pass**（有効票 2 / 欠票 0 / 実効 high 0）だったが、gemini が medium 1 件・GPT が medium 6 件を
挙げた。7 件すべてを実際に再現した（再現できなかった指摘は 0 件）。うち 5 件は同じ仕組みの中で
塞ぎ、2 件は行単位 grep の原理的な限界なので下の C-004-6 に残した。

### GPT F-1 [medium・解消済み] 波括弧付き glob が壊れて対象を見逃す

**再現**: `globs: ["src/**/*.{ts,tsx}"]` の fixture ポリシーで `src/ok.tsx`（無害）と
`src/bad.ts`（`"寄付"`）を置くと `ok W-FIXTURE (1 file(s) read)` / **exit 0**。
`globToRegExp` が波括弧を `(?:` に変換した後に `?` → `[^/]` の置換を掛けるため、
`(?:ts|tsx)` が `([^/]:ts|tsx)` になり `.ts` に一致しなくなっていた（`.tsx` 側は一致するので
対象 0 件検査も通る）。bash 側の `glob_to_regex` は `(` を使うのでこの穴は無い。

**修正**: 波括弧と `,` も私用領域のプレースホルダに退避し、`*` / `?` の置換が済んでから
`(?:` / `)` / `|` に戻す。**実測（修正後）**: `W-FIXTURE src/bad.ts:1` / exit 1。

### GPT F-6 [medium・解消済み] 正規表現エラーを「違反 0 件」として合格させる

**再現**: `grep_patterns: ["("]` の fixture で `ok T-REGEX (forbid, 1 file(s) read)` / **exit 0**。
forbid の走査は `2>/dev/null` で grep の stderr を捨て、パイプラインの終了コードも見ていない。

**修正**: エントリごとに全パターン（`allow_if_line_matches` も含む）を空入力に対して 1 回
コンパイルし、grep が拒否したら **exit 2**。失敗したときだけ 1 本ずつ試して該当パターンを名指しする。
**実測（修正後）**: `CONFIG T-REGEX: grep rejected the pattern: (` / exit 2。
`allow_if_line_matches: ["a[b"]` でも `CONFIG T-ALLOW-REGEX` / exit 2。

### GPT F-4 [medium・解消済み] 後退方向のランク比較も W3 の免除条件になる

**再現**: `UPDATE payments SET status = 'paid', status_rank = 2 WHERE status_rank > 2`
（ランク 3 の refunded をランク 2 の paid へ戻す）で `ok W3` / **exit 0**。1 周目の修正が
「比較演算子を伴うこと」までしか要求していなかった。

**修正**: 前進方向だけを免除する（ランクが左辺なら `<` / `<=`、右辺なら `>` / `>=`）。
**実測（修正後）**: 上記は `W3 src/lib/update.ts:1` / exit 1、
`WHERE $2 > status_rank` は exit 0（回帰テスト 2 件）。

### GPT F-5 [medium・解消済み] 副作用 import と空白付き動的 import が P1 を通過する

**再現**: `import 'stripe';` と `export const loadPayment = () => import ('stripe');` の 2 行で
`ok P1` / **exit 0**。**修正**: `import[[:space:]]+["']<sdk>`（副作用 import）を追加し、
`require` / `import` と `(` の間に空白を許した。
**実測（修正後）**: 1 行目・2 行目とも `P1 src/lib/load-payment.ts` / exit 1。

### GPT F-3 [medium・解消済み] `timestamp(3)` と `ALTER TABLE ... date` を見逃す

**再現**: `CREATE TABLE example (created_at timestamp(3));` と
`ALTER TABLE example ADD COLUMN due_on date;` の 2 行で `ok X-TIME` / **exit 0**。
**修正**: 精度付き `timestamp(<数字>)` のパターンと、`ADD [COLUMN]` / `TYPE` を起点にした
列宣言のパターンを追加した。列名の前を行頭・`(`・`,`・DDL キーワードに限るのは、
SQL コメント中の英文（`-- the due date column`）を違反にしないため。
**実測（修正後）**: 両行とも `X-TIME supabase/migrations/003.sql` / exit 1。
`ALTER TABLE ... ADD COLUMN created_at timestamptz NOT NULL;` /
`ALTER COLUMN ... TYPE timestamptz;` / `CREATE TABLE ok2 (a timestamptz(3), b timestamptz);` /
英文コメントは exit 0（回帰テスト 2 件）。実 `supabase/migrations/*.sql` 7 本と
`src/lib/db/schema.ts` でも新パターンは 1 件も当たらない。

---

## 4 周目（2 回目の G5 で出た high 2 / medium 3）

2 回目の G5（view commit `4291cef` / base `3bdf5d4`）は `merge-review.sh` が **reject**
（有効票 2 / 欠票 0 / **実効 high 2**）。5 件すべてを再現してから直した。

### GPT F-1 [high・解消済み] SQL の不等号 `<>` が前進方向のランク比較として免除される

**再現**: `UPDATE payments SET status = 'paid', status_rank = 2 WHERE status_rank <> 2` で
`ok W3` / **exit 0**。3 周目の許可パターン `(status_rank|statusRank)[[:space:]]*<=?` は
`<>` の先頭の `<` にも一致していた。`<>` はランク 3（refunded）の行も更新対象にするので
後退を防がない。

**修正**: `<` の直後が `>` でないこと・`>` の直前が `<` でないことを要求する
（`(status_rank|statusRank)[[:space:]]*<([^>]|$)` と `(^|[^<])>=?[[:space:]]*(status_rank|statusRank)`）。
**実測（修正後）**: `W3 src/lib/update.ts:1` / exit 1。`<= $2` と `$2 >= status_rank` は
どちらも exit 0（回帰テスト 2 件）。

### GPT F-2 [high・解消済み] ブロックコメント内の import が server-only 必須検査を満たす

3 周目に C-004-6 として「行単位 grep の限界」と書いて残した項目が high として再提出されたので、
今回直した。**再現**: `src/lib/db/client.ts` を `/*\nimport "server-only";\n*/\nexport const db = null;`
にすると `ok GC-SERVER-ONLY (require, 1 file(s) read)` / **exit 0**。

**修正**: `require` モードの照合の前に、awk でコメントを落とす（`/* */` は行をまたいで状態を持ち、
`//` と `--` は行末まで）。文字列リテラルは意図して解釈しない。誤って切り落とせば
**必須検査が落ちる（fail-closed）** 側に倒れるためである。
**実測（修正後）**: `GC-SERVER-ONLY src/lib/db/client.ts:1 | required pattern missing` / exit 1。
`postgres://` を含む doc コメントの後に本物の import がある形は exit 0。実リポジトリの
`src/lib/db/client.ts` / `src/lib/config/env.ts`（どちらも長い日本語 doc コメントを持つ）でも
`npm run gate:constraints` は exit 0、`npm run gate:server-only` も exit 0。

### GPT F-3 [medium・解消済み] `src/lib/**` の除外が .tsx まで巻き込む

**再現**: `src/lib/client-db.tsx` に `'use client'` ＋ `import postgres from 'postgres';` を置くと
`ok I3 (forbid, 2 file(s) read)` / **exit 0**。2 周目に足した除外が拡張子を問わなかったため、
本来 I3 の対象である `.tsx` まで外れていた。

**修正**: 除外を `src/lib/**/*.ts` / `src/app/api/**/*.ts` に限定した。
**実測（修正後）**: `I3 src/lib/client-db.tsx:2` / exit 1。

### GPT F-4 [medium・解消済み] `timestamp(3) with time zone` を誤って違反にする

**再現**: `CREATE TABLE example (created_at timestamp(3) with time zone NOT NULL);` で
`X-TIME supabase/migrations/005.sql:1` / **exit 1**（偽陽性）。3 周目に足した精度付きパターンが
`timestamp(<数字>)` の後ろを見ていなかった。

**修正**: 裸の timestamp と同じ終端条件（`,` / `)` / `;` / 行末、または `w` で始まらない語）を
精度付きパターンにも付けた。**実測（修正後）**: exit 0。`timestamp(3));` は引き続き exit 1。

### gemini F-1 [medium・解消済み] `npm run test:unit` が落ちている

3 周目の run-log に残っていた `exit 1`（`tests/unit/ci/acceptance-rerun.test.ts` の
5 秒タイムアウト）を指した指摘。**本周の実測**: `scripts/record-run.sh task_004 npm run test:unit`
は **exit 0**（37 ファイル / **981 件全緑** / 135 秒）。3 周目の赤が負荷由来だったことの裏づけでもある。
ただし他タスクのテストが既定 5000ms で書かれている限り再発しうるので、C-004-7 は残す。

---

## 5 周目（3 回目の G5 で出た high 1 / medium 4）

3 回目の G5（view commit `1936950`）も `merge-review.sh` が **reject**（有効票 2 / 欠票 0 /
**実効 high 1**）。5 件すべてを再現してから直した。今回は 2 件を新しい gate_only_check として
足している（1 行の ERE では表現できない条件を、別ゲートの禁止パターンに置き換えた）。

### GPT F-1 [high・解消済み] 否定されたランク比較でも W3 が免除される

**再現**: `UPDATE payments SET status = 'paid', status_rank = 2 WHERE NOT (status_rank < 2);`
で W3 は報告されず **exit 0**。許可パターンは「前進方向の比較が同一行にあること」しか見られず、
その比較が `NOT` で否定されているかは判定できない（ERE に後読みが無い）。

**修正**: 否定つきのランク比較そのものを禁じる gate_only_check `GC-RANK-NEGATION` を追加した
（`NOT (`・`!(` の後に `)` を挟まずランク名が来る形と、`NOT status_rank`）。W3 と同じ globs /
exclude_globs を使う。**実測（修正後）**: `GC-RANK-NEGATION supabase/migrations/006.sql:1` /
exit 1。実リポジトリでは対象 53 ファイルで違反 0（`NOT NULL` は当たらない）。

### GPT F-2 [medium・解消済み] テンプレート文字列内の import が server-only 義務を満たす

**再現**: `src/lib/db/client.ts` を `` export const example = `\nimport "server-only";\n`; `` に
すると、4 周目のコメント除去を通り抜けて必須パターンが成立し **exit 0**。

**修正**: 除去処理にバックティックのテンプレート文字列の状態も持たせた（`` ` `` で開閉し、
その内側は出力しない）。**実測（修正後）**: `GC-SERVER-ONLY src/lib/db/client.ts:1 | required
pattern missing` / exit 1。実リポジトリの `src/lib/db/client.ts` / `src/lib/config/env.ts` は
`npm run gate:constraints` / `gate:server-only` とも exit 0。

### GPT F-3 [medium・解消済み] src/lib 配下のクライアント用 .ts が I3 から外れる

**再現**: `src/lib/client-db.ts` に `'use client'` ＋ `import postgres` を置くと **exit 0**。
I3 は `src/lib/**/*.ts` を除外している（そこは Route Handler から呼ばれるサーバーコードで、
`postgres` / `drizzle-orm` を正当に import する）ので、この除外自体は外せない。

**修正**: 除外が成り立つ前提そのものをゲートにした。gate_only_check
`GC-LIB-CLIENT-DIRECTIVE` が `src/lib/**` の `.ts` / `.tsx` に単独行の `'use client'` を
禁止する。クライアントモジュールは `src/components/` か `src/hooks/`（どちらも I3 の対象）に
置くほかなくなる。**実測（修正後）**: `GC-LIB-CLIENT-DIRECTIVE src/lib/client-db.ts:1` / exit 1。
実リポジトリでは対象 21 ファイルで違反 0。

### GPT F-4 [medium・解消済み] コメントアウトした Cloudflare 設定で I1 / I2 が合格する

**再現**: `wrangler.toml` を `# [placement]` / `# mode = "smart"` にしても I1 / I2 とも
違反にならず **exit 0**。4 周目の除去処理が `/* */`・`//`・`--` しか扱わず、TOML の `#` を
残していた。

**修正**: 除去処理を**拡張子ごと**に切り替えた（`.ts/.tsx/.js…` は `//` と `/* */` と
テンプレート文字列、`.sql` は `--` と `/* */`、`.toml/.yml/.sh/.ini/.conf/.env` は `#`、
未知の拡張子は全部）。TypeScript の `#private` を TOML 用の規則で切ってしまう事故を避ける。
**実測（修正後）**: `I1 wrangler.toml:1` / `I2 workers/cron/wrangler.toml:1` / exit 1。

### gemini F-1 [medium・解消済み] コメント内のランクガードで W3 の免除が成立する

3 周目・4 周目に C-004-6 として残していた項目。**再現**:
`UPDATE payments SET status = 'paid' WHERE id = 1; -- and status_rank < 2` で **exit 0**。

**修正**: `allow_if_line_matches` の判定だけを、コメントを除去した行に対して行うようにした。
**違反の検出は生の行のまま**なので、除去が行を切りすぎても違反が増えるだけで、隠れることはない
（4 周目に「偽陽性になる」と書いて見送った懸念は、この非対称性で解消した）。
**実測（修正後）**: `W3 supabase/migrations/000_bypass.sql:1` / exit 1。
`WHERE status_rank < $2` のような本物のガードは引き続き exit 0。

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

### C-004-6 [medium] コメント除去は字句解析ではない（`assert-server-only.mjs` 側は未対応）

3 周目に「行単位 grep の限界」として挙げた 2 件は 4 周目・5 周目に閉じたが、
**除去処理は本物の字句解析ではない**ので、次の性質が残る。

- 通常の引用符（`"` / `'`）の中身は解釈しない。文字列リテラル中の `//` や `--` や `#` で
  行が途中で切れる。`require` 側は「必須が見つからない＝違反」、`forbid` の免除判定側は
  「免除が効かない＝違反」に倒れるので、**どちらも fail-closed** である（違反が隠れる方向には
  倒れない）。代わりに偽陽性が出うる。
- 対の合わない `` ` `` や `/*` があると、そこから先が全部落ちる。これも fail-closed。

**同じ穴は `scripts/assert-server-only.mjs`（task_011 所有・`npm run gate:server-only`）に残る**:
必須検査は `/^\s*import\s+["']server-only["'];?\s*$/m` で、ブロックコメント内の行にもテンプレート
文字列内の行にも一致する。`gate:constraints` 側は塞いだので、いまリポジトリで
「コメントアウトされた `server-only`」を落とせるのは GC-SERVER-ONLY だけである。

**対応案**: TypeScript 側は `assert-server-only.mjs` に AST ベース（`typescript` の
`createSourceFile` → `statements[0]`）の検査を入れる（task_011）。SQL 側（W3）は行 grep ではなく
task_018 の台帳テスト（`src/lib/ledger/apply.ts` 経由でしか状態遷移できないこと）で担保する。

### C-004-5 [medium] `npm run test:unit` が exit 1（本タスク起因 0 件）

**2 周目の実測**（HEAD = 3bdf5d4 + 作業ツリー）: `npm run test:unit` は exit 1
（37 ファイル中 5 ファイル・950 件中 16 件が赤）。赤は `tests/unit/auth/line-route.test.ts` /
`tests/unit/auth/pepper.test.ts` / `tests/unit/auth/csrf.test.ts` /
`tests/unit/config/env.test.ts` / `tests/unit/telemetry.test.ts` で、いずれも他タスクが編集中の
未コミットファイル（`src/lib/auth/pepper.ts` は `AppError` / `ERROR_CODES` が未 import で
`npm run typecheck` も exit 2）に起因した。

**3 周目の実測**（コミット `26eb304` + 3 周目の作業ツリー）: 上の 5 ファイルは他タスク側の修正で
緑になり、`npm run typecheck` は **exit 0**、`npm run lint` / `gate:constraints` /
`gate:wording` も exit 0。`npm run test:unit` は **まだ exit 1** だが、赤は
`tests/unit/ci/acceptance-rerun.test.ts`（task_009 所有）の 1 件だけで、内容は
`Test timed out in 5000ms`。同ファイルを単独で走らせると **15/15 緑・4.33 秒**（実測）なので、
負荷由来のタイムアウトである。同ファイルは `gate-constraints` / `wording-lint` /
`constraints.json` のいずれも参照していない（grep 0 件）。
**task_004 所有の 2 ファイルは 52/52 緑**
（`npx vitest run tests/unit/gate-constraints.test.ts tests/unit/wording-lint.test.ts` = exit 0）。

**4 周目の実測**: `npm run test:unit` は **exit 0**（37 ファイル / **981 件全緑** / 135 秒）。
`typecheck` / `lint` / `gate:constraints` / `gate:wording` / `gate:server-only` も exit 0、
task_004 所有の 2 ファイルは 58/58 緑。3 周目の赤が負荷由来だったことの裏づけになるが、
他タスクのテストが既定 5000ms で書かれている限り再発しうる（C-004-7）。

**5 周目の実測**: `gate:constraints` / `gate:wording` / `gate:server-only` / `lint` は exit 0、
task_004 所有の 2 ファイルは **63/63 緑**。`npm run typecheck` は **exit 2**
（`src/lib/liff/client.ts(421,20) / (433,20): Cannot find name 'callSdk'` — task_013 が編集中の
未コミットファイル）。`npm run test:unit` は **exit 1** で、赤は
`tests/unit/ci/web-only-workflow.test.ts`（task_013 所有・同じく未コミットで編集中）の
アサーション 1 件（`パイプ左側だけの代入は落ちる` が `expected +0 to be 1`）。どちらも
task_004 の所有ファイルを 1 つも参照していない（grep 0 件）。

**6 周目の実測**（task_013 が `d1a2eeb` で当該ファイルをコミットした後）:
`npm run typecheck` は **exit 0**、`npm run test:unit` は **exit 0**
（**38 ファイル / 1005 件全緑** / 69 秒）。4 回目の G5 で gemini が high として挙げた
「`npm run test:unit` が落ちている」は、封筒が読んだ run-log の時点（`d1a2eeb`）の記録であり、
同じ HEAD で走らせ直すと緑になる。`docs/run-log/task_004.json` にその実行を追記した。

### C-004-7 [low] 本タスクのテストがスイート全体の実行時間を押し上げている

回帰テストで実ゲートの起動回数が 3 回 → 12 回に増えた結果、
`tests/unit/gate-constraints.test.ts` 単体で実測 60〜85 秒かかる。vitest はファイルを並列に
走らせるので、このファイルが CPU を奪う間、**既定の 5000ms で書かれた他タスクのテストが
タイムアウトしやすくなる**（C-004-5 の 3 周目の赤がこれ）。本タスク側では実ゲート 1 回の
~4 秒が下限で、これ以上は縮められない。

**対応案**: vitest.config.ts（task_003 所有）の `testTimeout` を既定 5000ms から引き上げるか、
`poolOptions` で並列度を落とす。どちらも本タスクの所有ファイルではないので送り先として記録する。

task_007 / task_013 から送られていた `gate-constraints.test.ts` の
「Test timed out in 5000ms」は本周に再現した（回帰テストを足して実ゲートの起動回数が増えた
3 周目の実行で 9 件が 5 秒超過）。原因はテストの誤りではなく、**実ゲート 1 回が実測 ~4 秒**
（57 エントリ × jq / grep / xargs の起動）で vitest 既定の 5000ms とほぼ同じことなので、
両テストファイルの先頭に `vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })` を置いた。
アサーションは 1 つも緩めていない（`it` 44 → 52 件 / `expect` は増加のみ）。
併せて正規表現の事前検証を 1 エントリ 1 回のバッチに畳み、実行時間を 118 秒 → 64 秒にした。
