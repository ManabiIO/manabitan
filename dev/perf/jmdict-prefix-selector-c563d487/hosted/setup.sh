#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$OUTPUT_ROOT"
git fetch --no-tags origin "$BASE_SHA"
git worktree add --detach "$BASE_ROOT" "$BASE_SHA"
git worktree add --detach "$CANDIDATE_ROOT" "$BASE_SHA"
cp -a node_modules "$BASE_ROOT/node_modules"
cp -a node_modules "$CANDIDATE_ROOT/node_modules"
npm --prefix "$BASE_ROOT" run build:libs
git -C "$CANDIDATE_ROOT" apply --check "$GITHUB_WORKSPACE/$TOOL_ROOT/candidate.patch"
git -C "$CANDIDATE_ROOT" apply "$GITHUB_WORKSPACE/$TOOL_ROOT/candidate.patch"
npm --prefix "$CANDIDATE_ROOT" run build:dictionary-wasm -- --write
npm --prefix "$CANDIDATE_ROOT" run build:libs
npm --prefix "$CANDIDATE_ROOT" run build:dictionary-wasm -- --check
git -C "$CANDIDATE_ROOT" diff --binary > "$OUTPUT_ROOT/rebuilt-candidate.diff"
cp "$GITHUB_WORKSPACE/$TOOL_ROOT/../qualification/term-bank-prefix-selector-fixtures.js" "$CANDIDATE_ROOT/test/"
cp "$GITHUB_WORKSPACE/$TOOL_ROOT/../qualification/term-bank-prefix-selector-reuse.test.js" "$CANDIDATE_ROOT/test/"
python3 "$TOOL_ROOT/prepare.py" "$CANDIDATE_ROOT" "$OUTPUT_ROOT"
