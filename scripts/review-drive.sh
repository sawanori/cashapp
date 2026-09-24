#!/usr/bin/env bash
# scripts/review-drive.sh — 敵対レビュー記録（G5）を実経路で作るための一括ドライバ。
#
#   閲覧用コミットの作成 → build-review-packet → review-gemini（gemini-safe.sh 経由）→ review-gpt
#
# merge（docs/review-log/<task_id>.json への追記・判定）は呼び出し側が本リポジトリで行う:
#   bash scripts/merge-review.sh <task_id> <out>/gemini.json <out>/gpt.json
#
# なぜ閲覧用コミットが要るか: 並行タスクのコミットが交互に入るため、`--base <最初の自コミットの親>
# --head <最終の自コミット>` の 3 点ドット差分には他タスクの変更が混ざる（実測: task_005 は 38 ファイル
# 中 18 が他タスク）。そこで <最終コミット> の木から「subject に task_<T> を含むコミットが触っていない
# ファイル」を <親> の版に戻した閲覧用コミットを積み、それを head にする。閲覧用コミットは main には
# 載せず refs/review-view/<task_id> で辿れるようにする（review-log の commit 欄はこの SHA になる）。
#
# 使い方:
#   scripts/review-drive.sh <task_id> <最初の自コミット> <最終の自コミット> [追加で含めるコミット...]
#   環境変数: EXCLUDE_COMMITS="<sha> ..." そのコミットが触ったファイルを対象から外す（他タスクの
#             成果物が巻き込まれたコミットを含めるときに使う）
#             PACKET_FILE_MAX / PACKET_DIFF_MAX / PACKET_IMPORT_DEPTH  封筒の上限（既定 40000 / 70000 / 1）
#             REVIEW_OUT  出力先（既定 ${TMPDIR:-/tmp}/cashapp-review/<task_id>）
# 終了コード: 0 = gemini / gpt の封筒を出した（票の成否は封筒を見る）/ 64 = usage / 65 = 準備失敗
set -uo pipefail
[ "$#" -ge 3 ] || { echo "usage: $0 <task_id> <first-own-commit> <last-own-commit> [extra-commit...]" >&2; exit 64; }
TID="$1"; C1="$2"; CN="$3"; shift 3
case "$TID" in task_*) ;; *) echo "task_id は task_NNN の形で渡す" >&2; exit 64 ;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
OUT="${REVIEW_OUT:-${TMPDIR:-/tmp}/cashapp-review/$TID}"
mkdir -p "$OUT"
LOG="$OUT/drive.log"; : > "$LOG"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
say "[$(date -u +%FT%TZ)] $TID C1=$C1 CN=$CN extra=$*"

cd "$REPO" || exit 65
B="$(git rev-parse "${C1}^")" || exit 65
WT="$OUT/wt"
if [ ! -d "$WT" ]; then
  git worktree add --detach "$WT" "$CN" >>"$LOG" 2>&1 || { say "worktree add failed"; exit 65; }
fi

{
  git log --format= --name-only --grep="$TID" "$B..$CN"
  for c in "$@"; do git show --format= --name-only "$c"; done
} | sed '/^$/d' | sort -u > "$OUT/task-files.raw"
: > "$OUT/exclude-files.txt"
for c in ${EXCLUDE_COMMITS:-}; do git show --format= --name-only "$c"; done | sed '/^$/d' | sort -u > "$OUT/exclude-files.txt"
comm -23 "$OUT/task-files.raw" "$OUT/exclude-files.txt" > "$OUT/task-files.txt"
git diff --name-only "$B" "$CN" | sort -u > "$OUT/all-files.txt"
comm -23 "$OUT/all-files.txt" "$OUT/task-files.txt" > "$OUT/other-files.txt"
say "task files: $(wc -l < "$OUT/task-files.txt" | tr -d ' ') / all changed: $(wc -l < "$OUT/all-files.txt" | tr -d ' ') / reverted to base: $(wc -l < "$OUT/other-files.txt" | tr -d ' ')"

if [ "$(git -C "$WT" rev-parse HEAD)" = "$(git rev-parse "$CN")" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if git cat-file -e "$B:$f" 2>/dev/null; then
      git -C "$WT" checkout -q "$B" -- "$f"
    else
      git -C "$WT" rm -q -f -- "$f" 2>/dev/null || true
    fi
  done < "$OUT/other-files.txt"
  git -C "$WT" -c user.name=review-view -c user.email=review-view@local \
    commit -q --allow-empty -m "review-view($TID): $CN の木から $TID 以外の変更を $B の版に戻した閲覧用コミット（main には載せない）"
fi
SV="$(git -C "$WT" rev-parse HEAD)"
git update-ref "refs/review-view/$TID" "$SV"
say "base=$B head(view)=$SV"

bash "$REPO/scripts/build-review-packet.sh" "$TID" --root "$WT" --base "$B" --head "$SV" \
  --max-file-bytes "${PACKET_FILE_MAX:-40000}" --max-diff-bytes "${PACKET_DIFF_MAX:-70000}" \
  --import-depth "${PACKET_IMPORT_DEPTH:-1}" --out "$OUT/packet.json" >>"$LOG" 2>&1 || { say "packet FAIL"; exit 65; }
say "packet bytes: $(wc -c < "$OUT/packet.json" | tr -d ' ')"

# gemini CLI は cwd を走査対象にするので空ディレクトリで走らせる。@/ 記法は gemini-safe.sh が無害化する。
EMPTY="$OUT/empty-cwd"; mkdir -p "$EMPTY"
( cd "$EMPTY" && node "$REPO/scripts/review-gemini.mjs" --packet "$OUT/packet.json" --out "$OUT/gemini.json" \
    --timeout-ms 900000 --cli "$REPO/scripts/gemini-safe.sh" ) >>"$LOG" 2>&1
say "gemini exit=$?"
# GPT-6 Astra は codex exec で 10 分以上かかる（実測 2026-09-24: 225KB の封筒で 680 秒）。
node "$REPO/scripts/review-gpt.mjs" --packet "$OUT/packet.json" --out "$OUT/gpt.json" --timeout-ms 1500000 >>"$LOG" 2>&1
say "gpt exit=$?"
say "[$(date -u +%FT%TZ)] done → merge: bash scripts/merge-review.sh $TID $OUT/gemini.json $OUT/gpt.json"
exit 0
