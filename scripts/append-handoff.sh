#!/usr/bin/env bash
# scripts/append-handoff.sh
#
# Stop hook. Appends one line per turn to docs/HANDOFF.md under a dedicated
# "ターンログ" section: the UTC timestamp, HEAD, the last commit subject and
# the files still dirty in the working tree.
#
# The point is F4 / R-TH-12: context is lost at compaction and between
# sessions, and PreCompact is not reliable enough to hang the record on
# (docs/implementation-plan.md §16-4 deliberately does not register PreCompact).
# Appending every turn means the next session's session-brief.mjs always has a
# trail to read, whether or not anyone remembered to write one.
#
# The line is deliberately mechanical. Prose about what was decided and what is
# still open belongs in the per-task sections above this one, written by the
# task agent; this hook only guarantees that the file never goes a turn without
# a marker.
#
# Contract: always exits 0 — a turn must never be blocked by bookkeeping.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

HANDOFF="$ROOT/docs/HANDOFF.md"
SECTION="## ターンログ（Stop フック自動追記）"

# Consume stdin so the hook never blocks on an unread pipe.
cat >/dev/null 2>&1 || true

mkdir -p "$(dirname "$HANDOFF")" 2>/dev/null || exit 0
[ -f "$HANDOFF" ] || printf '# HANDOFF\n' > "$HANDOFF" 2>/dev/null || exit 0

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HEAD_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
SUBJECT="$(git -C "$ROOT" log -1 --pretty=%s 2>/dev/null || echo '(コミットなし)')"

DIRTY="$(git -C "$ROOT" status --porcelain 2>/dev/null | sed -e 's/^...//' | head -8 | tr '\n' ' ')"
DIRTY_COUNT="$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
if [ "${DIRTY_COUNT:-0}" = "0" ]; then
  DIRTY_TEXT="未コミットの変更なし"
else
  DIRTY_TEXT="未コミット ${DIRTY_COUNT} 件: ${DIRTY}"
fi

grep -qF "$SECTION" "$HANDOFF" 2>/dev/null || {
  printf '\n%s\n\n各ターン終了時に scripts/append-handoff.sh が 1 行追記する。決まったこと・未解決の本文は上の各タスク節に書く。\n\n' "$SECTION" >> "$HANDOFF"
}

printf -- '- %s HEAD=%s 決まったこと: %s / 未解決: %s\n' \
  "$TS" "$HEAD_SHA" "$SUBJECT" "$DIRTY_TEXT" >> "$HANDOFF" 2>/dev/null || true

exit 0
