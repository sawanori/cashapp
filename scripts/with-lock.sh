#!/usr/bin/env bash
# scripts/with-lock.sh
#
# Exclusive lock for operations that must not run concurrently across
# parallel task agents: dependency installs (npm), git operations, and
# database / integration test runs (db). Backed by mkdir, which is atomic
# on every POSIX filesystem this repo runs on.
#
# Usage:
#   scripts/with-lock.sh <name> <command...>
#
# <name> is the lock bucket, e.g. npm / git / db. Any command may be run
# under it; the convention in this repo is:
#   scripts/with-lock.sh npm npm install <pkg>
#   scripts/with-lock.sh git git commit -m "..."
#   scripts/with-lock.sh db  supabase start
#
# Waits up to 30 minutes (mkdir retry every 0.2s) for the lock to become
# free, then runs the command, then always releases the lock (even on
# failure or signal). Exits with the wrapped command's exit code.

set -euo pipefail

usage() {
  echo "Usage: scripts/with-lock.sh <name> <command...>" >&2
  exit 64
}

command -v git >/dev/null 2>&1 || {
  echo "with-lock.sh: missing required dependency: git" >&2
  exit 69
}

[ "$#" -ge 2 ] || usage

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "with-lock.sh: not inside a git repository" >&2
  exit 1
}

NAME="$1"
shift

case "$NAME" in
  *[!A-Za-z0-9_.-]*|"")
    echo "with-lock.sh: invalid lock name: '$NAME'" >&2
    exit 64
    ;;
esac

LOCKS_ROOT="$REPO_ROOT/.locks"
LOCK_DIR="$LOCKS_ROOT/$NAME"
mkdir -p "$LOCKS_ROOT"

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

LOCK_WAIT_MAX=1800 # 30 minutes
lock_start=$SECONDS
waited_notice=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  elapsed=$((SECONDS - lock_start))
  if [ "$elapsed" -ge "$LOCK_WAIT_MAX" ]; then
    echo "with-lock.sh: timed out after ${LOCK_WAIT_MAX}s waiting for lock '$NAME' (held by another task)" >&2
    exit 75
  fi
  if [ "$elapsed" -ge $((waited_notice + 30)) ]; then
    echo "with-lock.sh: waiting for lock '$NAME' (${elapsed}s elapsed)..." >&2
    waited_notice=$elapsed
  fi
  sleep 0.2
done

set +e
"$@"
exit_code=$?
set -e
exit "$exit_code"
