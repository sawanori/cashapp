#!/usr/bin/env bash
# scripts/build-review-packet.sh
#
# 敵対レビューへ渡す「封筒」を組み立てる。
# docs/implementation-plan.md §16-5 / task_007 / R-TH-08 / R-TH-10。
#
# 封筒の中身は 2 つの事故から逆算して決めてある。
#
#   * R-TH-10（コスト暴走）— 制約は 54 件ある。全文を毎回同梱すると封筒だけで
#     数千〜1 万トークンになり、4〜5 並列 × 最大 3 周 × タスク数ぶん焼ける。
#     **同梱するのは当該タスクの constraint_ids に載っている制約だけ**にする。
#     実際に何バイト積んだかは payload_bytes として封筒自身に書き、
#     1 周ごとの計測（run-log）で代理指標として使えるようにする。
#   * R-TH-08（レビューの誤検出）— diff だけ渡すと「この Route Handler は CSRF を
#     検証していない」のように、別ファイルで担保済みの事項を high で指摘される。
#     **diff が触れたファイルの全文と、それらが import している自作モジュールの
#     全文**を同梱して、レビュアが担保箇所を見られるようにする。
#
# 使い方:
#   scripts/build-review-packet.sh <task_id> [--base <git-ref>] [--out <file>]
#                                  [--import-depth <n>] [--max-file-bytes <n>]
#                                  [--max-diff-bytes <n>] [--root <dir>]
#
#   --base 未指定なら HEAD と作業ツリーの差分（未追跡ファイルを含む）を対象にする。
#   --base <ref> を渡すと <ref>...<head> の差分を対象にする（--head の既定は HEAD）。
#   並行タスクが先にコミットすると HEAD は自分のコミットではなくなるので、
#   自タスクだけを見せたいときは --base <親> --head <自分のコミット> を渡す。
#
# 上限は 2 つとも R-TH-10 のためにある。実測: 265KB の封筒（同梱 17 ファイル・
# diff 150KB）を gemini-2.5-pro に渡すと 900 秒で応答が返らずタイムアウトした
# （2026-09-24）。88KB の封筒は同じモデルで 2 分以内に返った。**封筒が大きいほど
# レビューが返らなくなる**ので、上限は「切り詰めた事実を封筒に書いたうえで切る」。
#
# 終了コード: 0 = 生成した / 64 = usage / 65 = 入力（task-list 等）が読めない。

set -uo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/build-review-packet.sh <task_id> [--base <git-ref>] [--out <file>]
                                 [--import-depth <n>] [--max-file-bytes <n>]
                                 [--max-diff-bytes <n>] [--root <dir>]
EOF
  exit 64
}

for bin in jq git; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "build-review-packet.sh: missing required dependency: $bin" >&2
    exit 69
  }
done

[ "$#" -ge 1 ] || usage
TASK_ID="$1"
shift
case "$TASK_ID" in
  --*|*[!A-Za-z0-9_.-]*|"") usage ;;
esac

BASE=""
HEAD_REF="HEAD"
OUT=""
IMPORT_DEPTH=1
MAX_FILE_BYTES=200000
MAX_DIFF_BYTES=120000
ROOT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) shift; [ "$#" -ge 1 ] || usage; BASE="$1" ;;
    --head) shift; [ "$#" -ge 1 ] || usage; HEAD_REF="$1" ;;
    --out) shift; [ "$#" -ge 1 ] || usage; OUT="$1" ;;
    --import-depth)
      shift; [ "$#" -ge 1 ] || usage; IMPORT_DEPTH="$1"
      case "$IMPORT_DEPTH" in ''|*[!0-9]*) usage ;; esac ;;
    --max-file-bytes)
      shift; [ "$#" -ge 1 ] || usage; MAX_FILE_BYTES="$1"
      case "$MAX_FILE_BYTES" in ''|*[!0-9]*) usage ;; esac ;;
    --max-diff-bytes)
      shift; [ "$#" -ge 1 ] || usage; MAX_DIFF_BYTES="$1"
      case "$MAX_DIFF_BYTES" in ''|*[!0-9]*) usage ;; esac ;;
    --root) shift; [ "$#" -ge 1 ] || usage; ROOT="$1" ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$ROOT" ]; then
  ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

TASK_LIST="$ROOT/docs/task-list.json"
CONSTRAINTS="$ROOT/docs/constraints.json"
WORDING="$ROOT/docs/wording-policy.md"

[ -f "$TASK_LIST" ] || { echo "build-review-packet.sh: $TASK_LIST がありません" >&2; exit 65; }

TASK_JSON="$(jq -c --arg id "$TASK_ID" '.tasks[] | select(.task_id == $id)' "$TASK_LIST")"
if [ -z "$TASK_JSON" ]; then
  echo "build-review-packet.sh: task-list に $TASK_ID がありません" >&2
  exit 65
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

DIFF_FILE="$TMP_DIR/diff.txt"
CHANGED="$TMP_DIR/changed.txt"

if [ -n "$BASE" ]; then
  git -C "$ROOT" diff "$BASE...$HEAD_REF" > "$DIFF_FILE" 2>/dev/null || : > "$DIFF_FILE"
  git -C "$ROOT" diff --name-only "$BASE...$HEAD_REF" 2>/dev/null | sed '/^$/d' > "$CHANGED" || : > "$CHANGED"
  DIFF_SPEC="$BASE...$HEAD_REF"
else
  git -C "$ROOT" diff HEAD > "$DIFF_FILE" 2>/dev/null || : > "$DIFF_FILE"
  {
    git -C "$ROOT" diff --name-only HEAD 2>/dev/null
    git -C "$ROOT" ls-files --others --exclude-standard 2>/dev/null
  } | sed '/^$/d' | sort -u > "$CHANGED"
  DIFF_SPEC="HEAD..作業ツリー（未追跡ファイルを含む）"
fi

DIFF_BYTES="$(wc -c < "$DIFF_FILE" | tr -d ' ')"
DIFF_TRUNCATED=false
if [ "$DIFF_BYTES" -gt "$MAX_DIFF_BYTES" ]; then
  head -c "$MAX_DIFF_BYTES" "$DIFF_FILE" > "$TMP_DIR/diff.head"
  printf '\n…（diff はここで打ち切られました。全体 %s bytes のうち先頭 %s bytes のみ。触れたファイルの全文は artifact.files にあります）\n' \
    "$DIFF_BYTES" "$MAX_DIFF_BYTES" >> "$TMP_DIR/diff.head"
  mv "$TMP_DIR/diff.head" "$DIFF_FILE"
  DIFF_TRUNCATED=true
fi

# ---- diff が触れたファイルの全文 -------------------------------------------
#
# 中身は**作業ツリーから**読む（ref からは読まない）。レビュアに見せたいのは
# 「いま直そうとしている実物」だからである。--head に過去のコミットを渡した場合、
# diff と全文がずれ得ることは承知のうえでこの選択にしている。

FILES_JSON="$TMP_DIR/files.json"
echo "[]" > "$FILES_JSON"
TRUNCATED=0

append_file() {
  # $1 = リポジトリ相対パス, $2 = 役割（changed | imported）
  rel="$1"
  role="$2"
  abs="$ROOT/$rel"
  [ -f "$abs" ] || return 0
  # 既に入っていれば足さない
  if jq -e --arg p "$rel" 'any(.[]; .path == $p)' "$FILES_JSON" >/dev/null 2>&1; then
    return 0
  fi
  bytes="$(wc -c < "$abs" | tr -d ' ')"
  src="$abs"
  truncated=false
  if [ "$bytes" -gt "$MAX_FILE_BYTES" ]; then
    head -c "$MAX_FILE_BYTES" "$abs" > "$TMP_DIR/truncated.txt"
    src="$TMP_DIR/truncated.txt"
    truncated=true
    TRUNCATED=$((TRUNCATED + 1))
  fi
  jq --arg path "$rel" \
     --arg role "$role" \
     --argjson bytes "$bytes" \
     --argjson truncated "$truncated" \
     --rawfile content "$src" \
     '. + [{path: $path, role: $role, bytes: $bytes, truncated: $truncated, content: $content}]' \
     "$FILES_JSON" > "$TMP_DIR/files.next" && mv "$TMP_DIR/files.next" "$FILES_JSON"
}

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  append_file "$rel" "changed"
done < "$CHANGED"

# ---- import 先の自作モジュール ----------------------------------------------
#
# 対象は相対指定（./ ../）と `@/` エイリアス（= src/）のみ。node_modules の
# 依存は自作ではないので同梱しない（R-TH-10: 封筒を太らせない）。

resolve_spec() {
  # $1 = import 元のリポジトリ相対パス, $2 = 指定子。解決できたら相対パスを出す。
  from_rel="$1"
  spec="$2"
  case "$spec" in
    @/*) cand_base="src/${spec#@/}" ;;
    ./*|../*)
      from_dir="$(dirname "$from_rel")"
      cand_base="$(cd "$ROOT/$from_dir" 2>/dev/null && cd "$(dirname "$spec")" 2>/dev/null && pwd)/$(basename "$spec")"
      case "$cand_base" in
        "$ROOT"/*) cand_base="${cand_base#"$ROOT"/}" ;;
        *) return 0 ;;
      esac
      ;;
    *) return 0 ;;
  esac
  for ext in "" ".ts" ".tsx" ".mts" ".mjs" ".js" "/index.ts" "/index.tsx" "/index.mjs" "/index.js"; do
    if [ -f "$ROOT/${cand_base}${ext}" ]; then
      printf '%s\n' "${cand_base}${ext}"
      return 0
    fi
  done
  return 0
}

scan_imports() {
  # $1 = リポジトリ相対パス。import 指定子を 1 行 1 個で出す。
  rel="$1"
  abs="$ROOT/$rel"
  [ -f "$abs" ] || return 0
  case "$rel" in
    *.ts|*.tsx|*.mts|*.mjs|*.js|*.jsx) ;;
    *) return 0 ;;
  esac
  grep -oE "(from|import|require\()[[:space:]]*['\"][^'\"]+['\"]" "$abs" 2>/dev/null \
    | grep -oE "['\"][^'\"]+['\"]" \
    | tr -d "'\"" \
    | grep -E '^(\.{1,2}/|@/)' || true
}

frontier="$TMP_DIR/frontier.txt"
cp "$CHANGED" "$frontier"
depth=0
while [ "$depth" -lt "$IMPORT_DEPTH" ]; do
  next="$TMP_DIR/frontier.next"
  : > "$next"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    scan_imports "$rel" | while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      resolved="$(resolve_spec "$rel" "$spec")"
      [ -n "$resolved" ] && printf '%s\n' "$resolved" >> "$next"
    done
  done < "$frontier"
  sort -u "$next" -o "$next"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    append_file "$rel" "imported"
  done < "$next"
  mv "$next" "$frontier"
  depth=$((depth + 1))
done

# ---- constraint_ids に対応する制約だけを全文同梱（R-TH-10） -----------------

CONSTRAINT_IDS="$(printf '%s' "$TASK_JSON" | jq -c '.constraint_ids // []')"
if [ -f "$CONSTRAINTS" ]; then
  CONSTRAINTS_JSON="$(jq -c --argjson ids "$CONSTRAINT_IDS" \
    '[.constraints[] | select([.id] | inside($ids))]' "$CONSTRAINTS")"
else
  CONSTRAINTS_JSON="[]"
fi

WORDING_FORBIDDEN="[]"
if [ -f "$WORDING" ]; then
  WORDING_FORBIDDEN="$(sed -n '/<!-- machine-readable:begin -->/,/<!-- machine-readable:end -->/p' "$WORDING" \
    | sed -e '/^<!--/d' -e '/^```/d' \
    | jq -c '[.forbidden[]? | {id, patterns, reason}]' 2>/dev/null || echo "[]")"
fi

# ---- 封筒 -------------------------------------------------------------------

HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

PACKET="$TMP_DIR/packet.json"
jq -n \
  --argjson task "$TASK_JSON" \
  --argjson constraints "$CONSTRAINTS_JSON" \
  --argjson wording "$WORDING_FORBIDDEN" \
  --slurpfile files "$FILES_JSON" \
  --rawfile diff "$DIFF_FILE" \
  --arg diff_spec "$DIFF_SPEC" \
  --arg commit "$HEAD_SHA" \
  --arg built_at "$BUILT_AT" \
  --argjson import_depth "$IMPORT_DEPTH" \
  --argjson truncated_files "$TRUNCATED" \
  --argjson diff_truncated "$DIFF_TRUNCATED" \
  --argjson diff_bytes_total "$DIFF_BYTES" \
  '{
     schema_version: 1,
     kind: "review-packet",
     task_id: $task.task_id,
     built_at: $built_at,
     commit: $commit,
     task: {
       title: $task.title,
       goal: $task.goal,
       scope: ($task.scope // []),
       non_scope: ($task.non_scope // []),
       done_definition: ($task.done_definition // []),
       verify_commands: ($task.verify_commands // []),
       risk_level: $task.risk_level,
       risk_ids: ($task.risk_ids // []),
       constraint_ids: ($task.constraint_ids // [])
     },
     constraints: $constraints,
     wording_forbidden: $wording,
     artifact: {
       diff_spec: $diff_spec,
       diff: $diff,
       diff_truncated: $diff_truncated,
       diff_bytes_total: $diff_bytes_total,
       import_depth: $import_depth,
       truncated_files: $truncated_files,
       files: $files[0]
     },
     reply_format: {
       note: "返信は JSON オブジェクト 1 個だけを出力する。前後に説明文を付けない。",
       required: ["schema_version", "task_id", "reviewer", "vendor", "reviewer_route", "model_id_actual", "cli_version", "backend", "ran_at", "verdict", "findings"],
       reviewer_route: ["verified", "cli-fallback", "unavailable", "model_mismatch"],
       verdict: ["PASS", "FAIL", "BLOCKED", "UNKNOWN"],
       finding: {
         required: ["id", "severity", "title", "detail"],
         severity: ["high", "medium", "low", "info", "unknown"],
         rules: [
           "severity=high には repro（再現する具体的な入力列）が必須。repro の無い high は info へ機械的に降格される（R-TH-08）",
           "vendor=gemini の high / medium には citation（逐語引用 + URL + 取得日）が必須。無い指摘は unknown へ降格される",
           "artifact に無いコードについて指摘しない。担保箇所が同梱ファイルにあるなら指摘しない"
         ]
       }
     }
   }' > "$PACKET"

PAYLOAD_BYTES="$(wc -c < "$PACKET" | tr -d ' ')"
jq --argjson bytes "$PAYLOAD_BYTES" \
   --argjson constraints_included "$(printf '%s' "$CONSTRAINTS_JSON" | jq 'length')" \
   --argjson files_included "$(jq 'length' "$FILES_JSON")" \
   '. + {metrics: {payload_bytes: $bytes, constraints_included: $constraints_included, files_included: $files_included}}' \
   "$PACKET" > "$TMP_DIR/packet.final" && mv "$TMP_DIR/packet.final" "$PACKET"

if [ -n "$OUT" ]; then
  mkdir -p "$(dirname "$OUT")"
  cp "$PACKET" "$OUT"
  printf 'build-review-packet: %s（%s bytes / 制約 %s 件 / ファイル %s 本）\n' \
    "$OUT" "$PAYLOAD_BYTES" \
    "$(printf '%s' "$CONSTRAINTS_JSON" | jq 'length')" "$(jq 'length' "$FILES_JSON")" >&2
else
  cat "$PACKET"
fi

exit 0
