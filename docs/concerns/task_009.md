# task_009 の残懸念

GitHub Actions CI・PR テンプレート・test-tamper-guard・release.yml の 2 段ゲート。
形式: 指摘 / 深刻度 / 対応案 / 対応予定タスク。

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
- **対応予定タスク**: PO（作成）／task_038（ハーネス規約の整理でこの衝突を台帳に反映）

---

## 2. ブランチ保護を設定していない（check_039 未達）

- **指摘**: `scope` の「gh api で branch protection（required status checks、直 push 禁止、
  承認必須なし）」は実施していない。`git remote -v` は空で、GitHub 上にリポジトリが存在しない
  （PO 判断待ち）。`gh auth status` は `sawanori` で認証済みだが、対象リポジトリが無いので
  `gh api repos/:owner/:repo/branches/main/protection` は叩けない。リポジトリ作成は本タスクの
  スコープ外であり、`git push` は禁止コマンドである。
- **深刻度**: high。CI ジョブを書いただけでは「ローカルフックを迂回したコミットをリモートで
  止める」という本タスクの goal は成立しない。required status checks に載るまで、gate.yml は
  「走るが落ちても止められない」状態である。
- **対応案**: **deferred: GitHub リモート作成後に実施**。リモート作成後に設定する内容を確定して
  おく（required に入れるのは実走で緑を確認できたものだけ）:

  | 設定 | 値 |
  |---|---|
  | required status checks | `static` / `gate-meta` / `gate-integrity` / `secrets` / `deps` / `acceptance` / `test-tamper-guard` / `date-boundary` / `labels` / `security` / `integration`（`gate-integration.yml` 由来） |
  | required に入れない | `adversarial`（R-TH-03。task_010 の実測まで）、`e2e`（別 workflow・nightly） |
  | required approving reviews | **0**（単一アカウント。A19 / R-TH-04） |
  | 直 push | 禁止（`enforce_admins` を含む） |

  ジョブ名は `.github/workflows/gate.yml` のジョブ ID と一致させてある（`name:` を別に
  与えていないため、status check のコンテキスト名はジョブ ID になる）。
- **対応予定タスク**: task_010（リモート作成後のハーネス実測）／PO（リポジトリ作成）

---

## 3. CI を一度も実走していない（done_definition の 3 項目と check_130 / check_131 が未達）

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
- **対応予定タスク**: task_035

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

## 12. PR テンプレートの「実機確認欄」は機械検査していない

- **指摘**: `test-tamper-guard` が読むのはゲート緩和チェックリストの 4 項目だけで、
  実機確認欄・検証ログ欄は空でも通る。
- **深刻度**: low。実機確認の有無は `docs/acceptance-checks.json` の `manual_or_automated`
  と run-log の `--manual` エントリ（G4）で追跡する設計になっており、PR 本文は補助である。
- **対応案**: 現状のままとし、G4 の manual 照合を正とする。
- **対応予定タスク**: なし（記録のみ）
