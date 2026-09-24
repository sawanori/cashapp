# OSV-Scanner — 一次資料の退避

- 取得日: 2026-09-24
- 取得元:
  - <https://google.github.io/osv-scanner/github-action/>
  - <https://google.github.io/osv-scanner/usage/>
  - <https://google.github.io/osv-scanner/installation/>
  - <https://api.github.com/repos/google/osv-scanner/releases/tags/v2.6.0>
- 用途: `.github/workflows/gate.yml` の `deps` ジョブ（`docs/implementation-plan.md` §16-6
  「`deps` = `npm audit --audit-level=high` ＋ OSV ＋ lockfile 差分レポート ＋ Phase 1 の
  決済 SDK 不在」、R-SEC-13）。

## 1. 公式が案内するのは「再利用可能ワークフロー」だけ

PR スキャン:

```yaml
name: OSV-Scanner PR Scan

on:
  pull_request:
    branches: [main]
  merge_group:
    branches: [main]

permissions:
  actions: read
  security-events: write
  contents: read

jobs:
  scan-pr:
    uses: "google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@v2.6.0"
```

定期スキャン: `google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.6.0`。

inputs（両ワークフロー共通・すべて任意）: `scan-args`（既定 `--recursive ./`）、
`results-file-name`（既定 `results.sarif`）、`download-artifact`、`upload-sarif`（既定 `true`）、
`fail-on-vuln`（既定 `true`）、`matrix-property`（既定 `""`）。

**確認できていないこと**: 非再利用型のコンポジット Action（`google/osv-scanner-action@vX` の
ような形）はドキュメントに記載が無い。したがって「1 つのジョブの 1 ステップとして OSV を
走らせる」書き方は公式ドキュメントからは取れない。

## 2. リリースバイナリ（本リポジトリが採る経路）

再利用可能ワークフローは GitHub の仕様上 **job レベルでしか呼べない**ため、§16-6 が求める
「`deps` ジョブの中で OSV を走らせる」構成にはできない。また `upload-sarif: true` は
Code Scanning（GitHub Advanced Security）の有効化を前提にする。本リポジトリは
`deps` ジョブ内でリリースバイナリを固定バージョンで取得し、チェックサムを検証して使う。

v2.6.0 のリリース資産名（GitHub API の実レスポンスから）:

```
multiple.intoto.jsonl
osv-scanner_darwin_amd64
osv-scanner_darwin_arm64
osv-scanner_linux_amd64
osv-scanner_linux_arm64
osv-scanner_SHA256SUMS
osv-scanner_windows_amd64.exe
osv-scanner_windows_arm64.exe
```

取得 URL の形:
`https://github.com/google/osv-scanner/releases/download/v2.6.0/<asset name>`

ubuntu-latest ランナーは x86_64 なので `osv-scanner_linux_amd64` を使い、
`osv-scanner_SHA256SUMS` で `sha256sum --check` する。

## 3. v2 の CLI

```
osv-scanner scan -L package-lock.json
osv-scanner scan source -L package-lock.json
osv-scanner scan -r ./my-project-dir/
osv-scanner scan -L package-lock.json --format json
```

`scan source` が既定の挙動で、`scan` の短縮形と等価。主なフラグは `--format`（`json` 等）、
`--output-file`、`--verbosity`。

**確認できていないこと**: 終了コードの完全な一覧はこのページに無い。脆弱性が見つかった
場合に非 0 で終わることは `fail-on-vuln` の既定 `true` から読めるが、コード値ごとの意味は
一次資料で確認していない。`deps` ジョブは「非 0 なら fail」としてのみ扱う。

## 4. Docker イメージ

`usage` ページに `docker run -v ${PWD}:/src ghcr.io/google/osv-scanner -L /src/go.mod` の
例がある。`installation` ページにはイメージの正式な参照（タグ規約）の記載が無いため、
**タグ付きの固定参照が取れない**。本リポジトリはこの経路を採らない。
