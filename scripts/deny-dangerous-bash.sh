#!/usr/bin/env bash
# scripts/deny-dangerous-bash.sh
#
# PreToolUse(Bash) guard. Reads the hook payload on stdin
# ({"tool_name":"Bash","tool_input":{"command":"..."}}) and exits 2 when the
# command would do something this repository forbids from a developer machine.
# Exit 2 is Claude Code's "blocking error": the tool call never runs and the
# message on stderr is fed back to the model.
#
# Two families of rules:
#
#   A. Destructive / production / payment commands (R-TH-02, R-SEC-07, L11).
#      Deploys happen only from CI (.github/workflows/release.yml), so
#      `wrangler deploy` is blocked locally regardless of --env and regardless
#      of docs/gates/legal-clearance.json.
#
#   B. Bash-side writes into files that are supposed to be machine-written or
#      human-only: docs/run-log/**, docs/gates/**, docs/acceptance-checks.json,
#      tests/**, scripts/deny-*, scripts/record-run.sh, .claude/**,
#      .github/workflows/**. Blocked mechanisms: `>` / `>>` redirects, `tee`,
#      `sed -i` / `sed --in-place`, any operand of `cp` / `mv` / `rsync` /
#      `install`, `dd of=`, an interpreter one-liner (`python -c`, `node -e`,
#      `perl -i -pe`, …) naming a protected path, and — just as important —
#      DELETION and RESTORE: `rm`, `unlink`, `shred`, `truncate`, `chmod`,
#      `chown`, `ln`, `git rm`, `git restore`, `git checkout -- <path>`,
#      `git clean`. Overwrite-only rules were not enough: a single `rm` of this
#      script or of .claude/settings.json disables every guard at once.
#      There is deliberately NO exception clause for scripts/record-run.sh:
#      a record-run.sh invocation carries none of those mechanisms, so it is
#      allowed by construction rather than by a carve-out an attacker could
#      imitate.
#
# `npm run <script>` / `yarn <script>` / `npx <bin>` are resolved through
# package.json.scripts and the resolved body is scanned with the same rules,
# recursively. If a name cannot be resolved and looks like
# deploy|secret|publish|reset|push|prod, it is blocked fail-closed.
#
# The BLOCKED message quotes the offending clause, so every quoted string is
# passed through mask() first. Some rules (the live-secret prefix, `wrangler
# secret put`) match only commands that carry a credential, and echoing the
# clause back verbatim put that credential into the hook output.
#
# Exit codes: 0 allow, 2 block (or the guard itself could not run safely).
#
# Compatible with bash 3.2 (macOS system bash): no mapfile, no associative
# arrays, no globstar, no ${var,,}. External dependencies: jq, grep, sed, tr.
#
# Test hook (used only by tests/unit/hooks/deny-dangerous-bash.test.ts):
#   DENY_BASH_PACKAGE_JSON  path to the package.json used for script resolution

set -uo pipefail
set -f # never let an unquoted token be glob-expanded while we tokenize

SELF="deny-dangerous-bash.sh"
MAX_DEPTH=5
RISKY_SCRIPT_NAME_RE='deploy|secret|publish|reset|push|prod'

mask() {
  # Redact credential-shaped text before it reaches stderr. The literal
  # prefixes are split across string concatenations so that this file does not
  # trip scripts/deny-test-weakening.sh's own production-key rule.
  printf '%s' "$1" \
    | sed -E 's/(sk|pk|rk)_'"live"'_[A-Za-z0-9]+/\1_'"live"'_***/g' \
    | sed -E 's/([Bb]earer )[A-Za-z0-9._~+/-]+/\1***/g' \
    | sed -E 's/(secret +put).*/\1 ***/' \
    | sed -E 's/([A-Za-z_]*(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z_]*=)[^ ]+/\1***/g'
}

block() {
  # $1 = what matched, $2 = why it is blocked
  echo "$SELF: BLOCKED" >&2
  echo "  該当: $(mask "$1")" >&2
  echo "  理由: $2" >&2
  exit 2
}

for bin in jq grep sed tr; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "$SELF: 必須コマンドがありません: $bin（安全側に倒して遮断します）" >&2
    exit 2
  }
done

INPUT="$(cat)"
if [ -z "$INPUT" ]; then
  # Nothing to inspect (manual invocation without a payload).
  exit 0
fi

CMD="$(printf '%s' "$INPUT" | jq -r 'if type == "object" then (.tool_input.command // "") else "" end' 2>/dev/null)"
if [ $? -ne 0 ]; then
  block "(フック入力の JSON を解釈できません)" "入力が壊れている場合は安全側に倒して遮断します"
fi
[ -n "$CMD" ] || exit 0

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
PKG="${DENY_BASH_PACKAGE_JSON:-$ROOT/package.json}"

SEP=$(printf '\001')

# Paths whose contents must not be written from a Bash command.
PROTECTED_RE='(docs/run-log/|docs/gates/|docs/acceptance-checks\.json|tests/|scripts/deny-|scripts/record-run\.sh|\.claude/|\.github/workflows/)'

# The same areas named as a directory rather than as a file inside one.
# PROTECTED_RE only matches a path with something after the slash, so
# `rm -r docs/gates` and `git clean -fd .claude` — which destroy the whole tree,
# guards included — did not match it at all.
PROTECTED_TREE_RE='(^|/)(docs/run-log|docs/gates|tests|scripts|\.claude|\.github)(/|$)'

# ---------------------------------------------------------------- normalize --
# Collapse quoting and whitespace, then turn &&, ||, |, ; and newlines into a
# single subcommand separator so each clause can be matched on its own.
normalize() {
  printf '%s' "$1" \
    | tr -d '"'"'"'`' \
    | tr -d '\\' \
    | tr '\n\r' "$SEP$SEP" \
    | sed -e "s/&&/$SEP/g" -e "s/||/$SEP/g" -e "s/|/$SEP/g" -e "s/;/$SEP/g" \
    | tr '\t' ' ' \
    | tr -s ' '
}

# --------------------------------------------------------------- rule set A --
is_rm_rf() {
  # `rm` carrying both a recursive and a force flag, in any order or spelling.
  # The clustered-flag scan below only sees a single leading dash followed by
  # letters, so the GNU long spellings (`--recursive` / `--force`, accepted by
  # the coreutils rm that CI runs on Linux) never reached it and
  # `rm --recursive --force` walked straight through. They are checked
  # separately, and either spelling satisfies either half.
  local s="$1" flags rec=1 force=1
  case " $s " in
    *" rm "*) ;;
    *) return 1 ;;
  esac
  flags="$(printf '%s' "$s" | grep -oE '(^| )-[a-zA-Z]+' | tr -d ' -' | tr -d '\n')"
  case "$flags" in
    *r*|*R*) rec=0 ;;
  esac
  case "$flags" in
    *f*|*F*) force=0 ;;
  esac
  printf '%s' "$s" | grep -Eq '(^| )--recursive( |$)' && rec=0
  printf '%s' "$s" | grep -Eq '(^| )--force( |$)' && force=0
  [ "$rec" -eq 0 ] && [ "$force" -eq 0 ]
}

raw_rules_hit() {
  # $1 = one normalized subcommand. Echoes the rule name when it matches.
  local sub="$1"

  if printf '%s' "$sub" | grep -Eqi '(^| )git +push( |$)' &&
     printf '%s' "$sub" | grep -Eqi '(^| )(-f|--force|--force-with-lease)( |=|$)'; then
    echo "git push --force"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )git +reset +.*--hard'; then
    echo "git reset --hard"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )supabase +db +reset( |$)'; then
    echo "supabase db reset"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )supabase +db +push( |$)'; then
    echo "supabase db push"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )wrangler +versions +deploy( |$)'; then
    echo "wrangler versions deploy"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )wrangler +deploy( |$)'; then
    echo "wrangler deploy"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )wrangler +secret +put( |$)'; then
    echo "wrangler secret put"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi 'PAYPAY_ENV *= *PROD'; then
    echo "PAYPAY_ENV=PROD"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi 'sk_live_'; then
    echo "本番シークレット（sk_live_ 接頭辞）"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )--live( |=|$)'; then
    echo "--live"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )npm +publish( |$)'; then
    echo "npm publish"; return 0
  fi
  if printf '%s' "$sub" | grep -Eqi '(^| )pnpm( |$)'; then
    echo "pnpm"; return 0
  fi
  if is_rm_rf "$sub"; then
    echo "rm -rf"; return 0
  fi
  return 1
}

# --------------------------------------------------------------- rule set B --
protected() {
  printf '%s' "$1" | grep -Eq "$PROTECTED_RE"
}

protected_tree() {
  printf '%s' "$1" | grep -Eq "$PROTECTED_TREE_RE"
}

write_rules_hit() {
  # $1 = one normalized subcommand. Echoes a description when it matches.
  local sub="$1" target tok seen_tee

  for target in $(printf '%s' "$sub" | grep -oE '>>?[[:space:]]*[^[:space:]]+' | sed -E 's/^>>?[[:space:]]*//'); do
    if protected "$target"; then
      echo "リダイレクト先 $target"; return 0
    fi
  done

  if printf '%s' "$sub" | grep -Eq '(^| )tee( |$)'; then
    seen_tee=0
    for tok in $sub; do
      if [ "$seen_tee" -eq 1 ]; then
        case "$tok" in
          -*) continue ;;
        esac
        if protected "$tok"; then
          echo "tee の出力先 $tok"; return 0
        fi
      fi
      [ "$tok" = "tee" ] && seen_tee=1
    done
  fi

  # `sed -i` / `sed --in-place` rewrite in place: any protected path in the
  # clause blocks. GNU sed (what CI runs) accepts the long spelling, and the
  # short-only test let `sed --in-place … tests/x.test.ts` through.
  if printf '%s' "$sub" | grep -Eq '(^| )sed( |$)' &&
     printf '%s' "$sub" | grep -Eq '(^| )(-i|--in-place)'; then
    for tok in $sub; do
      if protected "$tok"; then
        echo "sed -i の対象 $tok"; return 0
      fi
    done
  fi

  # `cp` / `mv` / `rsync` / `install`: every token of the clause is checked,
  # not just the last one. A trailing `2>/dev/null` or `--verbose` used to
  # become the "destination" and let the real destination through. Same policy
  # as `sed -i` above: a protected path anywhere in such a clause blocks, even
  # when it is the source — copying a gate file out is rare, overwriting it is
  # what must never happen, and fail-closed is the cheaper error here.
  if printf '%s' "$sub" | grep -Eq '(^| )(cp|mv|rsync|install)( |$)'; then
    for tok in $sub; do
      case "$tok" in
        cp|mv|rsync|install) continue ;;
      esac
      if protected "$tok"; then
        echo "cp/mv の対象 $tok"; return 0
      fi
    done
  fi

  # Deletion and restore. Blocking only overwrites left the harness wide open:
  # `rm scripts/deny-dangerous-bash.sh` or `rm .claude/settings.json` removes
  # every guard in one command, `rm -r docs/gates` takes the whole tree, and
  # `git checkout HEAD -- tests/x.test.ts` silently reverts a test. The
  # directory form is checked as well as the file form, and the scan covers the
  # whole clause fail-closed, like cp/mv.
  if printf '%s' "$sub" | grep -Eq '(^| )(rm|unlink|shred|truncate)( |$)' ||
     printf '%s' "$sub" | grep -Eq '(^| )git +(rm|restore|checkout|clean)( |$)'; then
    for tok in $sub; do
      if protected "$tok" || protected_tree "$tok"; then
        echo "削除・復元の対象 $tok"; return 0
      fi
    done
  fi

  # Permission / symlink changes: `chmod -x` on a guard neutralises it just as
  # thoroughly as deleting it, and `ln -sf /dev/null .claude/settings.json`
  # empties the hook registration. Only the file form is checked here — a
  # `chmod +x scripts/ci/foo.sh` on an unprotected script must stay possible.
  if printf '%s' "$sub" | grep -Eq '(^| )(chmod|chown|ln)( |$)'; then
    for tok in $sub; do
      if protected "$tok"; then
        echo "権限・リンク変更の対象 $tok"; return 0
      fi
    done
  fi

  # `dd if=… of=<保護対象>` truncates the destination exactly like a redirect.
  if printf '%s' "$sub" | grep -Eq '(^| )dd( |$)'; then
    for tok in $sub; do
      case "$tok" in
        of=*)
          if protected "${tok#of=}"; then
            echo "dd の出力先 $tok"; return 0
          fi
          ;;
      esac
    done
  fi

  return 1
}

interpreter_write_hit() {
  # $1 = the whole normalized command with separators flattened back to spaces
  # (a one-liner often contains `;`, which would otherwise split the path away
  # from the interpreter and hide it from the per-clause rules).
  #
  # Any interpreter one-liner that names a protected path is blocked. Matching
  # only `python -c … open(.., 'w')` was too narrow twice over: this repo runs
  # on node, so `node -e "require('fs').writeFileSync('docs/run-log/x.json',…)"`
  # walked straight past it, and `perl -i -pe` did the same for tests/**.
  # The one-liner is not parsed, so a read-only one-liner over a protected path
  # is blocked too (use cat / jq for that): write intent cannot be told from the
  # string with any confidence, and fail-closed is the cheaper error.
  # The eval flag has to belong to the interpreter — it is matched as part of
  # that command's own option run, not anywhere in the string. Accepting a
  # loose `-e` elsewhere made prose that merely lists interpreter names (a
  # commit message, a --help text) collide with an unrelated `--force`.
  local whole="$1"
  printf '%s' "$whole" | grep -Eq '(^| )(python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php)( +-[^ ]*)* +(-{1,2}[A-Za-z]*(c|e|m)|--eval|--exec|--print|eval)([ =]|$)' || return 1
  printf '%s' "$whole" | grep -Eq "$PROTECTED_RE" || return 1
  echo "インタプリタのワンライナー（-c / -e / -m 等）が保護対象パスを参照しています"
  return 0
}

# -------------------------------------------------------------- script refs --
script_names() {
  # Flags may appear before `run` (npm --silent run X), after it
  # (npm run --silent X / npm run --workspace=w X), or both. Every
  # `-`-prefixed token is skipped so the first real token is the script name;
  # without this, `npm run --silent deploy:production` resolved the flag
  # instead of the script and neither the alias lookup nor the fail-closed
  # name check ever saw `deploy:production`.
  local sub="$1"
  printf '%s' "$sub" \
    | grep -oE '(^| )(npm|yarn) +(-[^[:space:]]+ +)*(run|run-script) +(-[^[:space:]]+ +)*[^[:space:]]+' \
    | sed -E 's/.*(run|run-script) +//' \
    | sed -E 's/^(-[^[:space:]]+ +)*//'
  printf '%s' "$sub" | grep -oE '(^| )yarn +(-[^[:space:]]+ +)*[^-[:space:]][^[:space:]]*' \
    | sed -E 's/.*yarn +//' \
    | sed -E 's/^(-[^[:space:]]+ +)*//' \
    | grep -Ev '^(run|run-script|install|add|remove|why|info|init|link|unlink|cache|config|dlx|node|workspace|workspaces|up|set|version|pack|publish)$'
  printf '%s' "$sub" | grep -oE '(^| )npx +(-[^[:space:]]+ +)*[^[:space:]]+' \
    | sed -E 's/.*npx +//' \
    | sed -E 's/^(-[^[:space:]]+ +)*//'
}

resolve_script() {
  # $1 = script name. Echoes the body, or nothing when unresolvable.
  local body
  [ -f "$PKG" ] || return 1
  body="$(jq -r --arg n "$1" 'if type == "object" then (.scripts[$n] // "") else "" end' "$PKG" 2>/dev/null)"
  [ -n "$body" ] || return 1
  printf '%s' "$body"
}

# ------------------------------------------------------------------- driver --
scan_text() {
  # $1 = raw command text, $2 = depth, $3 = chain of already-visited names
  local text="$1" depth="$2" chain="$3"
  local norm whole hit sub name body subs_file

  norm="$(normalize "$text")"
  whole="$(printf '%s' "$norm" | tr "$SEP" ' ' | tr -s ' ')"

  hit="$(interpreter_write_hit "$whole")" && block "${hit}（${whole}）" "保護対象ファイルへの Bash 経由の書き込みは禁止です（R-TH-02）"

  subs_file="$(mktemp)"
  # The trailing newline matters: `read` returns non-zero on a final line that
  # has none, which would silently skip the last (often the only) clause.
  printf '%s\n' "$norm" | tr "$SEP" '\n' > "$subs_file"

  while IFS= read -r sub || [ -n "$sub" ]; do
    sub="$(printf '%s' "$sub" | sed -e 's/^ *//' -e 's/ *$//')"
    [ -n "$sub" ] || continue

    hit="$(raw_rules_hit "$sub")" && { rm -f "$subs_file"; block "${hit}（${sub}）" "破壊的操作・本番デプロイ・本番決済はローカルから実行できません（L11 / R-TH-02。デプロイは CI のみ）"; }
    hit="$(write_rules_hit "$sub")" && { rm -f "$subs_file"; block "${hit}（${sub}）" "docs/run-log/** ・docs/gates/** ・docs/acceptance-checks.json ・tests/** ・scripts/deny-* ・scripts/record-run.sh ・.claude/** ・.github/workflows/** への Bash 経由の書き込み・削除は禁止です（R-TH-02 / R-SEC-07）"; }

    for name in $(script_names "$sub"); do
      [ -n "$name" ] || continue
      case "$chain" in
        *"|$name|"*) continue ;;
      esac
      if body="$(resolve_script "$name")"; then
        if [ "$depth" -ge "$MAX_DEPTH" ]; then
          rm -f "$subs_file"
          block "npm run $name" "スクリプトの入れ子が深すぎて解決できません（安全側に倒して遮断）"
        fi
        scan_text "$body" $((depth + 1)) "$chain$name|"
      else
        if printf '%s' "$name" | grep -Eqi "$RISKY_SCRIPT_NAME_RE"; then
          rm -f "$subs_file"
          block "npm run $name" "package.json.scripts から解決できず、名前が deploy|secret|publish|reset|push|prod に一致します（fail-closed）"
        fi
      fi
    done
  done < "$subs_file"

  rm -f "$subs_file"
}

scan_text "$CMD" 0 "|"

exit 0
