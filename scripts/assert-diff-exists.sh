#!/usr/bin/env bash
# scripts/assert-diff-exists.sh
#
# SubagentStop hook. Cross-checks a subagent's "done" against the repository:
# if a subagent reports completion while the working tree is clean and HEAD has
# not moved during this session, its report is not backed by a diff (F2 — the
# over-claimed completion).
#
# It reports rather than blocks. Read-only subagents (research, review,
# adversarial) legitimately finish with no diff, and a subagent that just
# committed through scripts/with-lock.sh git also leaves a clean tree — so a
# hard exit 2 here would fire mostly on correct behaviour. The authoritative
# checks on completion claims are elsewhere and do block: docs/run-log/ can
# only be written by scripts/record-run.sh, and CI re-runs every
# verify_commands (§15-1, task_009).
#
# The session baseline is recorded in .locks/subagent-head-baseline (gitignored
# along with the rest of .locks/) the first time this hook runs.
#
# Contract: always exits 0, printing a JSON systemMessage when the check is
# unsatisfied.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

cat >/dev/null 2>&1 || true

git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

BASELINE_DIR="$ROOT/.locks"
BASELINE="$BASELINE_DIR/subagent-head-baseline"
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

mkdir -p "$BASELINE_DIR" 2>/dev/null || exit 0
if [ ! -f "$BASELINE" ]; then
  printf '%s\n' "$HEAD_SHA" > "$BASELINE" 2>/dev/null || true
fi
BASE_SHA="$(cat "$BASELINE" 2>/dev/null || echo unknown)"

DIRTY_COUNT="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

if [ "${DIRTY_COUNT:-0}" = "0" ] && [ "$HEAD_SHA" = "$BASE_SHA" ]; then
  MSG="assert-diff-exists.sh: サブエージェントの終了時点で作業ツリーに差分が無く HEAD も動いていません（baseline=${BASE_SHA}）。調査・レビュー専従なら想定どおりです。実装を報告しているなら、その報告は diff で裏付けられていません（F2）"
  printf '{"systemMessage":%s}\n' "$(printf '%s' "$MSG" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "\"%s\"", $0}')"
fi

exit 0
