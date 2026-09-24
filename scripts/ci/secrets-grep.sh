#!/usr/bin/env bash
# scripts/ci/secrets-grep.sh  —  CI の secrets ジョブの本体
#
# ビルド成果物（クライアントに配られるもの）に秘密値が載っていないことを、
# **実シークレット名**と本番鍵の値パターンで走査する（R-SEC-04、§16-6 の
# `secrets` ジョブ）。`server-only` のインポート検査（scripts/assert-server-only.mjs）は
# 「サーバー専用モジュールがクライアントから参照されていないか」を型・import の層で見るが、
# 実際に出来上がったバンドルの中身は見ない。この 2 つは別の層の検査で、片方では代替できない。
#
# 走査対象:
#   .next/static   … Next.js がクライアントに配る JS / CSS
#   .open-next     … OpenNext が組み立てる Worker バンドルと静的アセット
#
# 使い方:
#   bash scripts/ci/secrets-grep.sh [--root <dir>]
#
# 終了コード: 0 検出なし / 1 検出あり、または走査対象が 1 つも無い / 2 使用法エラー
#
# ★ 走査対象が 0 件なら exit 1 にする。ビルドしていない状態で緑になるゲートは、
#   R-TH-01（空振りしても緑）そのものだから。

set -uo pipefail

SELF="secrets-grep.sh"
ROOT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      [ "$#" -ge 2 ] || { echo "$SELF: --root requires a value" >&2; exit 2; }
      ROOT="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: bash scripts/ci/secrets-grep.sh [--root <dir>]"
      exit 0
      ;;
    *)
      echo "$SELF: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "$SELF: not inside a git repository（--root で明示してください）" >&2
    exit 2
  }
fi

cd "$ROOT" || { echo "$SELF: cd failed: $ROOT" >&2; exit 2; }

# --------------------------------------------------------------- 走査対象 --
TARGETS=()
[ -d ".next/static" ] && TARGETS+=(".next/static")
[ -d ".open-next" ] && TARGETS+=(".open-next")

if [ "${#TARGETS[@]}" -eq 0 ]; then
  cat >&2 <<'EOF'
secrets-grep.sh: 走査対象がありません（.next/static も .open-next も存在しません）。
  `npm run build` と `npm run build:cf` を先に実行してください。
  走査対象 0 件を緑にすると、ビルドしないだけでこのゲートを迂回できます（R-TH-01）。
EOF
  exit 1
fi

# ---------------------------------------------------- 実シークレットの名前 --
#
# 「名前が成果物に出ている」ことを違反として扱う。値が出ていなくても、名前が
# クライアントバンドルにあるということは、その環境変数をクライアント側のコードが
# 参照しようとしている（= いずれ値が載る経路がある）ことを意味する。
#
# .env.example / .dev.vars.example の「名前」を正本にしつつ、まだ雛形に無い将来の
# 秘密値も先に載せておく（task_017 以降の決済鍵など）。公開してよい値（APP_ENV、
# NEXT_PUBLIC_*、LIFF ID）はここに載せない。LIFF ID の grep は別検査
# （bundle-liff-id-grep、task_013）の担当。
SECRET_NAMES=(
  PEPPER
  SESSION_KEYS
  CRON_SECRETS
  APP_RW_PASSWORD
  DATABASE_URL
  DATABASE_URL_MIGRATOR
  SUPABASE_SERVICE_ROLE_KEY
  CLOUDFLARE_API_TOKEN
  LINE_CHANNEL_SECRET
  LINE_LOGIN_CHANNEL_SECRET
  PAYJP_SECRET_KEY
  PAYPAY_API_SECRET
  STRIPE_SECRET_KEY
)

# ------------------------------------------------------------ 値のパターン --
#
# 本番鍵そのものの形。scripts/deny-test-weakening.sh の PROD_KEY_RE と同じ考え方で、
# 文字クラスを後ろに置いてこのファイル自身に当たらないようにする。
VALUE_PATTERNS=(
  'sk_live_[A-Za-z0-9]'
  'pk_live_[A-Za-z0-9]'
  'sk_test_[A-Za-z0-9]'
  'postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]+@'
  'eyJhbGciOi[A-Za-z0-9_-]{8,}'
  'SUPABASE_SERVICE_ROLE'
)

violations=0

echo "secrets-grep: 走査対象 ${TARGETS[*]}"

scan() {
  # $1 = 見出し, $2 = grep の拡張正規表現
  local label="$1"
  local pattern="$2"
  local hits
  hits="$(grep -rIlE -- "$pattern" "${TARGETS[@]}" 2>/dev/null)"
  if [ -n "$hits" ]; then
    echo "secrets-grep FAIL ${label} がビルド成果物にあります:" >&2
    # ファイル名だけを出す。値そのものはログに出さない（秘密値をログに出さない規約）。
    echo "$hits" | sed 's/^/    /' >&2
    violations=$((violations + 1))
  fi
}

for name in "${SECRET_NAMES[@]}"; do
  scan "シークレット名 ${name}" "$name"
done

for pat in "${VALUE_PATTERNS[@]}"; do
  scan "本番鍵らしい値のパターン（${pat}）" "$pat"
done

file_count="$(find "${TARGETS[@]}" -type f 2>/dev/null | wc -l | tr -d ' ')"
echo "secrets-grep — ${file_count} ファイルを走査、違反 ${violations} 件"

[ "$violations" -eq 0 ] || exit 1
exit 0
