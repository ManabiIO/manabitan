#!/usr/bin/env bash
set -u

# Run one corpus at a time. Output argument 4 names the final JSON receipt;
# all progress, exit status, and per-group checkpoints remain beside it.
if [ "$#" -ne 5 ]; then
    printf 'Usage: %s PARENT CANDIDATE CACHE OUTPUT DICTIONARY\n' "$0" >&2
    exit 2
fi

metadata_output=$4
mkdir -p "$(dirname "$metadata_output")"
timeout --signal=TERM --kill-after=30s 600s \
    "${MANABITAN_PERF_NODE:-node}" --expose-gc --max-old-space-size=256 \
    "$(dirname "$0")/replay.mjs" "$@" > "$metadata_output.log" 2>&1
metadata_status=$?
printf '%s\n' "$metadata_status" > "$metadata_output.exit"
exit "$metadata_status"
