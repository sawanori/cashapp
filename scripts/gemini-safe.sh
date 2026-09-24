#!/usr/bin/env bash
# scripts/gemini-safe.sh — gemini CLI の薄いラッパー（scripts/review-gemini.mjs の --cli に渡す）。
#
# 実測 2026-09-24（gemini CLI 0.38.1）: ヘッドレス（-p）実行でも stdin 本文全体を `@path` 添付構文
# として走査する。本文中の `@/` の直後が区切り文字（`,` `]` `)` `;` 引用符・空白・行末）だと path が
# `/` に解決され、ファイルシステムのルートを再帰走査して CPU 100% のまま 15 分以上返らない
# （`regex sample: [^@/]*$/ end` の 1 行入力で再現。`@` を抜いた同等入力は数秒で応答）。
# `@/lib/db` のように続きのあるものは存在しない相対パスとして即座に捨てられるので無害。
# レビュー封筒は正規表現やコードを含むため、この形を高確率で含む。
#
# ここでは危険な形（`@/` + 区切り or 行末）に限り `@` と `/` の間にゼロ幅スペース（U+200B）を挟んで
# から gemini に渡す。転送時だけの変換で、ディスク上の封筒（packet.json）は変更しない。置換件数は
# stderr に出す（review-gemini.mjs はノイズ以外の stderr を raw_warnings に転記する）。
# `--version` は素通しにして cli_version の観測（R-TH-11）を壊さない。
set -uo pipefail
if [ "${1:-}" = "--version" ]; then exec gemini --version; fi
TMP="$(mktemp "${TMPDIR:-/tmp}/gemini-safe.XXXXXX")"
cat > "$TMP"
N="$(grep -o '@/\([]),;"'"'"'`} 	]\|$\)' "$TMP" | wc -l | tr -d ' ')"
echo "gemini-safe: neutralized ${N} occurrence(s) of '@/' + delimiter (U+200B inserted for transport only)" >&2
perl -CSD -pe 's/@\/(?=[\s,\]\)\};"'"'"'`]|$)/@\x{200B}\//g' "$TMP" | gemini "$@"
RC=$?
rm -f "$TMP"
exit $RC
