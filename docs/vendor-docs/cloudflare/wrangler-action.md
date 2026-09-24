# cloudflare/wrangler-action — 一次資料の退避

- 取得日: 2026-09-24
- 取得元:
  - <https://raw.githubusercontent.com/cloudflare/wrangler-action/main/README.md>
  - <https://raw.githubusercontent.com/cloudflare/wrangler-action/main/action.yml>
- 用途: `.github/workflows/release.yml` の本番デプロイステップ（`docs/implementation-plan.md`
  §16-6「デプロイは `cloudflare/wrangler-action` による `wrangler deploy --env production`」）。

## 現行メジャーバージョン

`v4`。README に「The action now defaults to **Wrangler v4**」とある。本リポジトリは
`cloudflare/wrangler-action@v4` を使う。

## inputs（action.yml の `inputs:` 節そのまま）

```yaml
inputs:
  apiToken:
    description: "Your Cloudflare API Token"
    required: false
  accountId:
    description: "Your Cloudflare Account ID"
    required: false
  quiet:
    description: "Supresses output from Wrangler commands, defaults to `false`"
    required: false
    default: "false"
  environment:
    description: "The environment you'd like to deploy your Workers project to - must be defined in wrangler.toml"
  workingDirectory:
    description: "The relative path which Wrangler commands should be run from"
    required: false
  wranglerVersion:
    description: "The version of Wrangler you'd like to use to deploy your Workers project"
    required: false
  secrets:
    description: "A string of environment variable names, separated by newlines. These will be bound to your Worker as Secrets and must match the names of environment variables declared in `env` of this workflow."
    required: false
  preCommands:
    description: "Commands to execute before deploying the Workers project"
    required: false
  postCommands:
    description: "Commands to execute after deploying the Workers project"
    required: false
  command:
    description: 'The Wrangler command (along with any arguments) you wish to run. Multiple Wrangler commands can be run by separating each command with a newline. Defaults to `"deploy"`. The `preview` command requires Wrangler >= 4.136.0.'
    required: false
  vars:
    description: "A string of environment variable names, separated by newlines. These will be bound to your Worker using the values of matching environment variables declared in `env` of this workflow."
    required: false
  packageManager:
    description: "The package manager you'd like to use to install and run wrangler. If not specified, the preferred package manager will be inferred based on the presence of a lockfile or fallback to using npm if no lockfile is found. Valid values are `npm` | `pnpm` | `yarn` | `bun`."
    required: false
  gitHubToken:
    description: "GitHub Token"
    required: false
```

## README の最小例（原文どおり）

```yaml
name: Deploy

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Deploy
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy --env production
```

## 本リポジトリでの使い方に関する確定事項

- `command: deploy --env production` を使う（`environment:` input ではなく `command` の
  `--env` で指定する。README の最小例と同じ書き方）。`wrangler.toml` に `[env.production]`
  が実在することが前提（実在する。`wrangler.toml` 参照）。
- `apiToken` / `accountId` は GitHub の **`environment: production`** に置いたシークレット
  からのみ渡す（§16-6・L11）。ワークフローの `env:` やリポジトリ変数には置かない。
- `secrets:` input は「`env:` に宣言した環境変数名を Worker の Secret として束ねる」もので
  あり、本番シークレットの投入経路になる。Phase 1 では使わない（決済鍵が無いため）。
  使うときも値は `environment: production` のシークレット由来に限る。
- 未確認: `wrangler-action` が内部で走らせる `wrangler` のバージョン固定（`wranglerVersion`）
  を本リポジトリの `wrangler` 4.137.0 に合わせるべきかは実走で確認していない。現状は
  `packageManager: npm` によりリポジトリの devDependency（4.137.0）が使われる想定だが、
  **実走で未検証**（GitHub リモート未作成）。
