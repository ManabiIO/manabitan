#!/usr/bin/env bash
# Standalone reproduction of the frozen untimed Jitendex/VNDB metadata corpus gate.
# Requires Linux x64 Node v22.22.0 on PATH, Python 3, Git, npm and a fresh directory.
# The commands mirror the hosted workflow; this wrapper has not been executed locally.
set -euo pipefail
META_CORPUS="${1:?Pass jitendex or vndb}"
META_REPRO_ROOT="${2:?Pass a new absolute directory}"
case "$META_CORPUS" in jitendex|vndb) ;; *) exit 2 ;; esac
case "$META_REPRO_ROOT" in /*) ;; *) exit 2 ;; esac
mkdir "$META_REPRO_ROOT"
export META_TOOLING="$META_REPRO_ROOT/tooling"
export META_A="$META_REPRO_ROOT/source-a"
export META_B="$META_REPRO_ROOT/source-b"
export META_REPORTS="$META_REPRO_ROOT/reports"
export META_CACHE="$META_REPRO_ROOT/locked-archive"
export META_HELPER="$META_TOOLING/test/perf/signature1-corpus-verification"
export META_EVIDENCE="$META_TOOLING/builds/perf/20261128-4d9f-latest-metadata-legacy-context"
META_TOOLING_COMMIT=8ec2c45d182dd7615317e1675197aadd494ae964
META_NODE_SHA=1bec56ef7cfa9a76f3e0b7c0a87f220eb73f23102b9c0b4c7529a3f7c3ce7c31
mkdir "$META_REPORTS"

git clone --no-checkout https://github.com/ManabiIO/manabitan.git "$META_TOOLING"
git -C "$META_TOOLING" checkout --detach "$META_TOOLING_COMMIT"
git clone --no-hardlinks --no-checkout "$META_TOOLING" "$META_A"
git -C "$META_A" checkout --detach a300da36d00df8e353c5679b1528b50a1299b75f
git clone --no-hardlinks --no-checkout "$META_TOOLING" "$META_B"
git -C "$META_B" checkout --detach 86cd5c18d325488b0ecb04c552d1dc83567de9d2

set +e
python3 -c 'raise SystemExit(37)' 2>&1 | tee "$META_REPORTS/pipeline-negative-control.log"
meta_negative_exit=$?
set -e
test "$meta_negative_exit" -eq 37

python3 "$META_TOOLING/dev/perf/qualify-latest-metadata-legacy-context-4d9f.py" \
  --tooling "$META_TOOLING" --source-a "$META_A" --source-b "$META_B" \
  --corpus "$META_CORPUS" --cache "$META_CACHE" --reports "$META_REPORTS" \
  --expected-tooling-commit "$META_TOOLING_COMMIT" 2>&1 | tee "$META_REPORTS/preflight.log"

node --test "$META_HELPER/node-opfs-bounded.contract.mjs" \
  "$META_HELPER/metadata-oracle.contract.mjs" \
  "$META_HELPER/logical-record-ids.contract.mjs" 2>&1 | tee "$META_REPORTS/contracts.log"

for meta_source in "$META_A" "$META_B" "$META_TOOLING"; do
  meta_label="$(basename "$meta_source")"
  (
    cd "$meta_source"
    npm ci 2>&1 | tee "$META_REPORTS/npm-ci-$meta_label.log"
    npm run build:libs 2>&1 | tee "$META_REPORTS/build-libs-$meta_label.log"
  )
done
(
  cd "$META_TOOLING"
  npx eslint --max-warnings 0 \
    test/perf/signature1-corpus-verification/legacy-import-read-context.mjs \
    test/perf/signature1-corpus-verification/legacy-import-read-context.contract.mjs \
    test/perf/signature1-corpus-verification/run-with-legacy-context.mjs \
    test/perf/signature1-corpus-verification/compare-results-with-legacy-context.mjs \
    2>&1 | tee "$META_REPORTS/helper-lint.log"
)

MANABITAN_LEGACY_READ_SOURCE_ROOT="$META_A" \
MANABITAN_LEGACY_READ_SOURCE_COMMIT=a300da36d00df8e353c5679b1528b50a1299b75f \
  node --test "$META_HELPER/legacy-import-read-context.contract.mjs" \
  2>&1 | tee "$META_REPORTS/legacy-context-contracts-A.log"
MANABITAN_LEGACY_READ_SOURCE_ROOT="$META_B" \
MANABITAN_LEGACY_READ_SOURCE_COMMIT=86cd5c18d325488b0ecb04c552d1dc83567de9d2 \
  node --test "$META_HELPER/legacy-import-read-context.contract.mjs" \
  2>&1 | tee "$META_REPORTS/legacy-context-contracts-B.log"

set +e
python3 "$META_HELPER/launch-with-legacy-context.py" --node "$(command -v node)" \
  --source-root "$META_A" --source-id a300da36d00df8e353c5679b1528b50a1299b75f \
  --corpus "$META_CORPUS" --arm A --cache-dir "$META_CACHE" \
  --output "$META_REPORTS/$META_CORPUS-A-1" --evidence-dir "$META_EVIDENCE" \
  --node-sha256 "$META_NODE_SHA"
meta_a_exit=$?
python3 "$META_HELPER/launch-with-legacy-context.py" --node "$(command -v node)" \
  --source-root "$META_B" --source-id 86cd5c18d325488b0ecb04c552d1dc83567de9d2 \
  --corpus "$META_CORPUS" --arm B --cache-dir "$META_CACHE" \
  --output "$META_REPORTS/$META_CORPUS-B-1" --evidence-dir "$META_EVIDENCE" \
  --node-sha256 "$META_NODE_SHA"
meta_b_exit=$?
set -e
python3 -c 'import json, pathlib, sys; pathlib.Path(sys.argv[1]).write_text(json.dumps({"A": int(sys.argv[2]), "B": int(sys.argv[3])}, indent=2) + "\n")' \
  "$META_REPORTS/arm-exits.json" "$meta_a_exit" "$meta_b_exit"
test "$meta_a_exit" -eq 0
test "$meta_b_exit" -eq 0
node "$META_HELPER/compare-results-with-legacy-context.mjs" \
  "$META_REPORTS/$META_CORPUS-A-1" "$META_REPORTS/$META_CORPUS-B-1" \
  "$META_REPORTS/$META_CORPUS-comparison.json" --evidence-dir "$META_EVIDENCE" \
  2>&1 | tee "$META_REPORTS/comparison.log"
printf 'Retained reports: %s\n' "$META_REPORTS"
