#!/usr/bin/env bash
# scripts/deny-test-weakening.sh
#
# PreToolUse(Edit|Write|MultiEdit) guard. Reads the hook payload on stdin and
# exits 2 (Claude Code's "blocking error") when the edit would:
#
#   1. weaken tests/**  — fewer `it(` / `test(` / `expect(` after the edit than
#      before, or a newly introduced `.skip` / `.todo` / `.only` modifier;
#   2. write a production key into any file (sk_live_… / pk_live_… /
#      the PayPay production environment flag);
#   3. write docs/run-log/** directly — only scripts/record-run.sh may (R-TH-02);
#   4. write the `evidence` field of docs/acceptance-checks.json directly (G9);
#   5. rewrite docs/gates/** — gate definitions are the PO's, not the AI's
#      (R-SEC-07, F13);
#   6. rewrite the guards themselves — scripts/deny-* and scripts/record-run.sh
#      (R-SEC-07). The Bash side has always blocked these; without the same
#      rule here, one Edit disabled the whole harness;
#   7. break the hook registrations in .claude/settings.json — adding hooks
#      stays allowed (task_006 / 018 / 019 each register more), but the file
#      that results from the edit must still PARSE as JSON and must still
#      register, under each event, a hook whose matcher covers the expected
#      tools and whose command names the expected guard.
#
#      That last check used to be a count of how often each guard's file name
#      appeared in the edit. Counting names is not a structural check: renaming
#      the `hooks` key, replacing a matcher ("Bash" -> "Task", or narrowing
#      "Edit|Write|MultiEdit" to "Write"), or moving a registration to an event
#      that is never fired all keep every name in the file while switching the
#      guard off. The edit is now applied to a copy of the file and the result
#      is parsed with jq and checked against EXPECTED_HOOKS below. Other
#      .claude/** files (agent definitions, docs) have no such structure, so
#      they keep the name-count rule.
#
# The Bash-side equivalents (`>` redirects, tee, sed -i, cp/mv, rm, git apply,
# python open) live in scripts/deny-dangerous-bash.sh.
#
# Exit codes: 0 allow, 2 block (or the guard itself could not run safely).
#
# Compatible with bash 3.2. External dependencies: jq, grep, sed, wc, and —
# only for the .claude/settings.json structural check — node.

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

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

TMP_OLD="$(mktemp)"
TMP_NEW="$(mktemp)"
TMP_PAYLOAD="$(mktemp)"
TMP_RESULT="$(mktemp)"
TMP_JS="$(mktemp)"
cleanup() { rm -f "$TMP_OLD" "$TMP_NEW" "$TMP_PAYLOAD" "$TMP_RESULT" "$TMP_JS"; }
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

# ------------------------------------------- .claude/settings.json の構造検査 --
# Every registration that must survive an edit: the hook event, the tool names
# the matcher has to keep covering (empty = the event takes no matcher), and a
# substring the registered command must still contain.
EXPECTED_HOOKS='[
  {"event":"SessionStart","tokens":[],"cmd":"session-brief.mjs"},
  {"event":"UserPromptSubmit","tokens":[],"cmd":"gate-status.mjs"},
  {"event":"PreToolUse","tokens":["Bash"],"cmd":"deny-dangerous-bash.sh"},
  {"event":"PreToolUse","tokens":["Edit","Write","MultiEdit"],"cmd":"deny-test-weakening.sh"},
  {"event":"PostToolUse","tokens":["Edit","Write","MultiEdit"],"cmd":"typecheck"},
  {"event":"PostToolUse","tokens":["Edit","Write","MultiEdit"],"cmd":"lint:changed"},
  {"event":"PostToolUse","tokens":["Edit","Write","MultiEdit"],"cmd":"gate:constraints"},
  {"event":"Stop","tokens":[],"cmd":"append-handoff.sh"},
  {"event":"SubagentStop","tokens":[],"cmd":"assert-diff-exists.sh"}
]'

settings_result() {
  # Writes the file as it would look AFTER this edit into $TMP_RESULT.
  # A Write carries the whole file; an Edit / MultiEdit carries fragments, so
  # they are applied to the copy on disk the same way the tool would apply them.
  cat > "$TMP_JS" <<'NODE'
const fs = require("node:fs");
const [payloadFile, target, outFile] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(payloadFile, "utf8"));
const tool = payload.tool_name;
const input = payload.tool_input || {};
let out;
if (tool === "Write") {
  out = typeof input.content === "string" ? input.content : "";
} else {
  let base = "";
  try {
    base = fs.readFileSync(target, "utf8");
  } catch {
    base = "";
  }
  const edits =
    tool === "MultiEdit"
      ? input.edits || []
      : [
          {
            old_string: input.old_string,
            new_string: input.new_string,
            replace_all: input.replace_all,
          },
        ];
  for (const edit of edits) {
    const oldString = typeof edit.old_string === "string" ? edit.old_string : "";
    const newString = typeof edit.new_string === "string" ? edit.new_string : "";
    if (oldString === "") continue;
    base = edit.replace_all
      ? base.split(oldString).join(newString)
      : base.replace(oldString, () => newString);
  }
  out = base;
}
fs.writeFileSync(outFile, out);
NODE
  node "$TMP_JS" "$TMP_PAYLOAD" "$1" "$TMP_RESULT"
}

if printf '%s' "$FILE" | grep -Eq '(^|/)\.claude/settings\.json$'; then
  command -v node >/dev/null 2>&1 || {
    block "$FILE" ".claude/settings.json の構造検査に node が必要ですが見つかりません（安全側に倒して遮断します）"
  }

  ABS="$FILE"
  case "$FILE" in
    /*) ;;
    *) ABS="$ROOT/$FILE" ;;
  esac

  printf '%s' "$INPUT" > "$TMP_PAYLOAD"
  settings_result "$ABS" || block "$FILE" "編集後の .claude/settings.json を組み立てられませんでした（安全側に倒して遮断します）"

  jq -e . "$TMP_RESULT" >/dev/null 2>&1 || {
    block "$FILE" "編集後の .claude/settings.json が JSON として解釈できません（R-SEC-07 / R-TH-02）。壊れた settings.json はフックを 1 つも登録しないので、ガードを全部外すのと同じです"
  }

  # `present` takes the document explicitly: inside `$expect[] | select(...)`
  # the input is the expectation object, not the settings document.
  MISSING="$(jq -r --argjson expect "$EXPECTED_HOOKS" '
    def present($doc; $e; $t; $c):
      [ ($doc.hooks[$e]? // [])[]
        | select((($t - ((.matcher // "") | split("|"))) | length) == 0)
        | (.hooks? // [])[]
        | (.command // "")
      ]
      # Only the part before a `#` counts, so commenting the guard out
      # (`true # deny-dangerous-bash.sh`) does not satisfy the expectation.
      | map(split("#")[0] | contains($c)) | any;
    . as $doc
    | [ $expect[]
        | select((present($doc; .event; .tokens; .cmd)) | not)
        | "\(.event)[\(.tokens | join("|"))] -> \(.cmd)"
      ] | join(" / ")
  ' "$TMP_RESULT" 2>/dev/null)" || block "$FILE" "編集後の .claude/settings.json のフック登録を検査できませんでした（安全側に倒して遮断します）"

  if [ -n "$MISSING" ]; then
    block "$FILE" "フック登録が失われています: ${MISSING}（R-SEC-07 / R-TH-02）。.claude/** へのフック追加・matcher の拡張は通りますが、登録済みのガードを外す・event を変える・matcher を狭める編集はできません"
  fi
elif printf '%s' "$FILE" | grep -Eq '(^|/)\.claude/'; then
  # Other .claude/** files carry no hook structure; the name-count rule is all
  # that can be said about them.
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
      block "$FILE" "ガードスクリプトの参照が ${old_refs} 件から ${new_refs} 件に減っています（R-SEC-07 / R-TH-02）。.claude/** への追記は通りますが、登録済みのガードを外すことはできません"
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
