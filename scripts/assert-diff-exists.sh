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
# The baseline lives in .locks/subagent-head-baseline-<session_id> (gitignored
# along with the rest of .locks/), keyed by the session_id on the hook input so
# it is scoped to one session, and it is rewritten to the current HEAD after
# every evaluation. Both matter: an unkeyed, write-once baseline went stale the
# moment HEAD moved past it, after which `HEAD_SHA = BASE_SHA` was false forever
# and this check never fired again. With the rewrite, each subagent is compared
# against the repository state left by the previous one, so "this subagent
# produced nothing" is what is actually measured.
#
# When the input carries no session_id (manual invocation, or a client that
# omits it), the unkeyed file is used as a fallback — still rewritten each run.
#
# Contract: always exits 0, printing a JSON systemMessage when the check is
# unsatisfied.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

INPUT="$(cat 2>/dev/null || true)"

git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

SESSION_ID=""
if [ -n "$INPUT" ] && command -v jq >/dev/null 2>&1; then
  SESSION_ID="$(printf '%s' "$INPUT" \
    | jq -r 'if type == "object" then (.session_id // "") else "" end' 2>/dev/null || true)"
fi
# Keep only characters that are safe in a file name, and bound the length.
SESSION_ID="$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-64)"

BASELINE_DIR="$ROOT/.locks"
if [ -n "$SESSION_ID" ]; then
  BASELINE="$BASELINE_DIR/subagent-head-baseline-$SESSION_ID"
else
  BASELINE="$BASELINE_DIR/subagent-head-baseline"
fi
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

mkdir -p "$BASELINE_DIR" 2>/dev/null || exit 0
BASE_SHA="$(cat "$BASELINE" 2>/dev/null || printf '%s' "$HEAD_SHA")"

DIRTY_COUNT="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

if [ "${DIRTY_COUNT:-0}" = "0" ] && [ "$HEAD_SHA" = "$BASE_SHA" ]; then
  MSG="assert-diff-exists.sh: サブエージェントの終了時点で作業ツリーに差分が無く HEAD も動いていません（baseline=${BASE_SHA}）。調査・レビュー専従なら想定どおりです。実装を報告しているなら、その報告は diff で裏付けられていません（F2）"
  printf '{"systemMessage":%s}\n' "$(printf '%s' "$MSG" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "\"%s\"", $0}')"
fi

# Always move the baseline forward so the next subagent is measured against the
# state this one left behind.
printf '%s\n' "$HEAD_SHA" > "$BASELINE" 2>/dev/null || true

exit 0
