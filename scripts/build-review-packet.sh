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
# ## 作者の自己申告は「レビュー対象」から外す（3 周ループの構造的な原因）
#
# `docs/concerns/<task_id>.md` / `docs/HANDOFF.md` / `docs/PROGRESS.md` は、作者が
# 自分で書いた**既知の懸念の台帳**である。これを diff と同じ扱いで同梱すると、
# レビュアは台帳に書いてある懸念をそのまま読み上げて high の finding にできる。
# 懸念を誠実に記録するほど台帳が厚くなり、周回を重ねるほど差し戻しやすくなるので、
# task-loop が収束しない [実測 2026-09-24 / task_007 round 3: 3 件の finding が
# すべて docs/concerns/task_007.md の既存項目と 1 対 1 対応していた]。
#
# そこでこれらのパスは `artifact.diff` / `artifact.files`（＝レビュー対象）から外し、
# **全文を `self_declared_concerns` として別枠で渡す**。隠すのではない。外した事実は
# `artifact.excluded_paths` に理由つきで書き、中身も全部見せたうえで
# 「既に自己申告されている事項は新規 finding にせず `duplicate_of` で参照せよ」と
# `reply_format` で指示する。
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

# 自己申告の台帳。diff からは外し（下の pathspec）、全文は別枠で渡す。
# --name-only 側は**外さない**。外したファイルを self_declared_concerns として
# 拾い直すために、触れたファイルの一覧は完全なままでなければならない。
SELF_DECLARED_EXCLUDE=(':(exclude)docs/concerns' ':(exclude)docs/HANDOFF.md' ':(exclude)docs/PROGRESS.md')

is_self_declared() {
  case "$1" in
    docs/concerns/*|docs/HANDOFF.md|docs/PROGRESS.md) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "$BASE" ]; then
  git -C "$ROOT" diff "$BASE...$HEAD_REF" -- . "${SELF_DECLARED_EXCLUDE[@]}" > "$DIFF_FILE" 2>/dev/null || : > "$DIFF_FILE"
  git -C "$ROOT" diff --name-only "$BASE...$HEAD_REF" 2>/dev/null | sed '/^$/d' > "$CHANGED" || : > "$CHANGED"
  DIFF_SPEC="$BASE...$HEAD_REF"
else
  git -C "$ROOT" diff HEAD -- . "${SELF_DECLARED_EXCLUDE[@]}" > "$DIFF_FILE" 2>/dev/null || : > "$DIFF_FILE"
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
SELF_JSON="$TMP_DIR/self-declared.json"
EXCLUDED_JSON="$TMP_DIR/excluded.json"
echo "[]" > "$FILES_JSON"
echo "[]" > "$SELF_JSON"
echo "[]" > "$EXCLUDED_JSON"
TRUNCATED=0

append_file() {
  # $1 = リポジトリ相対パス, $2 = 役割（changed | imported）
  #
  # 自己申告の台帳（docs/concerns/** / docs/HANDOFF.md / docs/PROGRESS.md）は
  # artifact.files に入れない。**中身も同梱しない**。理由は 2 つある。
  #   * レビュアが台帳の既知懸念を読み上げて high にする経路を断つため
  #   * R-TH-10 — この 3 種は最も厚くなるファイル群で、実測 docs/HANDOFF.md 199KB /
  #     docs/PROGRESS.md 72KB。封筒が大きいほどレビューは返ってこない
  # 存在は隠さない。パスと大きさを artifact.excluded_paths と
  # self_declared_concerns.files に書き、外した理由も添える。
  rel="$1"
  role="$2"
  abs="$ROOT/$rel"
  [ -f "$abs" ] || return 0

  # 既に入っていれば足さない（レビュー対象側・自己申告側のどちらでも）
  if jq -e --arg p "$rel" 'any(.[]; .path == $p)' "$FILES_JSON" >/dev/null 2>&1; then
    return 0
  fi
  if jq -e --arg p "$rel" 'any(.[]; .path == $p)' "$SELF_JSON" >/dev/null 2>&1; then
    return 0
  fi

  bytes="$(wc -c < "$abs" | tr -d ' ')"

  if is_self_declared "$rel"; then
    jq --arg path "$rel" --argjson bytes "$bytes" \
       '. + [{path: $path, role: "self_declared_concerns", bytes: $bytes, content_included: false}]' \
       "$SELF_JSON" > "$TMP_DIR/files.next" && mv "$TMP_DIR/files.next" "$SELF_JSON"
    jq --arg path "$rel" --argjson bytes "$bytes" \
       '. + [{path: $path, bytes: $bytes, reason: "self_declared_concerns", note: "作者が書いた既知の懸念・進捗の台帳。レビュー対象（diff と全文）から外した。ここに書かれている事項は作者が把握済みであり、この周回の指摘対象ではない"}]' \
       "$EXCLUDED_JSON" > "$TMP_DIR/excluded.next" && mv "$TMP_DIR/excluded.next" "$EXCLUDED_JSON"
    return 0
  fi

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
#
# 突合は **完全一致** でなければならない。以前ここは `select([.id] | inside($ids))`
# だったが、jq の `inside` は配列要素どうしを「部分文字列として含むか」で比べるため、
# `constraint_ids: ["L11"]` が `L1` も引き当てていた（`N1`/`N11`、`W1`/`W12` も同様）。
# 接頭辞が衝突する ID が同梱され、封筒が「このタスクに掛かっていない制約」を
# レビュアに見せてしまう（R-TH-10 の「constraint_ids に載っている制約だけ」に反する）。

CONSTRAINT_IDS="$(printf '%s' "$TASK_JSON" | jq -c '.constraint_ids // []')"
if [ -f "$CONSTRAINTS" ]; then
  CONSTRAINTS_JSON="$(jq -c --argjson ids "$CONSTRAINT_IDS" \
    '[.constraints[] | select(.id as $i | ($ids | index($i)) != null)]' "$CONSTRAINTS")"
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
  --slurpfile self_declared "$SELF_JSON" \
  --slurpfile excluded "$EXCLUDED_JSON" \
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
       files: $files[0],
       excluded_paths: $excluded[0]
     },
     self_declared_concerns: {
       note: "作者自身が書いた既知の懸念・進捗の台帳。レビュー対象（artifact.diff / artifact.files）から外してあり、中身も同梱していない（R-TH-10: 封筒が大きいとレビューが返らない）。存在は隠していない。これらの事項は作者が把握済みなので、この周回の指摘対象ではない。指摘は artifact.diff と artifact.files から出すこと。",
       content_included: false,
       files: $self_declared[0]
     },
     reply_format: {
       note: "返信は JSON オブジェクト 1 個だけを出力する。前後に説明文を付けない。",
       required: ["schema_version", "task_id", "reviewer", "vendor", "reviewer_route", "model_id_actual", "cli_version", "backend", "ran_at", "verdict", "findings"],
       reviewer_route: ["verified", "cli-fallback", "unavailable", "model_mismatch"],
       verdict: ["PASS", "FAIL", "BLOCKED", "UNKNOWN"],
       finding: {
         required: ["id", "severity", "title", "detail"],
         optional: ["repro", "citation", "file", "line", "suggested_fix", "duplicate_of"],
         severity: ["high", "medium", "low", "info", "unknown"],
         rules: [
           "severity=high には repro（再現する具体的な入力列）が必須。repro の無い high は info へ機械的に降格される（R-TH-08）",
           "vendor=gemini の high / medium には citation（逐語引用 + URL + 取得日）が必須。無い指摘は unknown へ降格される",
           "artifact に無いコードについて指摘しない。担保箇所が同梱ファイルにあるなら指摘しない",
           "self_declared_concerns に挙がっているファイル（作者の懸念・進捗の台帳）は指摘の対象ではない。中身は同梱していないので、そこに書かれていそうな内容を推測して finding にしない。既知事項の再掲が必要なときは severity: \"info\" とし duplicate_of にその根拠（ファイルと見出し）を書く",
           "指摘は artifact.diff と artifact.files（＝この周回のレビュー対象）から出す。artifact.excluded_paths のファイルは対象外である"
         ]
       }
     }
   }' > "$PACKET"

PAYLOAD_BYTES="$(wc -c < "$PACKET" | tr -d ' ')"
jq --argjson bytes "$PAYLOAD_BYTES" \
   --argjson constraints_included "$(printf '%s' "$CONSTRAINTS_JSON" | jq 'length')" \
   --argjson files_included "$(jq 'length' "$FILES_JSON")" \
   --argjson self_declared_files "$(jq 'length' "$SELF_JSON")" \
   '. + {metrics: {payload_bytes: $bytes, constraints_included: $constraints_included, files_included: $files_included, self_declared_files: $self_declared_files}}' \
   "$PACKET" > "$TMP_DIR/packet.final" && mv "$TMP_DIR/packet.final" "$PACKET"

if [ -n "$OUT" ]; then
  mkdir -p "$(dirname "$OUT")"
  cp "$PACKET" "$OUT"
  printf 'build-review-packet: %s（%s bytes / 制約 %s 件 / ファイル %s 本 / 自己申告 %s 本）\n' \
    "$OUT" "$PAYLOAD_BYTES" \
    "$(printf '%s' "$CONSTRAINTS_JSON" | jq 'length')" "$(jq 'length' "$FILES_JSON")" \
    "$(jq 'length' "$SELF_JSON")" >&2
else
  cat "$PACKET"
fi

exit 0
