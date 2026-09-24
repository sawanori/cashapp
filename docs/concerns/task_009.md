# task_009 の残懸念

GitHub Actions CI・PR テンプレート・test-tamper-guard・release.yml の 2 段ゲート。
形式: 指摘 / 深刻度 / 対応案 / 対応予定タスク。

---

## 0-c. 4 周目（2026-09-24）で直したこと

敵対レビューの high 1 件 / medium 5 件のうち、実装で直せる 3 件を「まず穴を再現 → 直す →
同じ手順で塞がったことを実測」の順で直し、branch protection（懸念 2）を設定した。
残る 2 件（`release-mode.json` の不在・PR 経路）は下の 1 / 3 のとおり deferred。

| 指摘 | 対応 | 実測 |
|---|---|---|
| **[high]** `gate.yml` の acceptance 再実行ループは一覧を `done < <(jq …)` で**ループの標準入力**に流し込むため、標準入力を読む `npm` スクリプトが 1 本混ざると、そのコマンドが残りの一覧を食い尽くし、後続の `verify_commands` が実行されないまま「失敗 0 / exit 0」で緑になる。検出ログすら出ない | 一覧の読み出しを fd 3 に逃がし（`while IFS= read -r cmd <&3; … done 3< <(jq …)`）、再実行する子プロセスの標準入力を `npm run "$name" < /dev/null` で塞いだ。あわせて「対象 0 件」の判定を `RAN + SKIPPED` ではなく**読めた行数 `TOTAL`** で見るようにした（全件が形式違反のときに「台帳の読み取りが壊れている」と誤記していた） | 実ファイルの `run:` 本文を YAML から取り出し、`{"aaa-eats-stdin":"cat > /dev/null; exit 0","zzz-should-fail":"exit 7"}` の fixture で走らせた。**旧実装（`git show HEAD:`）は `RUN npm run aaa-eats-stdin` のあと `実行 1 / 委譲 0 / 失敗 0` で EXIT=0**、`zzz-should-fail` は 1 度も実行されない。`aaa-eats-stdin` を台帳から外すと同じ `zzz-should-fail` が `FAIL` / EXIT=1 になる（stdin を読むコマンドの有無だけで赤が緑になる）。修正後は同じ fixture で `実行 1 / 失敗 1` / EXIT=1。`tests/unit/ci/acceptance-rerun.test.ts` 15 件で固定 |
| **[medium]** `release.yml` の (a) 段「ビルド設定の `PAYMENTS_ENABLED` が false であること」の検証が空振り。走査対象 5 ファイルのどれにも `PAYMENTS_ENABLED` という文字列が無く、`true` を探す `grep` は構造上 1 件も当たらないまま常に通る。同じスクリプトが `CONFIG_FILES` 0 件と `npm ls` 出力 0 件は「走査 0 件を緑にしない」として落とすのに、フラグ不在だけが緑だった | 「`true` の不在」ではなく「**`false` の明示が 1 件以上あること**」を要求する。走査対象にフラグの正本（`supabase/migrations/*.sql` の `feature_flag` seed）を加え、`KEY = "value"` / `KEY: value` / `'KEY', 'value'`（SQL の VALUES）の 3 形を読む正規表現にした | 旧実装に「走査対象に `PAYMENTS_ENABLED` が 1 つも無い」fixture を食わせると `ビルド設定の PAYMENTS_ENABLED: true の記述なし` → `(a) 段を通過しました` / **EXIT=0**。修正後は同じ fixture で `走査対象のどこにも PAYMENTS_ENABLED=false の明示がありません` / EXIT=1。正本の SQL（`VALUES ('PAYMENTS_ENABLED', 'false', 'po:noritaka')`）だけがある fixture では EXIT=0 で、`supabase/migrations/0002_seed_gates.sql:2:` を根拠として出力する |
| **[medium]** `release-gate` の 2 段ゲート本体（シェル）に自動テストが 1 本も無い。`assert-release-gate.mjs` は `run:` 本文に文字列と構造があることしか見ておらず、分岐が実際にどう判定するかは無検証。実機で取れたのは `release-mode.json` 不在の 1 経路のみ | acceptance 側と同じ手法（実 YAML から `run:` 本文を取り出して一時ディレクトリで実行）で `tests/unit/ci/release-gate-shell.test.ts` を新設。`docs/gates/` は fixture のディレクトリ名に置換するので、PO 専管の `docs/gates/**` には一切書き込まない。`npm ci` / `npm ls` の 2 行も fixture 読みに置換し、**置換が空振りしたらテストが即座に落ちる**ようにした | 31 件 pass。fail-closed 3 件（ファイル不在 / 値が true・false でない / キーが無い）、(a) 段 16 件（正常系・provider_keys 2 形・フラグの 3 表記 × false・正本の SQL・true の 3 形・走査 0 件・決済 SDK 4 種・`npm ls` 空・偽陽性の対照）、(b) 段 12 件（clearance 不在・`cleared=false`・`basis`/`approved_by`/`approved_at` の空と null・正常系・(a) 段の SDK 検査を通らないこと） |
| **[medium]** branch protection（check_039）が未達で、懸念 2 に書いた「いま入れられない理由」が実測値として古い | 解除条件（`origin/main` がローカル `main` まで進み、その commit で `gate` が緑）が満たされたので**設定した**。懸念 2 を実測値ごと書き直した | `origin/main = d722cc4` = ローカル `main`、未 push 0。`gate` run 35989181608 が 9 ジョブ中 8 success ＋ `adversarial` skipped でワークフロー全体 success。`gate-integration` / `gate-web-only` も success。設定後の読み戻しで required 11 件 / approvals 0 / force push 不可を確認。**`enforce_admins` だけ false のまま残した**（理由と解除条件は懸念 2） |

---

## 0-b. 3 周目（2026-09-24）で直したこと

敵対レビューの medium 3 件（実装で直せるもの）を直した。残る 2 件（`release-mode.json` の
不在・CI 実走とブランチ保護）は環境の制約で deferred のまま。下の 1 / 2 / 3 を参照。

| 指摘 | 対応 | 実測 |
|---|---|---|
| `scripts/ci/assert-release-gate.mjs` は `needs` グラフしか見ておらず、`deploy` に `if: always()` を 1 行足すと「ゲートが赤でもデプロイが走る」`release.yml` を違反 0 件で通す | `needs` で `release-gate` に到達する全ジョブの `if:` に状態関数（`always()` / `failure()` / `cancelled()` / `success()` の否定・比較）が無いことと、`release-gate` のジョブ・各ステップに `continue-on-error` が無いことをアサートに足した | レビューの再現手順（`sed` で `needs: [release-gate]` の下に `if: always()` を挿入）を実行 → 修正後は `check_051 FAIL ジョブ \`deploy\` の \`if:\` が always() を含みます`・exit 1。実物の `release.yml` は違反 0 件・exit 0 のまま。`tests/unit/ci/assert-release-gate.test.ts` を 18 → 31 件に増やし、状態関数 6 種・`continue-on-error` 4 形（ジョブ単位 / ステップ 2 か所 / 評価できない式）で落ちること、絞り込み条件の `if:` と `continue-on-error: false` では落ちないことを固定 |
| `gate.yml` の acceptance ジョブが台帳の文字列を `sh -c "$cmd"` に渡すため、`npm run gate:check \|\| true` のように後ろへシェルを足した値が G2 を通り、再実行が常に exit 0 になる | 再実行ループで `^npm run <script>$` の完全一致を要求し、一致しない値は実行せず違反（`形式違反`）にする。実行はシェルを介さず `npm run "<script>"` の引数として渡す。委譲判定（DB 依存）もコマンド全文ではなくスクリプト名で行う | 旧実装（`git show HEAD:` の `gate.yml`）に `npm run bad \|\| true`（`bad` は `exit 3`）を食わせると `実行 1 / 失敗 0`・**exit 0**。同じ入力で修正後は `完全一致ではありません`・`形式違反 1`・exit 1。`scriptNameOf("npm run bad \|\| true")` が `"bad"` を返すこと（= G2 を通ること）も実測。実ファイルの `run:` 本文を YAML から取り出して走らせた 10 ケース（正常 2 / 仕込み 5 / 委譲 2 / 対象 0 件 1）で不一致 0 件 |
| `scripts/ci/secrets-grep.sh` の 2 周目の分類で、OpenNext がプリレンダ本文を出す `.open-next/cache` が群 (B)（サーバー）に入り、シークレット「名前」の走査から外れていた。ブラウザに配られる面なのに値パターン 5 種でしか見ていない | `.open-next/cache` を群 (A)（クライアント配布物）へ移し、群 (B) の除外名 `CLIENT_DIRS=(assets cache)` と対で管理するようにした | 実ビルド（`npm run build && npm run build:cf`）に対して修正後 exit 0（クライアント 24 / サーバー 1186 ファイル、違反 0 件。修正前は 21 / 1190）。負の対照として `.open-next/cache/<BUILD_ID>/__probe.cache` に `PEPPER` を含むプリレンダ本文を仕込むと、**旧実装は違反 0 件・exit 0**、修正後は `シークレット名 PEPPER がクライアント配布物にあります` + ファイル名・exit 1。`tests/unit/ci/secrets-grep.test.ts` を 23 → 26 件にして固定（cache に名前 → 落ちる / cache の同じ名前をサーバー側の違反として二重計上しない / きれいな cache は通る） |

**この周で状況が変わったこと（GitHub リモートの出現）**: 3 周目の作業中に
`origin git@github.com:sawanori/cashapp.git`（public・default branch `main`）が作られ、
`gate` / `gate-integration` / `gate-web-only` の各ワークフローが実際に走り始めた。
1 / 2 周目の「CI を一度も実走していない」は**もう正しくない**ので、実測できた分を下に記録し、
懸念 3 を書き換えた。実測できていない分（branch protection・PR での `test-tamper-guard`）は
**理由が「リモートが無い」から「いま設定すると並行実行が止まる／`git push` が禁止コマンド」に
変わった**だけで、未達であることは同じ。懸念 2 を参照。

| 実測 | 結果 |
|---|---|
| `gate` ワークフロー run 35985828343（commit `b1bc328`・push トリガ。task_009 の acceptance 修正を含む） | 9 ジョブ中 **8 ジョブ success**（`gate-meta` / `gate-integrity` / `security` / `secrets` / `static` / `labels` / `date-boundary` / `deps`）、`adversarial` は skipped（`workflow_dispatch` 限定・設計どおり）、**`acceptance` のみ failure** |
| `acceptance` が落ちた理由 | 「完了タスクの `verify_commands` を CI で再実行」ステップが `実行 13 / 委譲 2 / 失敗 1 / 形式違反 0`。唯一の失敗は `npm run gate:check`（G5: task_004 / 005 / 006 / 011 / 012 / 013 に `docs/review-log/*.json` が無い）で**他タスク由来**。3 周目で入れた形の縛りは `形式違反 0` として動き、実際に落ちたコマンドをそのまま非 0 で伝播している（F2 対策が CI で機能していることの実測） |
| `secrets` ジョブ | ubuntu ランナー上で `npm run build` → `npm run build:cf` → `secrets-grep.sh` まで通って **success**。ローカルでしか確かめていなかった経路が実機で通った |
| `release` ワークフロー run 35986191784（`workflow_dispatch`・ref `main`） | **`release-gate` = failure / `deploy` = skipped**。最初の run ステップの出力は `release-gate FAIL: docs/gates/release-mode.json がありません。`（以下、正本の所在・既定値・`fail-closed で落とします（L11）`）で `exit code 1`。`cloudflare/wrangler-action` は 1 度も実行されていない |

**この周で残した判断**: レビューの修正案にあった「`docs/task-list.json` を
`check-pr-checklist.mjs` の `GUARDED_PATTERNS` に加える」は**やっていない**。
`tests/unit/ci/check-pr-checklist.test.ts` が「`docs/task-list.json` は保護対象ではない」を
明示的に固定しており、変更すると全タスクが台帳を 1 行直すたびにゲート緩和チェックリストの
記入を求められる。acceptance ジョブ側で形を縛ったことで注入経路そのものは塞がっているので、
多重防御として入れるかどうかは task_006（`check-pr-checklist.mjs` の隣接ゲートの所有者）と
の合意事項として下の 13 に残す。

---

## 0. 2 周目（2026-09-24）で直したこと・直せなかったこと

敵対レビューの指摘を受けた修正周。**直したもの**は以下で、この文書の該当節から
「未解決の懸念」としては外してある。

| 指摘 | 対応 | 実測 |
|---|---|---|
| `secrets` ジョブが現 HEAD で必ず落ちる（シークレット「名」で `.open-next` 全体を走査し、`src/lib/config/env.ts` が正当に参照する PEPPER / SESSION_KEYS / CRON_SECRETS / DATABASE_URL に自分で当たる） | 走査を 2 群に分けた。名前の走査は**クライアント配布物**（`.next/static` / `.open-next/assets`）だけ、サーバーバンドル（`.open-next` の assets 以外）は**値のパターン**だけ | `npm run build && npm run build:cf` のあと `bash scripts/ci/secrets-grep.sh` が exit 0（クライアント 21 / サーバー 1189 ファイル、違反 0 件）。修正前は同じビルドで exit 1・違反 4 件。`tests/unit/ci/secrets-grep.test.ts` 23 件で両方向を固定（クライアントに名前 → 落ちる / サーバーに名前 → 通る / 値は両群で落ちる / 走査 0 件で落ちる） |
| `test-tamper-guard` が PR 本文の編集で再実行されず、緑にしてから本文を空に戻せる | ジョブを `.github/workflows/gate-tamper.yml` に分離し、`types: [opened, synchronize, reopened, edited]` で起動する。`gate.yml` は既定の types のまま（全ジョブを本文編集のたびに回さない） | ワークフロー 6 本の静的検証で `test-tamper-guard` の types に `edited` が入っていること・ジョブ ID が全ワークフローで一意（status check 名の衝突なし）を機械確認 |

**直せなかったもの**は下の 1 / 2 / 3（`docs/gates/**` への書き込み禁止と、GitHub リモートの
不在）で、いずれも deferred のまま残っている。

---

## 1. `docs/gates/release-mode.json` を作れなかった（ハーネス同士の衝突）

- **指摘**: 本タスクの `files_to_create` に `docs/gates/release-mode.json` があるが、
  task_005 が実装した `scripts/deny-test-weakening.sh` が `docs/gates/**` への
  Edit / Write を無条件に exit 2 で遮断する。実際に Write を試み、次の応答で遮断された:

  ```
  deny-test-weakening.sh: BLOCKED
    対象: /Users/noritakasawada/AI_P/cashapp/docs/gates/release-mode.json
    理由: docs/gates/** は PO 専管のゲート定義の正本です（R-SEC-07 / F13）。AI は読むだけで書き換えられません
  ```

  遮断は「書き換え」だけでなく「新規作成」にも効く（判定はパスだけで、ファイルの存在は見ない）。
  ガードを迂回する手段（`.claude/settings.json` の編集、`scripts/deny-*` の編集）は
  いずれも本タスクの禁止事項なので、迂回していない。
- **深刻度**: high。`release.yml` の (a) 段が参照する正本が存在しないため、いまリリースを
  起動すると `release-gate` ジョブが先頭で落ちる。
- **対応案**: fail-closed で実装済み。`release.yml` は `release-mode.json` が無い場合に
  「ゲートが無いから通った」にはせず、既定値を提示して exit 1 する。**PO が次の内容で
  `docs/gates/release-mode.json` を作成する**こと（作成後に
  `node scripts/gate-integrity.mjs --write-baseline` で G13 の基準値を更新する）:

  ```json
  {
    "$comment": "Phase 1（決済なし本番デプロイ）を通す 1 段目のゲート。変更は PO のみ。",
    "schema_version": 1,
    "payments_enabled": false,
    "provider_keys": ["manual_confirm"],
    "basis": null,
    "approved_by": null
  }
  ```

  なお `docs/gates/README.md` の表は既に `release-mode.json` を「task_009 が作る」と
  書いているが、上記の理由で AI からは作れない。README の訂正も PO の手に委ねる
  （`docs/gates/**` なので同じ理由で AI からは直せない）。
- **2 周目（2026-09-24）の再確認**: 修正周でもう一度 Write を試み、同じ文面で遮断された
  （`deny-test-weakening.sh: BLOCKED / 理由: docs/gates/** は PO 専管のゲート定義の正本です
  （R-SEC-07 / F13）`）。迂回はしていない。**deferred: PO が作成する**。
- **3 周目（2026-09-24）の実測**: GitHub リモートが出来たので `release.yml` を
  `workflow_dispatch` で実際に走らせた（run 35986191784）。**`release-gate` = failure /
  `deploy` = skipped** で、出力は設計どおり `release-gate FAIL: docs/gates/release-mode.json が
  ありません。` → `fail-closed で落とします（L11）` → `exit code 1`。
  つまり「正本が無い状態でリリースを起動すると必ず落ちる」ことは**実機で確認済み**であり、
  危険な状態（ゲートを素通りしてデプロイ）にはなっていない。逆に言えば、
  **PO がこのファイルを作るまで本番デプロイは 1 度も成功しない**。
- **4 周目（2026-09-24）の追記**: ファイルは依然として作れない（`ls docs/gates/` は
  `compliance-gates.json` / `integrity-baseline.json` / `legal-clearance.json` / `README.md` のみ）。
  **deferred: PO が作成する**は変わらない。ただし「このファイルがあったときに (a) 段 /
  (b) 段がどう判定するか」は 4 周目に `tests/unit/ci/release-gate-shell.test.ts` で
  31 ケース固定した。テストは実 YAML の `run:` 本文を取り出し、`docs/gates/` を
  fixture のディレクトリ名（`gates-fixture/`）に置換して一時ディレクトリで走らせるので、
  **`docs/gates/**` には一切書き込まない**（ガードを迂回していない）。
  PO がファイルを作ったあとに残る未実測は「GitHub Actions のランナー上で同じ分岐が
  起きること」（check_130 の `workflow_dispatch` 2 通り）だけである。
- **対応予定タスク**: PO（作成）／task_038（ハーネス規約の整理でこの衝突を台帳に反映）

---

## 2. ブランチ保護 — 4 周目（2026-09-24）に設定した。残るのは `enforce_admins` だけ

> **この節は 4 周目に書き換えた。** 3 周目に書いた「いま入れると未 push の 10 コミットが
> `main` に入れられなくなる」は**もう成り立たない**（当時の実測値は
> `origin/main = b1bc328` / 未 push 10 だった）。解除条件として書いた
> 「`origin/main` が現在のローカル `main` まで進み、その commit で `gate` が緑になったこと」
> が満たされたので、設定した。

- **状態**: check_039 は**達成**。`gh api -X PUT repos/sawanori/cashapp/branches/main/protection`
  を実行し、読み戻しで確認した（`scripts/record-run.sh task_009` 経由で記録）。

  ```json
  {"approvals":0,"deletions":false,"enforce_admins":false,"force_push":false,
   "required_contexts":["static","gate-meta","gate-integrity","secrets","deps","acceptance",
   "test-tamper-guard","date-boundary","labels","security","integration"],"strict":false}
  ```

- **設定した時点の実測値（2026-09-24）**:

  | 観測 | 値 |
  |---|---|
  | `git rev-parse origin/main` | `d722cc4` |
  | ローカル `main` | `d722cc4`（`git rev-list --count origin/main..HEAD` = **0**） |
  | `gate` ワークフロー run 35989181608（`d722cc4`） | **9 ジョブ中 8 success ＋ `adversarial` skipped**（`static` / `gate-meta` / `gate-integrity` / `secrets` / `deps` / `acceptance` / `date-boundary` / `labels` / `security`）。ワークフロー全体の conclusion も success |
  | `gate-integration` run 35989181611 | success |
  | `gate-web-only` run 35989181733 | success |
  | `npm run gate:check` の G5 | `warn`（FAIL ではない。task_007 が DONE になるまで warn。残債は task_005 / 006 / 011 / 012 の `docs/review-log/*.json` 不在 4 件） |

- **設定内容**:

  | 設定 | 値 | 根拠 |
  |---|---|---|
  | required status checks | `static` / `gate-meta` / `gate-integrity` / `secrets` / `deps` / `acceptance` / `date-boundary` / `labels` / `security`（`gate.yml`）＋ `test-tamper-guard`（`gate-tamper.yml`）＋ `integration`（`gate-integration.yml`） | §16-6 の required 表。`gh api repos/.../commits/d722cc4/check-runs` で実際のコンテキスト名を読み、ジョブ ID と一致することを確認してから入れた |
  | `strict`（ブランチを最新に保つ） | **false** | true にすると並行タスクのコミットが入るたび全 PR の再 rebase が要る。並行実行下では詰まる側の失敗が大きい |
  | required approving reviews | **0** | 単一アカウント（A19 / R-TH-04）。承認を必須にしても記入者とマージ者が同一人物なので関門にならない |
  | `allow_force_pushes` / `allow_deletions` | false | 履歴の消去を止める |
  | required に入れない | `adversarial`（R-TH-03。task_010 の実測まで）／`web-only`（task_013 所有。§16-6 の required 表に無い）／`e2e`（nightly） | |

- **残る未達 —『直 push 禁止』は `enforce_admins: false` で部分的**:
  - **深刻度**: medium。scope の文言は「直 push 禁止（`enforce_admins` を含む）」だが、
    **`enforce_admins` は false のままにした**。管理者（`sawanori` = 唯一の push 者）は
    required status checks と PR 必須を迂回して `main` に直接 push できる。
  - **理由**: required の `acceptance` は「完了タスクの `verify_commands` を CI で再実行」
    するので `npm run gate:check` を含み、G5 が FAIL になれば `main` が赤になる。
    G5 は `gate:check` の出力どおり「task_007（レビュー経路）が DONE になるまで warn」で、
    **task_007 が DONE になった瞬間に FAIL へ転じうる**。しかも 4 周目の実測では、
    ローカルの G5 が `ok` なのは **task_005 / 006 / 011 / 012 の
    `docs/review-log/*.json` 4 本がワーキングツリーに未追跡で存在するから**であり
    （`git status --short docs/review-log/` が `?? docs/review-log/task_005.json` 以下 4 件）、
    CI がチェックアウトする commit にはまだ入っていない。
    つまり G5 の色は他タスクのコミット状況に依存して動く。
    `enforce_admins: true` の状態でこれが FAIL に振れると `main` は完全に凍結し、
    本ハーネスでは実装エージェントが `git push` を実行できないため、
    凍結を解く修正を運び込む経路は PO の手作業だけになる。
    これは R-TH-04（回避のために保護ごと解除される）を自分から作る手順である。
  - **解除条件（観測可能な形）**: 次の 3 つが同時に満たされたとき、
    `gh api -X PUT repos/sawanori/cashapp/branches/main/protection/enforce_admins` で
    true にする。
    1. `git status --short docs/review-log/` が空（4 本が commit 済み）
    2. `npm run gate:check` の G5 が **`ok`** で、task_007 が DONE
    3. `gh run list --repo sawanori/cashapp --workflow gate.yml --branch main --limit 1` の
       conclusion が `success`
- **対応予定タスク**: task_010（`enforce_admins` の反転と、その後の PR 経路の実測）

---

## 3. CI の実走 — 3 周目で push 実走と release の dispatch は取れた。PR 経路だけが残る

> **3 周目（2026-09-24）で状況が変わった。** 見出しの「一度も実走していない」は
> もう正しくない。実測できた分と、まだ残っている分を先に書く。

- **実測できた分**:
  - `gate` ワークフローが `main` への push で実走し、**9 ジョブ中 8 ジョブが success**
    （run 35985828343、commit `b1bc328`）。赤は `acceptance` だけで、原因は他タスクの
    G5 残債（`docs/review-log/*.json` 不在 6 件）。ubuntu ランナー上でのみ走る経路
    （`secrets` ジョブの `npm run build` → `build:cf` → `secrets-grep.sh`、`deps` ジョブの
    OSV バイナリ取得）も含めて緑になった。
  - **4 周目の追記**: `d722cc4` では `gate` ワークフロー全体が success
    （run 35989181608。9 ジョブ中 8 success ＋ `adversarial` skipped）。
    `gate-integration`（run 35989181611）と `gate-web-only`（run 35989181733）も success。
    G5 は `warn` に落ち着いており、`acceptance` の赤は解消している。
  - `release` ワークフローを `workflow_dispatch` で実走させ、**`release-gate` = failure /
    `deploy` = skipped** を確認（run 35986191784）。`cloudflare/wrangler-action` には
    到達していない。
- **まだ残っている分**:
  1. 「**PR を 1 本作り** static / … / test-tamper-guard / date-boundary が緑」
     — push 実走で 8 ジョブの緑は取れたが、`test-tamper-guard`（`gate-tamper.yml`）は
     `on: pull_request` のみなので PR が無い限り 1 度も起動しない
     （`gh run list --workflow gate-tamper.yml` は 4 周目でも 0 件、
     `gh pr list --state all` も 0 件）。
     **deferred: PO がブランチを publish して PR を作ったあとに実施**。
     PR を作るにはリモートへの publish が要り、`git push` は本ハーネスの禁止コマンドである。
     `gh api` でブランチ ref を作って Contents API でコミットするのも同じ趣旨
     （リモートへの書き込み）に当たると判断して行っていない。
     なお 4 周目で `test-tamper-guard` を required status check に入れたので、
     **PR が 1 本でも立てば必ず起動する**。
  2. 「tests/** に差分がありチェックリスト空の PR で `test-tamper-guard` が落ちることを実測」
     （check_131）— 同上。PR が要る。
  3. 「`payments_enabled=false` で (a) 段を通り、`true` かつ `cleared=false` で先頭で失敗」
     （check_130）— `docs/gates/release-mode.json` を作れないので **GitHub 上では**
     2 通りとも未実測。取れたのは「ファイル不在 → fail-closed」の 1 通りだけ。
     **4 周目の追記**: 判定そのものは `tests/unit/ci/release-gate-shell.test.ts` で
     31 ケース固定した（実 YAML の `run:` 本文を取り出し、`docs/gates/` を fixture の
     ディレクトリ名に置換して一時ディレクトリで `bash` に食わせる）。
     (a) 段の正常系・provider_keys 不正・フラグ true・フラグ不在・決済 SDK 混入・
     `npm ls` 空、(b) 段の clearance 不在・`cleared=false`・`basis`/`approved_by`/
     `approved_at` の空と null・正常系を両方向で固定してある。
     **残っているのは「GitHub Actions のランナー上で同じ分岐が起きること」だけ**である。
  4. branch protection（check_039）— **4 周目で設定した**。上の懸念 2 を参照
     （`enforce_admins` のみ false のまま残した）。
- **以下は 1 / 2 周目の記録（リモートが無かった時点のもの。経緯として残す）**
- **指摘**: 次の 4 項目は GitHub 上でしか確かめられず、リモートが無いので実施していない。
  1. 「PR を 1 本作り static / gate-meta / gate-integrity / secrets / deps / acceptance /
     test-tamper-guard / date-boundary が緑」
  2. 「tests/** に差分がありチェックリスト空の PR で test-tamper-guard が落ちることを実測」（check_131）
  3. 「`release-mode.json.payments_enabled=false` で (a) 段を通り、`true` かつ `cleared=false` で
     先頭で失敗することを実測（workflow_dispatch）」（check_130）
  4. 「branch protection に required status checks があり required approvals が 0」（check_039、上の 2 と同じ）
- **深刻度**: high。「CI に書いた」と「CI で動く」は別である。特に `secrets` / `deps` ジョブは
  ubuntu ランナー上でのみ走る経路（`npm run build:cf`、OSV バイナリの取得）を含み、ローカルでは
  一部しか再現していない。
- **対応案**: **deferred: GitHub リモート作成後に実施**。代わりに本タスクで行った静的検証:
  - 4 本のワークフロー YAML がすべてパースでき、`run:` が呼ぶ `npm run <name>` が
    `package.json.scripts` に実在し、`node`/`bash` が呼ぶ `scripts/**` が実在することを機械確認
    （`docs/run-log/task_009.json` の manual エントリ）。
  - `release.yml` の先頭 2 段ゲートの構造は `scripts/ci/assert-release-gate.mjs` が YAML パースで
    検査し、壊した fixture 14 種で落ちることをユニットテストで確認（check_051）。
  - `test-tamper-guard` の判定器は fixture の PR 本文と差分パスで 26 ケースを確認（check_067）。
  - `secrets-grep.sh` は仕込んだ `PEPPER` を検出し、走査対象 0 件では exit 1 になることを実測。
  つまり「判定器が正しいこと」はローカルで実測済みで、「GitHub 上でその判定器が起動すること」が
  未検証である。
- **2 周目の追加（レビュー指摘への対応）**: `secrets` ジョブは**実際に走らせると落ちていた**
  （名前の走査が自分のサーバーバンドルに当たっていた）。1 周目の「違反 0 件」は
  `/api/me` などのルートが入る前の古いビルド成果物に対する測定で、実物を測っていなかった。
  2 周目では `npm run build && npm run build:cf` を実行してから測り直し、修正前 exit 1・
  修正後 exit 0 を両方実測した。**required に入れる前に、各ジョブを一度は実物のビルド
  成果物に対して走らせること**（リモート作成後の最初の PR で確認する）。
- **3 周目の追記**: 上の「リモート作成後の最初の PR で確認する」は、PR ではなく push 実走で
  果たされた。`secrets` ジョブは実ランナー上で success。残るのは PR 経路だけである。
- **対応予定タスク**: task_010

---

## 4. `date-boundary` ジョブはユニットスイートの TZ を振れない

- **指摘**: §16-6 の `date-boundary` は「`TZ=UTC` と `TZ=Asia/Tokyo` で一致」だが、
  `vitest.config.ts` が `test.env.TZ = "UTC"` を固定しているため、ホストの `TZ` を変えても
  vitest のワーカー内は常に UTC になる。実装を読んで確認した（`node_modules/vitest` の
  ワーカー env は `{...process.env, ...options.env, ...ctx.config.env, ...project.config.env}` の
  順でマージされ、`config.env` が `process.env` に勝つ）。したがって
  「`TZ=Asia/Tokyo npx vitest run tests/unit`」は**空振りする**。
- **深刻度**: medium。ジョブは緑になるが、アプリ側の日付境界ロジックは検査されない
  （R-TH-01 の壊れ方に近い）。
- **2 周目のレビュー指摘（そのまま残る）**: 代替として置いた 2 TZ 比較の対象は
  `scripts/gate-check.mjs` / `scripts/gate-constraints.sh` という**ハーネスのゲート判定器**で
  あって、`src/lib` の日付処理（X-TIME、5 営業日判定、JST 境界）には一切触れない。
  §16-6 の意図に対して覆っている範囲が狭いことは、修正されずに残っている。
  2 TZ 比較そのものは空振りではない（両 TZ で実出力が一致することを実測）が、
  「日付境界が検査されている」と読んではいけない。
  なお本周の時点で `src/lib` に日付・営業日のロジックは**まだ 1 行も無い**
  （`grep -rln '営業日|businessDay|Asia/Tokyo|toZonedTime|JST' src/lib src/app` が 0 件）。
  つまり現時点で覆うべき対象自体が存在しない。**X-TIME の実装が入るタスク（締切計算・
  5 営業日判定・JST 境界）が、`vitest.config.ts` の `env.TZ` を
  `process.env.TZ ?? "UTC"` に変えるところまでを自分の scope に含めること。**
- **対応案**: 現状の `date-boundary` ジョブは、TZ を実際に継承する Node スクリプト
  （`scripts/gate-check.mjs --json` と `scripts/gate-constraints.sh`）の**出力と終了コードを
  2 つの TZ で突き合わせる**構成にした。これは空振りではない（ローカルで 2 TZ 実行し
  一致を確認済み）。ただし対象がゲート判定器に限られる。恒久対処は
  `vitest.config.ts` の `env.TZ` を `process.env.TZ ?? "UTC"` にしてユニットスイート側も
  振れるようにすること。`vitest.config.ts` は本タスクの `files_to_modify` に無いので触っていない。
  ジョブには「固定が残っているか」を毎回出力するステップを入れてあり、固定が外れた時点で
  自動的に 2 TZ 実行に切り替わる。
- **対応予定タスク**: task_022（`vitest.config.ts` に a11y / contract を足すタスク）または task_038

---

## 5. G13 の基準値に、並行タスクの未コミットファイルが焼き込まれる

- **指摘**: `npm run gate:integrity` を緑にするには
  `node scripts/gate-integrity.mjs --write-baseline` で基準値を作り直す必要があるが、この
  コマンドは**作業ツリー全体（未追跡ファイルを含む）**を走査する。本タスクの実行中、task_007 が
  `.claude/agents/*.md`（7 本）・`scripts/validate-findings.mjs` などを未コミットで作成中だった
  （`git status` で観測）。その状態で基準値を作ると、基準値に載っているのにコミットには無い
  ファイルが生まれ、クリーンなチェックアウトで `gate:integrity` が「欠落」で落ちる。
- **深刻度**: high（今回の実害は回避できたが、仕組みとしては残っている）。
- **今回の実測**: 基準値を再生成する直前に task_007 がコミットした（`1f4acfd`）。再生成後の
  `docs/gates/integrity-baseline.json` の `generated_at_commit` は `1f4acfd...` で、載っている
  38 ファイルはすべて「既にコミット済み」か「本タスクのコミットに含まれる」かのどちらかである
  （`git status` で照合）。したがって**この回に限れば**基準値とコミットは整合する。
- **対応案**: (a) **後から完了するタスクが必ず `--write-baseline` をやり直す**という運用規約を
  `docs/HANDOFF.md` に明記した。(b) 全ハーネスタスクが完了した時点で、PO または統合担当が
  クリーンなチェックアウトで `npm run gate:integrity` が exit 0 になることを 1 度確認する。
  (c) 恒久対処としては、基準値の生成対象を `git ls-files` に限る（未追跡ファイルを入れない）
  改修が要る。これは `scripts/gate-integrity.mjs`（task_006 の成果物）の変更なので本タスクでは
  行っていない。
- **対応予定タスク**: task_010（ハーネス実測の締め）／task_038

---

## 5b. `.github/CODEOWNERS` と `.github/PULL_REQUEST_TEMPLATE.md` は G13 のハッシュ対象外

- **指摘**: `scripts/gate-integrity.mjs` の `INTEGRITY_PATTERNS` は `.github/workflows` ディレクトリ
  だけを対象にしており、`.github` 直下の `CODEOWNERS` / `PULL_REQUEST_TEMPLATE.md` は入らない。
  §15-2 の G13 の列挙もそうなっている（仕様どおり）。つまり PR テンプレートからチェックリストの
  4 項目を消す変更は、G13 では検知されない。
- **深刻度**: low。ただし検知経路はある: (1) `test-tamper-guard` の対象は `.github/**` なので、
  テンプレートを変える PR 自体がチェックリスト記入を要求される。(2)
  `tests/unit/ci/check-pr-checklist.test.ts` が「テンプレートが 4 項目のラベルを同じ綴りで持つ」
  ことを検査するので、消すと `static` ジョブの `test:unit` が落ちる。
- **対応案**: 現状のままで足りると判断した。G13 の対象を `.github` ディレクトリ全体に広げるなら
  `gate-integrity.mjs` と §15-2 の両方を直す必要がある。
- **対応予定タスク**: なし（記録のみ）

---

## 6. OSV は公式が案内する経路ではなくリリースバイナリで走らせている

- **指摘**: OSV-Scanner の公式ドキュメントが案内するのは再利用可能ワークフロー
  （`google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@v2.6.0`）だけで、
  これは GitHub の仕様上 **job レベルでしか呼べない**。§16-6 は OSV を `deps` ジョブの中に
  置くと書いているので、固定バージョン（v2.6.0）のリリースバイナリを取得し
  `osv-scanner_SHA256SUMS` で検証してから走らせる構成にした
  （一次資料: `docs/vendor-docs/osv/osv-scanner.md`、取得日 2026-09-24）。
- **深刻度**: medium。(1) 終了コードの完全な仕様は一次資料に無く、「非 0 なら fail」としてしか
  扱っていない。(2) 公式が案内していない経路なので、将来の v3 で資産名が変わると壊れる。
  (3) SARIF を Code Scanning に上げていないので、検出内容は Actions のログにしか残らない。
- **対応案**: リモート作成後の初回 PR で `deps` ジョブのログを確認し、誤検知・終了コードの
  挙動を `docs/vendor-docs/osv/osv-scanner.md` に追記する。Code Scanning を有効にできるなら
  `osv` を独立ジョブ（再利用可能ワークフロー）に切り替えてよい。
- **対応予定タスク**: task_010

---

## 7. `secrets` ジョブの走査語彙が手書きである

- **指摘**: `scripts/ci/secrets-grep.sh` の `SECRET_NAMES` は手書きの配列で、
  `.env.example` / `.dev.vars.example` から自動導出していない。新しい秘密値が増えたときに
  この配列を足し忘れると、その名前は走査されない（黙って通る）。自動導出にしなかったのは、
  `.env.example` には `APP_ENV` のような公開してよい名前も混ざっていて、そのまま走査すると
  常に赤になるためである。
- **深刻度**: medium。
- **対応案**: `.env.example` に「秘密値かどうか」の印（例: `# secret` 行コメント）を入れ、
  そこから導出する。`.env.example` は task_035 の所有なので、そのタスクで印を入れる。
  それまでは、秘密値を増やすタスクが `SECRET_NAMES` にも足す（PR テンプレートの
  ゲート緩和チェックリストが `scripts/**` の差分として記入を要求する）。
- **2 周目で狭めた範囲（意図的）／3 周目の訂正**: シークレット「名前」の走査対象を
  クライアント配布物に限った（上の 0 節）。2 周目はこれを `.next/static` と
  `.open-next/assets` の 2 つとしていたが、OpenNext はプリレンダ済みページの
  **レスポンス本文**を `.open-next/cache/<BUILD_ID>/*.cache` に出す。ここはブラウザに
  配られる面なのに群 (B) に入っていて名前の走査から外れていた（3 周目で群 (A) に移した。
  実測: `PEPPER` を含む `.cache` を仕込むと旧実装は違反 0 件・exit 0、修正後は exit 1）。
  現在の群 (A) は `.next/static` / `.open-next/assets` / `.open-next/cache` の 3 つで、
  群 (B) の除外名は `CLIENT_DIRS=(assets cache)` として 1 か所で管理している。
  **今後 OpenNext がブラウザ配布面の出力先を増やしたら、この 2 か所を同時に直すこと**
  （片方だけ足すと二重走査か走査漏れになる）。
  この限定の結果として、
  **サーバーバンドルに秘密値の「名前」が出ていても検出しない**。これは
  `src/lib/config/env.ts` が `process.env.PEPPER` を正当に読む以上どうしても必要な限定で、
  サーバー側は値のパターン（`sk_live_…` / 資格情報つき `postgres://` / `eyJhbGciOi…`）で
  見ている。「サーバーバンドルに実値が焼き込まれたが、値の形がこの 5 パターンに
  当たらない」ケースは素通りする。これは値パターンの網羅性の問題であり、
  `.env.example` からの導出（上の対応案）では解決しない。
- **対応予定タスク**: task_035（名前の導出）／task_017 以降の決済タスク（値パターンの追加）

---

## 8. `test-tamper-guard` は記入内容を検証しない（設計どおりだが、関門ではない）

- **指摘**: `scripts/ci/check-pr-checklist.mjs` は 4 項目に 1 文字以上あるかしか見ない。
  「緩めていない」と書けば通る。単一アカウント（A19）では記入者とマージ者が同一人物なので、
  これは**承認の代替ではなく、緩和事実の記録強制**である。§16-6 の表現もそうなっている。
- **深刻度**: medium（設計上の限界を、緑を見て「レビュー済み」と誤読しないための記録）。
- **対応案**: 記録が溜まったら、週次メトリクス（§16-7）で「チェックリストが埋まった PR 数」と
  「そのうち実際に何が緩んだか」を突き合わせる。第二の人間が確保できた時点で
  CODEOWNERS の承認必須に切り替える（`.github/CODEOWNERS` は既に領域を宣言済み）。
- **対応予定タスク**: PO（体制）／task_010（メトリクスの初回計測）

---

## 9. `acceptance` ジョブが DB 依存の `verify_commands` を別ワークフローへ委譲している

- **指摘**: `acceptance` ジョブの「`verify_commands` を CI で再実行」は、
  `npm run test:integration` / `gates:sync` / `db:migrate` / `db:diff:drizzle` を実行せず、
  `gate-integration.yml`（task_011 所有）に委譲している。委譲は黙って飛ばすのではなく
  `SKIP <cmd> … gate-integration.yml の担当` とログに出し、実行 0 件なら exit 1 にしてある。
- **深刻度**: medium。2 つのワークフローが両方 required になって初めて「全 `verify_commands` が
  CI で再実行された」と言える。片方を required から外すと穴が開く。
- **対応案**: branch protection の required に `gate-integration / integration` を必ず含める
  （上の懸念 2 の表に記載済み）。
- **対応予定タスク**: task_010

---

## 10. §16-6 の required 表のうち、本タスクで実装していないジョブがある

- **指摘**: `contract`（`test:contract` / `test:conformance`）・`a11y`（`test:a11y`）・
  `legal`（`gate:terms` / `gate:privacy-policy`）・`web-only`（`build:web-only`）・
  `gate:compliance-freshness`・`waf`（`gate:waf`）は、対応する npm スクリプトが
  `package.json` に存在しないため job を作っていない（実在しないコマンドを CI に書かない）。
  `labels` は `gate:wording` のみで、「非自動バッジのスナップショット」は未実装。
  `security` は `test:security` ＋ `gate:server-only` ＋ `gate:env` で、
  `bundle-liff-id-grep`（task_013）は未実装。
- **深刻度**: low（各タスクの scope として台帳に載っている）。
- **対応案**: 各タスクが `.github/workflows/gate-<job>.yml` として独立ファイルで追加する
  （`gate.yml` は task_009 の所有。並行タスクの衝突回避規約）。追加したら branch protection の
  required にも足す。
- **対応予定タスク**: task_013 / task_019 / task_021 / task_022 / task_027

---

## 11. `cloudflare/wrangler-action` の実走が未検証

- **指摘**: `release.yml` の `deploy` ジョブは `cloudflare/wrangler-action@v4` を使い、
  inputs は一次資料（`docs/vendor-docs/cloudflare/wrangler-action.md`、取得日 2026-09-24）の
  `action.yml` から取った。ただし実走していないので、`packageManager: npm` でリポジトリの
  `wrangler` 4.137.0 が使われるか、`.npmrc` の `ignore-scripts=true` の下で action が
  期待どおり動くかは未確認。`CLOUDFLARE_ACCOUNT_ID` も未設定である。
- **深刻度**: low（Phase 1 の本番デプロイは task_025 の担当で、本タスクの非スコープ）。
- **対応案**: task_025 が初回デプロイで確認し、必要なら `wranglerVersion` を明示する。
- **対応予定タスク**: task_025

---

## 12b. G13 の基準値は `--write-baseline` の実行で AI から書き換えられる

- **指摘**（2 周目のレビュー）: `docs/gates/integrity-baseline.json` は
  `docs/gates/**` にあり Edit / Write は全面禁止（`deny-test-weakening.sh` 176 行）だが、
  `node scripts/gate-integrity.mjs --write-baseline` という**正規のスクリプトの Bash 実行**では
  書き換えられる。`deny-dangerous-bash.sh` の書き込み検出はリダイレクト・tee・cp/mv・
  `sed -i`・インタプリタのワンライナー（`-c` / `-e` / `-m`）が対象で、保護対象パスへ書き込む
  スクリプトの実行そのものは対象外である（`PROTECTED_RE` に入っている `scripts/` は
  `scripts/deny-` と `scripts/record-run.sh` だけ）。したがって
  「ガード or テスト or ワークフローを改変 → 基準値を焼き直す」の 2 手で G13 の検出は
  すり抜けられる。**本タスク自身もこの経路で基準値を更新している**（`a261bd9` と本周）。
- **深刻度**: medium。G13 の前提（基準値は AI から動かせない）は現状成立していない。
  high にしないのは、CI が最終防衛線である設計（§16-4）で、リモートの `gate-integrity`
  ジョブは PR の差分として基準値の変更を可視化するため（ただし branch protection が
  効くまでは、その最終防衛線も立っていない — 上の 2）。
- **対応案**: (a) `--write-baseline` を PO 専用にする（実行時に PO の署名や環境変数を要求する）、
  または (b) `deny-dangerous-bash.sh` に「保護対象パスへ書き込む既知スクリプトの実行」を
  明示的に列挙して遮断する。いずれも `scripts/gate-integrity.mjs`（task_006 の成果物）または
  `scripts/deny-*`（task_005 の成果物・本タスクからは編集禁止）の変更なので、本タスクでは
  行っていない。
- **対応予定タスク**: task_038（ハーネス規約の整理）／task_010（ハーネス実測の締め）

---

## 12. PR テンプレートの「実機確認欄」は機械検査していない

- **指摘**: `test-tamper-guard` が読むのはゲート緩和チェックリストの 4 項目だけで、
  実機確認欄・検証ログ欄は空でも通る。
- **深刻度**: low。実機確認の有無は `docs/acceptance-checks.json` の `manual_or_automated`
  と run-log の `--manual` エントリ（G4）で追跡する設計になっており、PR 本文は補助である。
- **対応案**: 現状のままとし、G4 の manual 照合を正とする。
- **対応予定タスク**: なし（記録のみ）

---

## 13. `docs/task-list.json` をゲート緩和チェックリストの保護対象にするか（task_006 との合意事項）

- **指摘**: 台帳 `docs/task-list.json` は誰でも書けるファイルで、`test-tamper-guard` の
  保護対象 7 パターンにも `docs/gates/integrity-baseline.json` の 40 ファイルにも入って
  いない。3 周目で acceptance の再実行ループを `^npm run <script>$` の完全一致に縛った
  ため、「`|| true` を足して再実行を無音で殺す」経路は塞がった。ただし台帳そのものは
  依然として無記録で書き換えられる（例: `completion_status` を後から `null` に戻す、
  `verify_commands` を 1 本削る）。
- **深刻度**: medium。台帳は G1〜G5 の入力であり、ここを書き換えると複数のゲートの
  判定対象が静かに減る。
- **対応案**: 2 通りあり、どちらを取るかは `scripts/ci/check-pr-checklist.mjs` の隣接
  ゲートを持つ task_006 との合意が要る。
  1. `check-pr-checklist.mjs` の `GUARDED_PATTERNS` に `docs/task-list.json` を足す。
     副作用として、台帳を 1 行直すだけの PR にもゲート緩和チェックリストの記入が要る
     （各タスクが完了時に `completion_status` を書くので、ほぼ全 PR が対象になる）。
     `tests/unit/ci/check-pr-checklist.test.ts` が「保護対象ではない」を明示的に固定して
     いるので、そのテストの書き換えも同時に必要。
  2. 台帳を `docs/gates/integrity-baseline.json` の対象に入れず、代わりに
     「完了タスクの `verify_commands` が減っていないこと」を base との差分で見る専用の
     判定を足す（緩和の事実だけを検知する）。
  この周では 1 を採らず、acceptance 側の形の縛りだけで塞いだ。
- **対応予定タスク**: task_006（`check-pr-checklist.mjs` の所有者）／task_010（ハーネス実測の締め）
