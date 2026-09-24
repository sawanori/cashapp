#!/usr/bin/env bash
# scripts/ci/secrets-grep.sh  —  CI の secrets ジョブの本体
#
# ビルド成果物に秘密値が載っていないことを走査する（R-SEC-04、§16-6 の `secrets` ジョブ）。
# `server-only` のインポート検査（scripts/assert-server-only.mjs）は「サーバー専用モジュールが
# クライアントから参照されていないか」を型・import の層で見るが、実際に出来上がったバンドルの
# 中身は見ない。この 2 つは別の層の検査で、片方では代替できない。
#
# ★ 走査は 2 群に分ける。混ぜると必ず偽陽性になる [実測 2026-09-24]。
#
#   (A) クライアント配布物 … .next/static ・ .open-next/assets
#       ブラウザに配られる JS / CSS。ここに**シークレットの名前**が出てはいけない。
#       名前が出るということは、クライアント側のコードがその環境変数を参照しようとして
#       いる（= いずれ値が載る経路がある）ことを意味する。値のパターンも当然だめ。
#
#   (B) サーバーバンドル … .open-next の assets 以外（server-functions / worker.js /
#       middleware / cloudflare / cache …）
#       ここは `process.env.PEPPER` を読む正当なコードが入る場所である。実際、
#       src/lib/config/env.ts の検証エラーメッセージが PEPPER / SESSION_KEYS /
#       CRON_SECRETS / DATABASE_URL という**名前**をバンドルに残す。名前で走査すると
#       必ず落ちるので、ここは**値のパターンだけ**を見る。
#
#   名前の走査を (A) に限った理由の実測（2026-09-24、HEAD=b2addd3 の直後のビルド）:
#     grep -rIl PEPPER .next/static        → 0 件（クライアントは汚染されていない）
#     grep -rIl PEPPER .open-next          → 4 件（すべて server-functions / handler.mjs）
#   混ぜた実装では `secrets` ジョブが常に赤になり、required に入れた瞬間に
#   「回避として branch protection ごと解除」（R-TH-04）へ直行する。
#
# 使い方:
#   bash scripts/ci/secrets-grep.sh [--root <dir>]
#
# 終了コード: 0 検出なし / 1 検出あり、またはどちらかの群の走査対象が 0 件 / 2 使用法エラー
#
# ★ 走査対象が 0 件なら exit 1 にする（群ごとに判定する）。ビルドしていない状態で緑になる
#   ゲートは、R-TH-01（空振りしても緑）そのものだから。

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

# ------------------------------------------------------- (A) クライアント --
CLIENT_TARGETS=()
[ -d ".next/static" ] && CLIENT_TARGETS+=(".next/static")
[ -d ".open-next/assets" ] && CLIENT_TARGETS+=(".open-next/assets")

# ------------------------------------------------------------ (B) サーバー --
# .open-next 直下の assets 以外をすべて対象にする（将来 OpenNext が出力を増やしても
# 名前を列挙し直さなくて済むように、除外リスト方式にする）。
SERVER_TARGETS=()
if [ -d ".open-next" ]; then
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$(basename "$entry")" in
      assets) continue ;;
    esac
    SERVER_TARGETS+=("$entry")
  done < <(find .open-next -mindepth 1 -maxdepth 1 2>/dev/null | sort)
fi

missing=0
if [ "${#CLIENT_TARGETS[@]}" -eq 0 ]; then
  cat >&2 <<'EOF'
secrets-grep.sh: クライアント配布物がありません（.next/static も .open-next/assets も存在しません）。
  `npm run build` と `npm run build:cf` を先に実行してください。
  走査対象 0 件を緑にすると、ビルドしないだけでこのゲートを迂回できます（R-TH-01）。
EOF
  missing=1
fi
if [ "${#SERVER_TARGETS[@]}" -eq 0 ]; then
  cat >&2 <<'EOF'
secrets-grep.sh: サーバーバンドルがありません（.open-next に assets 以外の出力がありません）。
  `npm run build:cf` を先に実行してください（R-TH-01）。
EOF
  missing=1
fi
[ "$missing" -eq 0 ] || exit 1

client_count="$(find "${CLIENT_TARGETS[@]}" -type f 2>/dev/null | wc -l | tr -d ' ')"
server_count="$(find "${SERVER_TARGETS[@]}" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$client_count" -eq 0 ] || [ "$server_count" -eq 0 ]; then
  echo "secrets-grep FAIL: 走査対象のファイルが 0 件です（クライアント ${client_count} / サーバー ${server_count}）" >&2
  exit 1
fi

# ---------------------------------------------------- 実シークレットの名前 --
#
# .env.example / .dev.vars.example の「名前」を正本にしつつ、まだ雛形に無い将来の
# 秘密値も先に載せておく（task_017 以降の決済鍵など）。公開してよい値（APP_ENV、
# NEXT_PUBLIC_*、LIFF ID）はここに載せない。LIFF ID の grep は別検査
# （bundle-liff-id-grep、task_013）の担当。
#
# ★ この配列を使うのは (A) クライアント配布物の走査だけである。
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
# (A) にも (B) にも適用する。
#
# ★ 以前あった 'SUPABASE_SERVICE_ROLE' はここから外した。あれは値ではなく**名前**で、
#   サーバーバンドルに正当に現れうる。名前としては SECRET_NAMES に入っており (A) で見る。
#   サーバー側に service_role の実値が載った場合は eyJhbGciOi… の JWT パターンで当たる。
VALUE_PATTERNS=(
  'sk_live_[A-Za-z0-9]'
  'pk_live_[A-Za-z0-9]'
  'sk_test_[A-Za-z0-9]'
  'postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]+@'
  'eyJhbGciOi[A-Za-z0-9_-]{8,}'
)

violations=0

echo "secrets-grep: (A) クライアント配布物 ${CLIENT_TARGETS[*]}（${client_count} ファイル）"
echo "secrets-grep: (B) サーバーバンドル ${SERVER_TARGETS[*]}（${server_count} ファイル）"

scan() {
  # $1 = 見出し, $2 = grep の拡張正規表現, $3.. = 走査対象
  local label="$1"
  local pattern="$2"
  shift 2
  local hits
  hits="$(grep -rIlE -- "$pattern" "$@" 2>/dev/null)"
  if [ -n "$hits" ]; then
    echo "secrets-grep FAIL ${label}:" >&2
    # ファイル名だけを出す。値そのものはログに出さない（秘密値をログに出さない規約）。
    echo "$hits" | sed 's/^/    /' >&2
    violations=$((violations + 1))
  fi
}

for name in "${SECRET_NAMES[@]}"; do
  scan "シークレット名 ${name} がクライアント配布物にあります" "$name" "${CLIENT_TARGETS[@]}"
done

for pat in "${VALUE_PATTERNS[@]}"; do
  scan "本番鍵らしい値のパターン（${pat}）がクライアント配布物にあります" "$pat" "${CLIENT_TARGETS[@]}"
  scan "本番鍵らしい値のパターン（${pat}）がサーバーバンドルにあります" "$pat" "${SERVER_TARGETS[@]}"
done

echo "secrets-grep — クライアント ${client_count} ファイル / サーバー ${server_count} ファイルを走査、違反 ${violations} 件"

[ "$violations" -eq 0 ] || exit 1
exit 0
