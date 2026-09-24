#!/usr/bin/env bash
# scripts/gate-constraints.sh
#
# Machine-checks the design constraints declared in docs/constraints.json.
#
# Two failure modes, both exit 1:
#   1. A forbidden pattern matched (or a required pattern was missing).
#      Printed as: "<id> <file>:<line>"
#   2. A gate scanned ZERO files. A gate that has nothing to look at is not a
#      passing gate — it is a silently disabled one (R-TH-01). Entries whose
#      `expect_targets` is "now" must have at least one target file today.
#      Entries whose `expect_targets` is "from_task_XXX" are allowed to have
#      zero targets until that task is DONE, and fail once it is.
#
# Exit codes:
#   0  no violations, every gate had something to scan (or was legitimately deferred)
#   1  at least one violation, or an empty-target gate that is no longer deferred
#   2  usage / configuration error (bad JSON, unsupported glob, missing field)
#
# Compatible with bash 3.2 (macOS system bash): no globstar, no mapfile,
# no associative arrays. External dependencies: git, jq, grep, sed, awk, xargs.
#
# Usage:
#   scripts/gate-constraints.sh [--root <dir>] [--constraints <file>]
#                               [--task-list <file>] [--run-log-dir <dir>]
#                               [--quiet]

set -uo pipefail

usage() {
  sed -n '2,25p' "$0" >&2
  exit 2
}

for bin in jq grep sed awk xargs; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "gate-constraints.sh: missing required dependency: $bin" >&2
    exit 2
  }
done

ROOT=""
CONSTRAINTS=""
TASK_LIST=""
RUN_LOG_DIR=""
QUIET=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --constraints) CONSTRAINTS="${2:-}"; shift 2 ;;
    --task-list) TASK_LIST="${2:-}"; shift 2 ;;
    --run-log-dir) RUN_LOG_DIR="${2:-}"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage ;;
    *) echo "gate-constraints.sh: unknown argument: $1" >&2; usage ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "gate-constraints.sh: not inside a git repository and --root not given" >&2
    exit 2
  }
fi
[ -d "$ROOT" ] || { echo "gate-constraints.sh: no such directory: $ROOT" >&2; exit 2; }

[ -n "$CONSTRAINTS" ] || CONSTRAINTS="$ROOT/docs/constraints.json"
[ -n "$TASK_LIST" ]   || TASK_LIST="$ROOT/docs/task-list.json"
[ -n "$RUN_LOG_DIR" ] || RUN_LOG_DIR="$ROOT/docs/run-log"

[ -f "$CONSTRAINTS" ] || { echo "gate-constraints.sh: constraints file not found: $CONSTRAINTS" >&2; exit 2; }
jq -e . "$CONSTRAINTS" >/dev/null 2>&1 || { echo "gate-constraints.sh: not valid JSON: $CONSTRAINTS" >&2; exit 2; }

TMPDIR_GATE="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_GATE"; }
trap cleanup EXIT

FILE_LIST="$TMPDIR_GATE/files.txt"
TARGETS="$TMPDIR_GATE/targets.txt"
HITS="$TMPDIR_GATE/hits.txt"

# ---------------------------------------------------------------- file universe
if [ -d "$ROOT/.git" ]; then
  # Tracked + untracked-but-not-ignored. Keeps node_modules/.next/.open-next
  # out of the scan without hardcoding them here.
  git -C "$ROOT" ls-files -co --exclude-standard | LC_ALL=C sort -u > "$FILE_LIST"
else
  ( cd "$ROOT" && find . -type f \
      -not -path './.git/*' -not -path './node_modules/*' \
      -not -path './.next/*' -not -path './.open-next/*' -not -path './.wrangler/*' \
      | sed 's|^\./||' | LC_ALL=C sort -u ) > "$FILE_LIST"
fi

# --------------------------------------------------------------- glob -> regex
# Supported glob subset (documented in docs/constraints.json notes):
#   **/   zero or more directories
#   **    any depth, trailing
#   *     any run of characters that does not cross a "/"
#   ?     one character that is not "/"
#   {a,b} alternation
GLOB_ERR=""
glob_to_regex() {
  local g="$1"
  GLOB_ERR=""
  case "$g" in
    "" ) GLOB_ERR="empty glob"; return 1 ;;
    *[!A-Za-z0-9_./*?{},-]* ) GLOB_ERR="unsupported character in glob: $g"; return 1 ;;
  esac
  g="${g//./\\.}"
  case "$g" in
    *'{'*)
      g="${g//,/|}"
      g="${g//\{/(}"
      g="${g//\}/)}"
      ;;
  esac
  g="${g//\*\*\//$'\001'}"
  g="${g//\*\*/$'\002'}"
  g="${g//\*/[^\/]*}"
  g="${g//\?/[^\/]}"
  g="${g//$'\001'/(.*\/)?}"
  g="${g//$'\002'/.*}"
  printf '%s' "$g"
}

# Joins the globs on stdin into one anchored alternation regex on stdout.
# Returns 1 (and sets GLOB_ERR) if any glob is unsupported.
globs_to_regex() {
  local out="" g re
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    re="$(glob_to_regex "$g")" || return 1
    if [ -z "$out" ]; then out="$re"; else out="$out|$re"; fi
  done
  [ -n "$out" ] || return 2
  printf '^(%s)$' "$out"
}

# ------------------------------------------------------- global exclude regex
GLOBAL_EXCLUDE_RE=""
if jq -e '.global_exclude_globs | length > 0' "$CONSTRAINTS" >/dev/null 2>&1; then
  GLOBAL_EXCLUDE_RE="$(jq -r '.global_exclude_globs[]' "$CONSTRAINTS" | globs_to_regex)" || {
    echo "gate-constraints.sh: ${GLOB_ERR:-bad global_exclude_globs}" >&2
    exit 2
  }
fi

# ---------------------------------------------------------------- DONE lookup
# A task counts as DONE only when BOTH signals agree: task-list.json says
# DONE / DONE_WITH_CONCERNS, and docs/run-log/<task_id>.json exists.
task_is_done() {
  local task_id="$1" status=""
  [ -f "$RUN_LOG_DIR/${task_id}.json" ] || return 1
  [ -f "$TASK_LIST" ] || return 1
  status="$(jq -r --arg t "$task_id" \
    '[.tasks[]? | select(.task_id == $t) | .completion_status] | first // ""' \
    "$TASK_LIST" 2>/dev/null)" || return 1
  case "$status" in
    DONE|DONE_WITH_CONCERNS) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------- state
violations=0
empty_gates=0
scanned_entries=0
config_errors=0

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }

ENTRIES="$TMPDIR_GATE/entries.jsonl"
jq -c '((.constraints // []) + (.gate_only_checks // []))[]' "$CONSTRAINTS" > "$ENTRIES" || {
  echo "gate-constraints.sh: could not read constraints/gate_only_checks arrays" >&2
  exit 2
}

# Structural validation: every entry must carry the fields the gate relies on.
while IFS= read -r entry; do
  missing="$(printf '%s' "$entry" | jq -r '
    [ (if has("id") then empty else "id" end),
      (if has("text") then empty else "text" end),
      (if has("confidence") then empty else "confidence" end),
      (if has("source") then empty else "source" end),
      (if has("enforcement") then empty else "enforcement" end),
      (if has("expect_targets") then empty else "expect_targets" end) ] | join(",")')"
  if [ -n "$missing" ]; then
    eid="$(printf '%s' "$entry" | jq -r '.id // "<no id>"')"
    echo "CONFIG $eid: missing required field(s): $missing" >&2
    config_errors=$((config_errors + 1))
  fi
done < "$ENTRIES"

if [ "$config_errors" -gt 0 ]; then
  echo "gate-constraints.sh: $config_errors entr(y|ies) are structurally invalid" >&2
  exit 2
fi

# ------------------------------------------------------------------ main loop
while IFS= read -r entry; do
  enforcement="$(printf '%s' "$entry" | jq -r '.enforcement')"
  [ "$enforcement" = "grep" ] || continue

  id="$(printf '%s' "$entry" | jq -r '.id')"
  mode="$(printf '%s' "$entry" | jq -r '.match_mode // "forbid"')"
  expect="$(printf '%s' "$entry" | jq -r '.expect_targets')"

  case "$mode" in
    forbid|require) ;;
    *) echo "CONFIG $id: unsupported match_mode: $mode" >&2; exit 2 ;;
  esac

  if ! printf '%s' "$entry" | jq -e '(.grep_patterns // []) | length > 0' >/dev/null; then
    echo "CONFIG $id: enforcement=grep but grep_patterns is empty" >&2
    exit 2
  fi

  include_re="$(printf '%s' "$entry" | jq -r '.globs[]?' | globs_to_regex)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "CONFIG $id: ${GLOB_ERR:-enforcement=grep but globs is empty}" >&2
    exit 2
  fi

  exclude_re=""
  if printf '%s' "$entry" | jq -e '(.exclude_globs // []) | length > 0' >/dev/null; then
    exclude_re="$(printf '%s' "$entry" | jq -r '.exclude_globs[]' | globs_to_regex)" || {
      echo "CONFIG $id: ${GLOB_ERR:-bad exclude_globs}" >&2
      exit 2
    }
  fi

  grep -E -- "$include_re" "$FILE_LIST" > "$TARGETS.raw" 2>/dev/null
  if [ -n "$GLOBAL_EXCLUDE_RE" ]; then
    grep -Ev -- "$GLOBAL_EXCLUDE_RE" "$TARGETS.raw" > "$TARGETS.g" 2>/dev/null
  else
    cp "$TARGETS.raw" "$TARGETS.g"
  fi
  if [ -n "$exclude_re" ]; then
    grep -Ev -- "$exclude_re" "$TARGETS.g" > "$TARGETS" 2>/dev/null
  else
    cp "$TARGETS.g" "$TARGETS"
  fi

  target_count="$(grep -c . "$TARGETS" 2>/dev/null || true)"
  [ -n "$target_count" ] || target_count=0

  # ---- empty-target policy (a gate with nothing to scan never "passes")
  if [ "$target_count" -eq 0 ]; then
    case "$expect" in
      now)
        echo "EMPTY $id: expect_targets=now but 0 files matched $(printf '%s' "$entry" | jq -c '.globs')" >&2
        empty_gates=$((empty_gates + 1))
        ;;
      from_task_*)
        dep="${expect#from_}"
        if task_is_done "$dep"; then
          echo "EMPTY $id: expect_targets=$expect and $dep is DONE, but 0 files matched $(printf '%s' "$entry" | jq -c '.globs')" >&2
          empty_gates=$((empty_gates + 1))
        else
          say "defer $id (0 targets; waiting on $dep)"
        fi
        ;;
      *)
        echo "CONFIG $id: unsupported expect_targets: $expect" >&2
        exit 2
        ;;
    esac
    continue
  fi

  scanned_entries=$((scanned_entries + 1))

  # ---- allow_if_line_matches
  allow_re=""
  if printf '%s' "$entry" | jq -e '(.allow_if_line_matches // []) | length > 0' >/dev/null; then
    allow_re="$(printf '%s' "$entry" | jq -r '.allow_if_line_matches[]' | awk 'BEGIN{ORS=""} NR==1{print $0; next} {print "|" $0}')"
  fi

  entry_hits=0

  if [ "$mode" = "forbid" ]; then
    while IFS= read -r pat; do
      [ -n "$pat" ] || continue
      : > "$HITS"
      tr '\n' '\0' < "$TARGETS" | ( cd "$ROOT" && xargs -0 grep -nHE -e "$pat" -- ) > "$HITS" 2>/dev/null
      while IFS= read -r hit; do
        [ -n "$hit" ] || continue
        file="${hit%%:*}"
        rest="${hit#*:}"
        line="${rest%%:*}"
        content="${rest#*:}"
        if [ -n "$allow_re" ] && printf '%s' "$content" | grep -qE -- "$allow_re"; then
          continue
        fi
        printf '%s %s:%s | %s\n' "$id" "$file" "$line" "$(printf '%s' "$content" | sed 's/^[[:space:]]*//' | cut -c1-120)"
        entry_hits=$((entry_hits + 1))
      done < "$HITS"
    done < <(printf '%s' "$entry" | jq -r '.grep_patterns[]')
  else
    # require: every target file must contain at least one of the patterns
    pats_file="$TMPDIR_GATE/pats.txt"
    printf '%s' "$entry" | jq -r '.grep_patterns[]' > "$pats_file"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      found=0
      while IFS= read -r pat; do
        [ -n "$pat" ] || continue
        if grep -qE -- "$pat" "$ROOT/$f" 2>/dev/null; then found=1; break; fi
      done < "$pats_file"
      if [ "$found" -eq 0 ]; then
        printf '%s %s:1 | required pattern missing (%s)\n' "$id" "$f" "$(printf '%s' "$entry" | jq -r '.grep_patterns | join(" OR ")')"
        entry_hits=$((entry_hits + 1))
      fi
    done < "$TARGETS"
  fi

  violations=$((violations + entry_hits))
  if [ "$entry_hits" -eq 0 ]; then
    say "ok    $id ($mode, $target_count file(s))"
  fi
done < "$ENTRIES"

say ""
say "gate:constraints — scanned $scanned_entries grep entr(y|ies), $violations violation(s), $empty_gates empty gate(s)"

if [ "$violations" -gt 0 ] || [ "$empty_gates" -gt 0 ]; then
  exit 1
fi
exit 0
