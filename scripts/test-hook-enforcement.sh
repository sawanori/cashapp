#!/usr/bin/env bash
# scripts/test-hook-enforcement.sh
#
# フック実在マトリクスの実測（task_006 / check_065 / R-TH-12）。
#
# 「フックを登録した」ことと「フックが効いている」ことは別である。前者は settings.json を
# 読めば分かるが、後者は実際に発火させるか、発火した痕跡を見ないと分からない。
# 本スクリプトは 3 階層で測る:
#
#   A 登録        .claude/settings.json に何がどの matcher で登録されているか
#   B 単体挙動    登録されたコマンドそのものにフック入力 JSON を stdin で流し、終了コードを見る
#   C ライブ痕跡  実セッションの transcript と、フックが残すファイルの副作用を数える
#
# C が本体である。A と B だけでは「Claude Code が実際にこのイベントを発火させるか」は分からない。
#
# 破壊的な副作用を出さないため、B の Stop / SubagentStop は使い捨てディレクトリを
# CLAUDE_PROJECT_DIR にして走らせる（本物の docs/HANDOFF.md と .locks/ を汚さない）。
#
# Usage: scripts/test-hook-enforcement.sh [--markdown] [--quiet]
# Exit codes:
#   0  6 イベントすべてが登録されており、遮断すべき単体挙動が遮断した
#   1  登録の欠落、または遮断すべきものが遮断しなかった
#   2  依存コマンドが無い等の実行不能

set -uo pipefail

SELF="test-hook-enforcement.sh"
MARKDOWN=0
QUIET=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --markdown) MARKDOWN=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "$SELF: unknown argument: $1" >&2; exit 2 ;;
  esac
done

for bin in jq git node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "$SELF: missing dependency: $bin" >&2; exit 2; }
done

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SETTINGS="$ROOT/.claude/settings.json"
[ -f "$SETTINGS" ] || { echo "$SELF: not found: $SETTINGS" >&2; exit 2; }

SANDBOX="$(mktemp -d)"
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

failures=0
say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }

EVENTS="SessionStart UserPromptSubmit PreToolUse PostToolUse Stop SubagentStop"

# ------------------------------------------------------------------ A 登録 --
say "== A 登録（.claude/settings.json）"
for event in $EVENTS; do
  rows="$(jq -r --arg e "$event" '
    (.hooks[$e]? // [])[]
    | ((.matcher // "(matcher なし)") + " -> " + ([(.hooks // [])[].command] | join(" ; ")))
  ' "$SETTINGS" 2>/dev/null)"
  if [ -z "$rows" ]; then
    say "  MISSING $event: 登録なし"
    failures=$((failures + 1))
  else
    printf '%s\n' "$rows" | while IFS= read -r row; do
      [ -z "$row" ] || say "  ok      $event: $row"
    done
  fi
done

# -------------------------------------------------------------- B 単体挙動 --
# 各フックの stdin に渡すフック入力 JSON。フィールド名は Claude Code のフック入力に合わせる。
say ""
say "== B 単体挙動（登録されたコマンドに stdin でフック入力を渡す）"

probe() {
  # probe <label> <expected_exit|any> <cwd> <command...>
  local label="$1" expected="$2" cwd="$3"
  shift 3
  local out rc
  out="$(cd "$cwd" && "$@" 2>&1 <<<"$PAYLOAD")"
  rc=$?
  local head
  head="$(printf '%s' "$out" | head -c 160 | LC_ALL=C tr '\n' ' ')"
  if [ "$expected" = "any" ] || [ "$rc" = "$expected" ]; then
    say "  ok      $label: exit $rc  ${head}"
  else
    say "  FAIL    $label: exit $rc（期待 $expected）  ${head}"
    failures=$((failures + 1))
  fi
}

PAYLOAD='{"session_id":"hook-enforcement-probe","hook_event_name":"SessionStart","source":"startup","cwd":"'"$ROOT"'"}'
probe "SessionStart / session-brief.mjs" 0 "$ROOT" node "$ROOT/scripts/session-brief.mjs"

PAYLOAD='{"session_id":"hook-enforcement-probe","hook_event_name":"UserPromptSubmit","prompt":"probe","cwd":"'"$ROOT"'"}'
probe "UserPromptSubmit / gate-status.mjs" 0 "$ROOT" node "$ROOT/scripts/gate-status.mjs"

# 遮断されなければならない Bash（保護対象ツリーの再帰削除）
PAYLOAD="$(jq -nc --arg c 'rm -rf docs/run-log' '{session_id:"hook-enforcement-probe",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$c}}')"
probe "PreToolUse(Bash) / 保護ツリーの削除は遮断" 2 "$ROOT" bash "$ROOT/scripts/deny-dangerous-bash.sh"

# 遮断されてはならない Bash（普通の読み取り）
PAYLOAD="$(jq -nc --arg c 'git status --short' '{session_id:"hook-enforcement-probe",hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$c}}')"
probe "PreToolUse(Bash) / 通常コマンドは通す" 0 "$ROOT" bash "$ROOT/scripts/deny-dangerous-bash.sh"

# 遮断されなければならない Write（run-log への直接書き込み）
PAYLOAD="$(jq -nc --arg p "$ROOT/docs/run-log/task_probe.json" '{session_id:"hook-enforcement-probe",hook_event_name:"PreToolUse",tool_name:"Write",tool_input:{file_path:$p,content:"[]"}}')"
probe "PreToolUse(Write) / run-log への直接書き込みは遮断" 2 "$ROOT" bash "$ROOT/scripts/deny-test-weakening.sh"

# 遮断されてはならない Write（通常のソース）
PAYLOAD="$(jq -nc --arg p "$ROOT/src/lib/__probe__.ts" '{session_id:"hook-enforcement-probe",hook_event_name:"PreToolUse",tool_name:"Write",tool_input:{file_path:$p,content:"export const probe = 1;\n"}}')"
probe "PreToolUse(Write) / 通常のソースは通す" 0 "$ROOT" bash "$ROOT/scripts/deny-test-weakening.sh"

# PostToolUse は npm スクリプト 4 本。落ちているかどうかは実行時のリポジトリ状態に依存するので
# 期待値は置かず、終了コードをそのまま記録する。
PAYLOAD='{"session_id":"hook-enforcement-probe","hook_event_name":"PostToolUse","tool_name":"Write"}'
for script in typecheck lint:changed gate:constraints gate:plan; do
  probe "PostToolUse / npm run $script" any "$ROOT" npm run --silent "$script"
done

# Stop / SubagentStop は副作用を持つので使い捨てディレクトリで走らせる
mkdir -p "$SANDBOX/docs"
PAYLOAD='{"session_id":"hook-enforcement-probe","hook_event_name":"Stop","stop_hook_active":false}'
CLAUDE_PROJECT_DIR="$SANDBOX" probe "Stop / append-handoff.sh" 0 "$SANDBOX" bash "$ROOT/scripts/append-handoff.sh"
if [ -f "$SANDBOX/docs/HANDOFF.md" ] && grep -q "ターンログ" "$SANDBOX/docs/HANDOFF.md"; then
  say "  ok      Stop / append-handoff.sh が HANDOFF に 1 行追記した（使い捨てディレクトリで確認）"
else
  say "  FAIL    Stop / append-handoff.sh が HANDOFF に追記しなかった"
  failures=$((failures + 1))
fi

# assert-diff-exists.sh は git 作業ツリーの外では即 exit 0 するので、使い捨ての git リポジトリを作る。
git init -q "$SANDBOX" >/dev/null 2>&1 || true
PAYLOAD='{"session_id":"hook-enforcement-probe","hook_event_name":"SubagentStop","stop_hook_active":false}'
CLAUDE_PROJECT_DIR="$SANDBOX" probe "SubagentStop / assert-diff-exists.sh" 0 "$SANDBOX" bash "$ROOT/scripts/assert-diff-exists.sh"
if [ -f "$SANDBOX/.locks/subagent-head-baseline-hook-enforcement-probe" ]; then
  say "  ok      SubagentStop / assert-diff-exists.sh が session_id 付き baseline を書いた"
else
  say "  FAIL    SubagentStop / assert-diff-exists.sh が baseline を書かなかった"
  failures=$((failures + 1))
fi

# ------------------------------------------------------------ C ライブ痕跡 --
say ""
say "== C ライブ痕跡（実セッションの transcript とフックの副作用）"

SLUG="$(printf '%s' "$ROOT" | sed -e 's|[/_.]|-|g')"
TRANSCRIPTS="$HOME/.claude/projects/$SLUG"

count_in_transcripts() {
  # count_in_transcripts <fixed-string>
  if [ ! -d "$TRANSCRIPTS" ]; then printf '0'; return; fi
  find "$TRANSCRIPTS" -name '*.jsonl' -type f -print0 2>/dev/null \
    | LC_ALL=C xargs -0 grep -aoF -- "$1" 2>/dev/null | wc -l | tr -d ' '
}

if [ -d "$TRANSCRIPTS" ]; then
  say "  transcript: ${TRANSCRIPTS} （$(find "$TRANSCRIPTS" -name '*.jsonl' -type f 2>/dev/null | wc -l | tr -d ' ') ファイル）"
  say "  SessionStart     注入の記録: $(count_in_transcripts '"hookName":"SessionStart') 件"
  say "  UserPromptSubmit 注入の記録: $(count_in_transcripts '"hookName":"UserPromptSubmit') 件"
  say "  PreToolUse(Bash)      遮断: $(count_in_transcripts 'PreToolUse:Bash hook') 件"
  say "  PreToolUse(Write)     遮断: $(count_in_transcripts 'PreToolUse:Write hook') 件"
  say "  PreToolUse(Edit)      遮断: $(count_in_transcripts 'PreToolUse:Edit hook') 件"
  say "  PreToolUse(MCP 編集)  遮断: $(count_in_transcripts 'PreToolUse:mcp__') 件"
  say "  PostToolUse           差し戻し: $(count_in_transcripts 'PostToolUse:Edit hook') / $(count_in_transcripts 'PostToolUse:Write hook') 件（Edit / Write）"
else
  say "  transcript ディレクトリがありません: ${TRANSCRIPTS} （CI 等。C は測れません）"
fi

HANDOFF_LINES="$(grep -c '^- 2026-' "$ROOT/docs/HANDOFF.md" 2>/dev/null || echo 0)"
say "  Stop          追記行数: $HANDOFF_LINES 行（docs/HANDOFF.md のターンログ節）"
LAST_TURN="$(grep '^- 2026-' "$ROOT/docs/HANDOFF.md" 2>/dev/null | tail -1 | cut -c3-22)"
say "  Stop          最終追記: ${LAST_TURN:-なし}"

BASELINES="$(ls -1 "$ROOT/.locks/" 2>/dev/null | grep -c '^subagent-head-baseline' || echo 0)"
say "  SubagentStop  baseline ファイル: $BASELINES 件（.locks/subagent-head-baseline*）"
for b in "$ROOT"/.locks/subagent-head-baseline*; do
  [ -f "$b" ] || continue
  say "                $(basename "$b") 最終更新 $(date -u -r "$b" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
done

say ""
if [ "$failures" -gt 0 ]; then
  say "test-hook-enforcement — $failures 件の不一致"
  exit 1
fi
say "test-hook-enforcement — 登録 6 イベント・単体挙動すべて期待どおり"
exit 0
