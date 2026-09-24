# tests/gates/fixtures/violations/

ゲート網が**空振りしていない**ことを機械的に証明するための違反フィクスチャ置き場（R-TH-01 / G0 / F12）。

ゲートが「違反を検出しなかった」ことと「そもそも何も見ていなかった」ことは、緑という結果からは
区別できない。ここに置く各フィクスチャは、対応するゲートが**実際に非ゼロ終了する**ことを示す
再現可能な反例であり、`npm run test:gate-meta`（`tests/gates/meta.test.ts`）が全件を実行して
検証する。

## 1 フィクスチャ = 1 ディレクトリ

```
tests/gates/fixtures/violations/<fixture_id>/
  meta.json          ← 何のゲートを、どう走らせ、何が出れば合格かの宣言
  <overlay files>    ← 違反を成立させる最小限のファイル群
```

`meta.json` のフィールド:

| フィールド | 意味 |
|---|---|
| `fixture_id` | ディレクトリ名と一致必須 |
| `gate` | 落ちるはずのゲート ID（`G0`〜`G14`、または `docs/constraints.json` / `docs/wording-policy.md` の制約 ID） |
| `description` | 何を模した違反か |
| `runner` | `{cmd, args}`。`args` の `{FIXTURE}` はフィクスチャの絶対パスに置換される。実行時の cwd はリポジトリルート |
| `expect_exit_nonzero` | 常に `true`（`false` のフィクスチャはメタゲートの意味がない） |
| `expect_output_contains` | 標準出力＋標準エラーに必ず現れる文字列。**非ゼロ終了だけでは不十分**で、「意図した違反で落ちた」ことをここで固定する |
| `absent` | （`gate-check.mjs` 用）ベースリポジトリに存在するが、このフィクスチャでは「無い」ものとして扱うパス |
| `blocked_on` | `runner` が無いフィクスチャで、実行手段を作るタスク ID |
| `provenance` | `{authored_by, kind, note}`。誰が書いたか、実データの写しか合成か |

## なぜ `expect_output_contains` が必須か

`gate-constraints.sh` は「対象 0 件のゲート」でも exit 1 になる。フィクスチャのディレクトリを
`--root` に渡すと、そのフィクスチャに関係しない制約はほぼ全部が対象 0 件になるため、
**exit code だけを見ると「意図した違反を検出した」と「無関係な理由で落ちた」が区別できない**。
`expect_output_contains` は違反行そのもの（例: `L1 src/lib/payouts.ts:`）を固定するので、
ゲートの検出ロジックを壊した変更はここで落ちる。

## overlay の解決規則（`gate-check.mjs`）

`node scripts/gate-check.mjs --root <fixture>` は、入力ファイルを **`--root` 優先、無ければ
リポジトリ（`--base`）にフォールバック**して解決する。だからフィクスチャは違反を構成する
数ファイルだけを持てばよく、`docs/implementation-plan.md` のような大きな入力は実物が使われる。
ベースにあるファイルを「無い」ことにしたい場合は `meta.json` の `absent` に書く。

`--only <gate>` は exit code を決めるゲートを絞るだけで、全ゲートは常に実行される
（G0 が他ゲートの対象件数を見るため）。

## `src/**` に見える .ts ファイルについて

`src/` 配下に見えるファイルはフィクスチャのディレクトリ内にあり、実アプリのビルドには入らない。
ただしリポジトリ全体の `npm run typecheck` / `npm run lint` の対象には入るため、**型検査と lint を
通る本物の TypeScript** として書いてある。`gate:constraints` / `gate:wording` は
`global_exclude_globs` / `exclude_globs` に `tests/gates/fixtures/**` を持っているので、
ここの違反が本番のゲートを赤くすることはない。

決済事業者 SDK（`stripe` 等）は本リポジトリに意図的にインストールされていない（P1 / deps ジョブ）。
そのためその種のフィクスチャは、ゲートが実際に走査する**行のテキスト**を文字列定数として置いている。
対象のゲートが grep（テキスト一致）である以上、これは忠実な反例である。

## 追加するとき

1. ディレクトリを作り `meta.json` を書く。
2. 違反を成立させる最小のファイルを置く。
3. `npm run test:gate-meta` が緑（＝そのフィクスチャで対応ゲートが非ゼロ終了する）ことを確認する。
4. ゲート側を直したら 3 をもう一度走らせる。フィクスチャを緩めて通すことは禁止（`deny-test-weakening.sh`）。

## 未達として記録していること

`docs/implementation-plan.md` の task_006 scope は「最初の 1 本は人間が手書きし CODEOWNERS 対象」と
定めている。本ディレクトリのフィクスチャはすべてモデル（task_006 実装エージェント）が書いたもので、
`provenance.authored_by` にそのとおり記録してある。`gate-check.mjs` の G0 は
「人間が手書きしたフィクスチャが 0 本」を **warn** として毎回表示する。CODEOWNERS 自体は task_009 の
成果物であり、本タスクでは作らない。詳細は `docs/concerns/task_006.md`。
