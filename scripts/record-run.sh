#!/usr/bin/env bash
# scripts/record-run.sh
#
# The ONLY sanctioned way to write to docs/run-log/<task_id>.json (R-TH-02).
# Actually runs the given command (no re-interpretation through a shell string,
# so quoting/argv is preserved exactly), captures its real exit code and the
# last 40 lines of combined stdout/stderr, and appends one record to the
# task's run-log array. Also supports --manual for human-observed checks that
# have no automatable command.
#
# Usage:
#   scripts/record-run.sh <task_id> <command...>
#   scripts/record-run.sh --manual <task_id> "<observation>"
#
# Dependencies: git, date, jq (nothing else).
#
# Exit code: for a command run, this script exits with the *command's* exit
# code so callers can chain `scripts/record-run.sh task_x npm run build || ...`.
# For --manual it exits 0 once the record is written.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/record-run.sh <task_id> <command...>
  scripts/record-run.sh --manual <task_id> "<observation>"
EOF
  exit 64
}

for bin in jq git date mktemp; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "record-run.sh: missing required dependency: $bin" >&2
    exit 69
  }
done

if [ "$#" -lt 1 ]; then
  usage
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "record-run.sh: not inside a git repository" >&2
  exit 1
}

RUN_LOG_DIR="$REPO_ROOT/docs/run-log"
LOCK_ROOT="$REPO_ROOT/.locks/run-log"
mkdir -p "$RUN_LOG_DIR" "$LOCK_ROOT"

BY="${RECORD_RUN_BY:-$(whoami 2>/dev/null || echo unknown)@$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)}"

MODE="command"
if [ "$1" = "--manual" ]; then
  MODE="manual"
  shift
  [ "$#" -ge 2 ] || usage
  TASK_ID="$1"
  shift
  OBSERVATION="$*"
else
  TASK_ID="$1"
  shift
  [ "$#" -ge 1 ] || usage
fi

case "$TASK_ID" in
  *[!A-Za-z0-9_.-]*|"")
    echo "record-run.sh: invalid task_id: '$TASK_ID'" >&2
    exit 64
    ;;
esac

LOG_FILE="$RUN_LOG_DIR/${TASK_ID}.json"
LOCK_DIR="$LOCK_ROOT/${TASK_ID}.lock"
TMP_OUT=""
TMP_JSON=""

cleanup() {
  [ -n "$TMP_OUT" ] && rm -f "$TMP_OUT"
  [ -n "$TMP_JSON" ] && rm -f "$TMP_JSON"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Exclusive per-task_id lock so two concurrent record-run.sh calls for the
# same task never interleave their read-modify-write of the JSON array.
LOCK_WAIT_MAX=1800 # seconds, matches with-lock.sh's 30 min budget
lock_start=$SECONDS
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if [ $((SECONDS - lock_start)) -ge "$LOCK_WAIT_MAX" ]; then
    echo "record-run.sh: timed out waiting for run-log lock: $TASK_ID" >&2
    exit 75
  fi
  sleep 0.2
done

RAN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")"

if [ ! -f "$LOG_FILE" ]; then
  echo "[]" > "$LOG_FILE"
fi

EXIT_CODE=0

if [ "$MODE" = "manual" ]; then
  ENTRY="$(jq -n \
    --arg type "manual" \
    --arg observation "$OBSERVATION" \
    --arg commit "$COMMIT" \
    --arg ran_at "$RAN_AT" \
    --arg by "$BY" \
    '{type: $type, observation: $observation, commit: $commit, ran_at: $ran_at, by: $by}')"
else
  CMD_STR="$*"
  TMP_OUT="$(mktemp)"
  set +e
  "$@" >"$TMP_OUT" 2>&1
  EXIT_CODE=$?
  set -e
  # Echo the full captured output back so the caller/report sees it in full,
  # not just the 40-line tail that gets persisted.
  cat "$TMP_OUT"
  STDOUT_TAIL="$(tail -n 40 "$TMP_OUT")"
  ENTRY="$(jq -n \
    --arg type "command" \
    --arg command "$CMD_STR" \
    --argjson exit_code "$EXIT_CODE" \
    --arg stdout_tail "$STDOUT_TAIL" \
    --arg commit "$COMMIT" \
    --arg ran_at "$RAN_AT" \
    --arg by "$BY" \
    '{type: $type, command: $command, exit_code: $exit_code, stdout_tail: $stdout_tail, commit: $commit, ran_at: $ran_at, by: $by}')"
fi

TMP_JSON="$(mktemp)"
jq --argjson entry "$ENTRY" '. + [$entry]' "$LOG_FILE" > "$TMP_JSON"
mv "$TMP_JSON" "$LOG_FILE"
TMP_JSON=""

exit "$EXIT_CODE"
