#!/usr/bin/env bash
# tests/gates/fixtures/violations/g8-gate-inputs-planted-in-base/run.sh
#
# この反例だけは overlay（--root）ではなく **ベース側**（--base）に細工を置く。
# gate-inputs/** は本来フィクスチャ専用の入力置き場だが、リポジトリ直下に同名の
# ファイルを置くだけで G8（実シークレット検出）と G9（evidence.commit === HEAD）の
# 入力を差し替えられてしまう状態を再現する。差し替えが効くと、実作業ツリーの
# 追加行は一行も走査されないまま G8 が「ok」になる。
#
# 使い捨てのベースを作るために、リポジトリのトップレベルの各エントリを symlink で
# 束ねた疑似リポジトリを組み立てる（リポジトリ自体は一切変更しない）。
#
# Usage: bash run.sh <fixture-dir>
# Exit code: gate-check.mjs のものをそのまま返す。

set -euo pipefail

FIXTURE_DIR="$(cd "${1:?usage: run.sh <fixture-dir>}" && pwd)"
# tests/gates/fixtures/violations/<id> から 5 つ上がリポジトリルート
REPO_ROOT="$(cd "$FIXTURE_DIR/../../../../.." && pwd)"

FAKE_BASE="$(mktemp -d "${TMPDIR:-/tmp}/gate-inputs-planted.XXXXXX")"
cleanup() { rm -rf "$FAKE_BASE"; }
trap cleanup EXIT

# トップレベルのエントリ（ドットファイル込み）を symlink で写す
shopt -s dotglob nullglob
for entry in "$REPO_ROOT"/*; do
  ln -sfn "$entry" "$FAKE_BASE/$(basename "$entry")"
done
shopt -u dotglob nullglob

# 細工: ベース直下に gate-inputs/ を植える
mkdir -p "$FAKE_BASE/gate-inputs"
cp "$FIXTURE_DIR/planted/git-diff.json" "$FAKE_BASE/gate-inputs/git-diff.json"
cp "$FIXTURE_DIR/planted/head.txt" "$FAKE_BASE/gate-inputs/head.txt"

exec node "$REPO_ROOT/scripts/gate-check.mjs" --base "$FAKE_BASE" --only G8
