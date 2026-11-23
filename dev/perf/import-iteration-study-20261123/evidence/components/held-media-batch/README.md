# Held media batch-count experiment

This earlier screen changed `RAW_ZIP_BATCH_MAX_FILES` from 1024 to 4096 against `5e1f8c12f7ff798ba407323aff675cb23b22af02`. The patch was not committed or shipped. It remains held: the four paired component observations were mixed, with median paired time change **+0.1058%**. No speed improvement is claimed.

The source-media packing replay reduced range reads from 144 to 46 and bytes read from 205,086,922 to 198,664,492. Complete packed payload, record and index hashes matched; the injected CRC error also matched. The byte caps stayed unchanged, but the global count change also expands fallback batches. These results cover source-media preparation, not full import completion.

All original runners, observations, results, error receipts and the exact one-line patch are preserved. Patch SHA-256: `87e0736accb7a25704a07197ab2189a9bdaa030e2434f9ae85eef635f7b0964c`.

## Reproduction

Use Node 24.22.3 and the pinned VNDB archive specified in `../media/README.md`. Create two isolated checkouts at `5e1f8c12f7ff798ba407323aff675cb23b22af02`; apply `candidate.patch` only to the candidate checkout. Install locked dependencies and build library assets in both. The original candidate path was later reused for the pooled-media experiment, so its current contents must not be substituted for this patch.

```sh
evidence=/absolute/path/to/round2-component-evidence
baseline=/absolute/path/to/baseline-at-5e1f8c-checkout
candidate=/absolute/path/to/separate-baseline-plus-batch-patch-checkout
archive=/absolute/path/to/vndb_characters_by_bee.zip
batch_output=/absolute/path/to/new-held-batch-reproduction-directory

python3 "$evidence/media/prepare-reproduction.py" \
    --variant held-batch --baseline "$baseline" --candidate "$candidate" \
    --archive "$archive" --output "$batch_output"
python3 "$batch_output/run.py"
```

The preparer verifies the candidate against the patch's Git blob identities, the archive hash, and parser Wasm before adapting paths into new runner copies. The original four-pair schedule, byte/error oracles, and original receipts are unchanged.
