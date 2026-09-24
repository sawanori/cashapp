#!/usr/bin/env bash
# scripts/deny-test-weakening.sh
#
# PreToolUse(Edit|Write|MultiEdit) guard. Reads the hook payload on stdin and
# exits 2 (Claude Code's "blocking error") when the edit would:
#
#   1. weaken tests/**  — fewer `it(` / `test(` / `expect(` after the edit than
#      before, or a newly introduced `.skip` / `.todo` / `.only` modifier;
#   2. write a production key into any file (sk_live_… / pk_live_… /
#      PAYPAY_ENV=PROD);
#   3. write docs/run-log/** directly — only scripts/record-run.sh may (R-TH-02);
#   4. write the `evidence` field of docs/acceptance-checks.json directly (G9);
#   5. rewrite docs/gates/** — gate definitions are the PO's, not the AI's
#      (R-SEC-07, F13);
#   6. rewrite the guards themselves — scripts/deny-* and scripts/record-run.sh
#      (R-SEC-07). The Bash side has always blocked these; without the same
#      rule here, one Edit disabled the whole harness;
#   7. remove a hook registration from .claude/** — adding hooks stays allowed
#      (task_006 / 018 / 019 each register more), but an edit that drops a
#      reference to one of the registered guard scripts is a weakening, judged
#      the same way as a tests/** edit that drops assertions.
#
# The Bash-side equivalents (`>` redirects, tee, sed -i, cp/mv, python open)
# live in scripts/deny-dangerous-bash.sh.
#
# Exit codes: 0 allow, 2 block (or the guard itself could not run safely).
#
# Compatible with bash 3.2. External dependencies: jq, grep, sed, wc.

set -uo pipefail

SELF="deny-test-weakening.sh"

block() {
  echo "$SELF: BLOCKED" >&2
  echo "  対象: $1" >&2
  echo "  理由: $2" >&2
  exit 2
}

for bin in jq grep sed wc; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "$SELF: 必須コマンドがありません: $bin（安全側に倒して遮断します）" >&2
    exit 2
  }
done

INPUT="$(cat)"
[ -n "$INPUT" ] || exit 0

TOOL="$(printf '%s' "$INPUT" | jq -r 'if type == "object" then (.tool_name // "") else "" end' 2>/dev/null)"
if [ $? -ne 0 ]; then
  block "(フック入力)" "フック入力の JSON を解釈できません（安全側に倒して遮断します）"
fi

case "$TOOL" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null)"
[ -n "$FILE" ] || exit 0

TMP_OLD="$(mktemp)"
TMP_NEW="$(mktemp)"
cleanup() { rm -f "$TMP_OLD" "$TMP_NEW"; }
trap cleanup EXIT

# ------------------------------------------------- old / new text extraction --
case "$TOOL" in
  Write)
    printf '%s' "$INPUT" | jq -r '.tool_input.content // ""' > "$TMP_NEW"
    # A Write replaces the whole file, so the file on disk is the "before".
    if [ -f "$FILE" ]; then cat "$FILE" > "$TMP_OLD"; else : > "$TMP_OLD"; fi
    ;;
  Edit)
    printf '%s' "$INPUT" | jq -r '.tool_input.old_string // ""' > "$TMP_OLD"
    printf '%s' "$INPUT" | jq -r '.tool_input.new_string // ""' > "$TMP_NEW"
    ;;
  MultiEdit)
    printf '%s' "$INPUT" | jq -r '[(.tool_input.edits // [])[].old_string // ""] | join("\n")' > "$TMP_OLD"
    printf '%s' "$INPUT" | jq -r '[(.tool_input.edits // [])[].new_string // ""] | join("\n")' > "$TMP_NEW"
    ;;
  NotebookEdit)
    printf '%s' "$INPUT" | jq -r '.tool_input.new_source // ""' > "$TMP_NEW"
    : > "$TMP_OLD"
    ;;
esac

matches() { grep -Eq "$2" "$1" 2>/dev/null; }
count_of() { grep -oE "$2" "$1" 2>/dev/null | wc -l | tr -d ' '; }

# ----------------------------------------------------------- production keys --
# The character class after the prefix keeps this file from matching itself.
PROD_KEY_RE='sk_live_[A-Za-z0-9]|pk_live_[A-Za-z0-9]|PAYPAY_ENV["'"'"' ]*[:=]["'"'"' ]*PROD'
if matches "$TMP_NEW" "$PROD_KEY_RE"; then
  block "$FILE" "本番鍵・本番決済環境の値をファイルに書き込もうとしています（L11 / R-SEC-04）。本番シークレットは CI の environment: production からのみ投入します"
fi

# ---------------------------------------------------------- protected paths --
if printf '%s' "$FILE" | grep -Eq '(^|/)docs/run-log/'; then
  block "$FILE" "docs/run-log/** に書けるのは scripts/record-run.sh だけです（R-TH-02）。scripts/record-run.sh <task_id> <command...> 経由で実行してください"
fi

if printf '%s' "$FILE" | grep -Eq '(^|/)docs/gates/'; then
  block "$FILE" "docs/gates/** は PO 専管のゲート定義の正本です（R-SEC-07 / F13）。AI は読むだけで書き換えられません"
fi

# The guards themselves. scripts/deny-dangerous-bash.sh already refuses every
# Bash-side write to these paths; this is the Edit/Write half of the same rule.
if printf '%s' "$FILE" | grep -Eq '(^|/)scripts/(deny-[^/]*|record-run\.sh)$'; then
  block "$FILE" "ハーネスのガード本体（scripts/deny-* ・scripts/record-run.sh）は Edit/Write で書き換えられません（R-SEC-07 / R-TH-02）。変更が要るなら task_005 の scope として起票し、人間のレビューを通してください"
fi

# .claude/** — hooks may be added, never silently removed.
if printf '%s' "$FILE" | grep -Eq '(^|/)\.claude/'; then
  for guard in \
    'deny-dangerous-bash\.sh' \
    'deny-test-weakening\.sh' \
    'session-brief\.mjs' \
    'gate-status\.mjs' \
    'append-handoff\.sh' \
    'assert-diff-exists\.sh' \
    'record-run\.sh'; do
    old_refs="$(count_of "$TMP_OLD" "$guard")"
    new_refs="$(count_of "$TMP_NEW" "$guard")"
    if [ "$new_refs" -lt "$old_refs" ]; then
      block "$FILE" "フック登録からガードスクリプトの参照が ${old_refs} 件から ${new_refs} 件に減っています（R-SEC-07 / R-TH-02）。.claude/** へのフック追加は通りますが、登録済みのガードを外すことはできません"
    fi
  done
fi

if printf '%s' "$FILE" | grep -Eq '(^|/)docs/acceptance-checks\.json$'; then
  if matches "$TMP_NEW" '"?evidence"?' || matches "$TMP_OLD" '"?evidence"?'; then
    block "$FILE" "acceptance-checks.json の evidence は検証コマンドの実行結果から機械的に書かれるものです（G9 / R-TH-02）。直接編集はできません"
  fi
fi

# ------------------------------------------------------------- tests/** 弱体化 --
if printf '%s' "$FILE" | grep -Eq '(^|/)tests/'; then
  SKIP_RE='(describe|it|test) *\. *(skip|todo|only)([^A-Za-z0-9_]|$)'
  old_skip="$(count_of "$TMP_OLD" "$SKIP_RE")"
  new_skip="$(count_of "$TMP_NEW" "$SKIP_RE")"
  if [ "$new_skip" -gt "$old_skip" ]; then
    block "$FILE" "テストに .skip / .todo / .only を追加しています（F3）。落ちているテストは無効化せず、誤っているなら BLOCKED として報告してください"
  fi

  CASE_RE='(^|[^A-Za-z0-9_$.])(it|test) *\('
  EXPECT_RE='(^|[^A-Za-z0-9_$.])expect *\('
  old_cases="$(count_of "$TMP_OLD" "$CASE_RE")"
  new_cases="$(count_of "$TMP_NEW" "$CASE_RE")"
  old_expects="$(count_of "$TMP_OLD" "$EXPECT_RE")"
  new_expects="$(count_of "$TMP_NEW" "$EXPECT_RE")"

  if [ "$new_cases" -lt "$old_cases" ]; then
    block "$FILE" "テストケース（it/test）が ${old_cases} 件から ${new_cases} 件に減っています（F3）。テストを通すためにテストを削らないでください"
  fi
  if [ "$new_expects" -lt "$old_expects" ]; then
    block "$FILE" "アサーション（expect）が ${old_expects} 件から ${new_expects} 件に減っています（F3）。テストを通すためにアサーションを削らないでください"
  fi
fi

exit 0
