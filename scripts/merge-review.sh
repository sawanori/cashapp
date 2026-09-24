#!/usr/bin/env bash
# scripts/merge-review.sh
#
# 複数ベンダーの返信封筒を 1 つの判定に畳み、docs/review-log/<task_id>.json に残す。
# docs/implementation-plan.md §15-3 / §16-5 / task_007 / check_066 / R-TH-08 / R-TH-13。
#
# 判定は 3 本しかない。
#
#   1. 実効 high（validate-findings.mjs の降格後に high のまま残った finding）が
#      1 件でもあれば差し戻し   → exit 1
#   2. 不達（reviewer_route=unavailable）は「欠票」として記録し、他に有効票が
#      あれば通す                → 欠票は判定をブロックしない
#   3. 有効票が 0、または無効な封筒（必須フィールド欠落・モデル不一致）があれば
#      「レビュー不成立」        → exit 3
#
# 3 は R-TH-13 のための規則である。経路が通らなかったレビューを「通った」と
# 言い換える余地を作らないため、不成立は成功（0）では返さない。ただし欠票の
# 存在そのものは差し戻し（1）とも区別する。どちらも非 0 なので DONE には進めない。
#
# review-log は G5（scripts/gate-check.mjs）が読む正本でもある。G5 は各エントリが
#   (a) model_id_actual / cli_version / backend を持つ finding 封筒、または
#   (b) reviewer_route=unavailable の欠票記録
# のどちらかであることを確かめる。本スクリプトはその形で書く。
#
# 使い方:
#   scripts/merge-review.sh <task_id> [--out <file>] [--round <n>] [--dry-run]
#                           [--root <dir>] <envelope.json>...
#
# 終了コード: 0 = pass / 1 = 差し戻し（high あり）/ 3 = レビュー不成立 / 64 = usage。

set -uo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/merge-review.sh <task_id> [--out <file>] [--round <n>] [--dry-run] [--root <dir>] <envelope.json>...

終了コード: 0 = pass / 1 = 差し戻し（high あり）/ 3 = レビュー不成立 / 64 = usage
EOF
  exit 64
}

for bin in jq node date; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "merge-review.sh: missing required dependency: $bin" >&2
    exit 69
  }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$SCRIPT_DIR/validate-findings.mjs"

[ "$#" -ge 1 ] || usage

TASK_ID="$1"
shift
case "$TASK_ID" in
  --*|*[!A-Za-z0-9_.-]*|"") usage ;;
esac

OUT=""
ROUND=1
DRY_RUN=0
ROOT=""
ENVELOPES=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      shift
      [ "$#" -ge 1 ] || usage
      OUT="$1"
      ;;
    --round)
      shift
      [ "$#" -ge 1 ] || usage
      ROUND="$1"
      case "$ROUND" in
        ''|*[!0-9]*) usage ;;
      esac
      ;;
    --root)
      shift
      [ "$#" -ge 1 ] || usage
      ROOT="$1"
      ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage ;;
    --*) usage ;;
    *) ENVELOPES+=("$1") ;;
  esac
  shift
done

[ "${#ENVELOPES[@]}" -ge 1 ] || usage

if [ -z "$ROOT" ]; then
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
if [ -z "$OUT" ]; then
  OUT="$ROOT/docs/review-log/${TASK_ID}.json"
fi

MERGED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

TMP_ENTRIES="$(mktemp)"
TMP_REPORT="$(mktemp)"
TMP_JSON="$(mktemp)"
cleanup() { rm -f "$TMP_ENTRIES" "$TMP_REPORT" "$TMP_JSON"; }
trap cleanup EXIT

echo "[]" > "$TMP_ENTRIES"

votes=0
missing_votes=0
invalid_envelopes=0
invalid_reviews=0
effective_high=0

for f in "${ENVELOPES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "merge-review.sh: 封筒が見つかりません: $f" >&2
    exit 64
  fi

  node "$VALIDATOR" "$f" --json ${ROOT:+--root "$ROOT"} > "$TMP_REPORT" 2>/dev/null
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then
    echo "merge-review.sh: validate-findings.mjs が usage エラーで終了しました（$f, exit $rc）" >&2
    exit 64
  fi
  if ! jq -e . "$TMP_REPORT" >/dev/null 2>&1; then
    echo "merge-review.sh: validate-findings.mjs の出力を JSON として読めません（$f）" >&2
    exit 64
  fi

  valid="$(jq -r '.valid' "$TMP_REPORT")"
  route="$(jq -r '.reviewer_route' "$TMP_REPORT")"
  vote="$(jq -r '.counts_as_vote' "$TMP_REPORT")"
  high="$(jq -r '.counts.high' "$TMP_REPORT")"

  if [ "$valid" != "true" ]; then
    classification="invalid"
    invalid_envelopes=$((invalid_envelopes + 1))
  elif [ "$route" = "unavailable" ]; then
    classification="missing_vote"
    missing_votes=$((missing_votes + 1))
  elif [ "$vote" != "true" ]; then
    # model_mismatch: 封筒としては読めるが、どのモデルが答えたか信用できない。
    classification="invalid_review"
    invalid_reviews=$((invalid_reviews + 1))
  else
    classification="vote"
    votes=$((votes + 1))
    effective_high=$((effective_high + high))
  fi

  jq \
    --slurpfile report "$TMP_REPORT" \
    --arg classification "$classification" \
    --arg source_file "$f" \
    --arg merged_at "$MERGED_AT" \
    --arg task_id "$TASK_ID" \
    --argjson round "$ROUND" \
    '. + [
       (($report[0].envelope // {}) + {
         task_id: (($report[0].envelope // {}).task_id // $task_id),
         classification: $classification,
         source_file: $source_file,
         merged_at: $merged_at,
         round: $round,
         validation: {
           valid: $report[0].valid,
           counts_as_vote: $report[0].counts_as_vote,
           errors: $report[0].errors,
           warnings: $report[0].warnings,
           downgrades: $report[0].downgrades,
           counts: $report[0].counts
         }
       })
     ]' "$TMP_ENTRIES" > "$TMP_JSON" && mv "$TMP_JSON" "$TMP_ENTRIES"
done

blocking_invalid=$((invalid_envelopes + invalid_reviews))

if [ "$effective_high" -gt 0 ]; then
  DECISION="reject"
  EXIT_CODE=1
elif [ "$votes" -eq 0 ] || [ "$blocking_invalid" -gt 0 ]; then
  DECISION="not_established"
  EXIT_CODE=3
else
  DECISION="pass"
  EXIT_CODE=0
fi

jq -n \
  --arg type "summary" \
  --arg task_id "$TASK_ID" \
  --arg merged_at "$MERGED_AT" \
  --arg decision "$DECISION" \
  --argjson round "$ROUND" \
  --argjson votes "$votes" \
  --argjson missing_votes "$missing_votes" \
  --argjson invalid_envelopes "$invalid_envelopes" \
  --argjson invalid_reviews "$invalid_reviews" \
  --argjson effective_high "$effective_high" \
  --argjson exit_code "$EXIT_CODE" \
  --argjson envelopes "$(printf '%s' "${#ENVELOPES[@]}")" \
  '{
     type: $type,
     task_id: $task_id,
     round: $round,
     merged_at: $merged_at,
     decision: $decision,
     envelopes: $envelopes,
     votes: $votes,
     missing_votes: $missing_votes,
     invalid_envelopes: $invalid_envelopes,
     invalid_reviews: $invalid_reviews,
     effective_high: $effective_high,
     exit_code: $exit_code
   }' > "$TMP_REPORT"

jq --slurpfile summary "$TMP_REPORT" '. + [$summary[0]]' "$TMP_ENTRIES" > "$TMP_JSON" \
  && mv "$TMP_JSON" "$TMP_ENTRIES"

if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$(dirname "$OUT")"
  if [ -f "$OUT" ] && jq -e 'type == "array"' "$OUT" >/dev/null 2>&1; then
    jq --slurpfile add "$TMP_ENTRIES" '. + $add[0]' "$OUT" > "$TMP_JSON" && mv "$TMP_JSON" "$OUT"
  else
    cp "$TMP_ENTRIES" "$OUT"
  fi
fi

printf 'merge-review: %s task=%s round=%s 有効票=%s 欠票=%s 無効封筒=%s 無効レビュー=%s 実効high=%s\n' \
  "$DECISION" "$TASK_ID" "$ROUND" "$votes" "$missing_votes" "$invalid_envelopes" "$invalid_reviews" "$effective_high"
if [ "$DRY_RUN" -eq 0 ]; then
  printf 'merge-review: review-log=%s\n' "$OUT"
else
  printf 'merge-review: --dry-run のため review-log は書いていません\n'
fi

exit "$EXIT_CODE"
