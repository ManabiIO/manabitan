# Deep import replication

Baseline: `394d8eb799dd1eb5e194cee11472a4beab915080` (PR #20).
Two clean-runner replications of the composite-state parser and a separate single-probe reservation check.
No release branch is merged. Failed validation is not a performance result.
Negative percentages mean less whole-import time; independent hosts are not pooled.

## composite-1

72 measured imports; 6 separately retained warmups. Full Chromium: success.

| Dictionary | Baseline ms | Candidate ms | Paired change | Faster pairs | Exploratory 95% bootstrap interval |
|---|---:|---:|---:|---:|---:|
| jmdict | 1581.6 | 1569.8 | -0.58% | 8/12 | -1.58% to +0.79% |
| jmnedict | 1410.4 | 1427.6 | +0.42% | 5/12 | -1.96% to +1.54% |
| jitendex | 2849.5 | 2787.9 | -1.97% | 11/12 | -2.70% to -1.57% |

Intervals describe this experiment, not every browser or device. All planned pairs are retained.

## composite-2

72 measured imports; 6 separately retained warmups. Full Chromium: success.

| Dictionary | Baseline ms | Candidate ms | Paired change | Faster pairs | Exploratory 95% bootstrap interval |
|---|---:|---:|---:|---:|---:|
| jmdict | 1573.0 | 1535.2 | -1.92% | 11/12 | -4.12% to -0.86% |
| jmnedict | 1375.6 | 1389.6 | -0.14% | 6/12 | -2.06% to +3.16% |
| jitendex | 2791.4 | 2748.0 | -1.49% | 10/12 | -3.27% to -0.44% |

Intervals describe this experiment, not every browser or device. All planned pairs are retained.

## reserve-first

Validation did not establish a complete passing comparison. No speedup is inferred.

### unit.log

```text
}
{
  type: 'comment',
  comment: ' drop-shadow with 0.01px blur is at minimum required for Firefox to render the shadow when used on a canvas ',
  position: Position {
    start: { line: 147, column: 5 },
    end: { line: 147, column: 117 },
    source: undefined
  }
}

 ✓ test/css-json.test.js (2 tests) 18ms
 ✓ test/language/italian-processors.test.js (4 tests) 4ms
 ✓ test/language/ancient-greek-processors.test.js (1 test) 2ms
 ✓ test/popup-visibility.test.js (1 test) 4ms
 ✓ test/storage-controller.test.js (2 tests) 121ms
 ✓ test/language-transformer-cycles.test.js (18 tests) 24426ms
   ✓ Cycles Test 'fr' > Check for cycles 19365ms
   ✓ Cycles Test 'ko' > Check for cycles 4491ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/dictionary-database-reserve-first.test.js > reserve-first canonical deduplication > keeps exact byte verification for a published hash/signature match; unequal=false
 FAIL  test/dictionary-database-reserve-first.test.js > reserve-first canonical deduplication > keeps exact byte verification for a published hash/signature match; unequal=true
AssertionError: expected "_readTermEntryContentBytesDetailedBatch" to be called 1 times, but got 0 times
 ❯ test/dictionary-database-reserve-first.test.js:121:22
    119|         const input = chunkFor(database, [incoming], [10])
    120|         const result = await database._resolveArtifactTermContentDedup…
    121|         expect(read).toHaveBeenCalledTimes(1)
       |                      ^
    122|         expect(result.persistedHitCount).toBe(unequal ? 0 : 1)
    123|         expect(result.pendingContentCount).toBe(unequal ? 1 : 0)

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯


 Test Files  1 failed | 151 passed (152)
      Tests  2 failed | 5394 passed | 46 skipped (5442)
   Start at  01:29:08
   Duration  38.00s (transform 3.96s, setup 823ms, collect 21.67s, tests 43.95s, environment 329ms, prepare 10.43s)


::error file=/home/runner/work/_temp/arms/candidate/test/dictionary-database-reserve-first.test.js,title=test/dictionary-database-reserve-first.test.js > reserve-first canonical deduplication > keeps exact byte verification for a published hash/signature match; unequal=false,line=121,column=22::AssertionError: expected "_readTermEntryContentBytesDetailedBatch" to be called 1 times, but got 0 times%0A ❯ test/dictionary-database-reserve-first.test.js:121:22%0A%0A

::error file=/home/runner/work/_temp/arms/candidate/test/dictionary-database-reserve-first.test.js,title=test/dictionary-database-reserve-first.test.js > reserve-first canonical deduplication > keeps exact byte verification for a published hash/signature match; unequal=true,line=121,column=22::AssertionError: expected "_readTermEntryContentBytesDetailedBatch" to be called 1 times, but got 0 times%0A ❯ test/dictionary-database-reserve-first.test.js:121:22%0A%0A
```

### build-candidate.log

```text
Version: 0.0.0.0...
Building chrome-dev...

Restoring manifest...
```

## Decision boundary

The Jitendex direction repeated under the predefined descriptive screen.
The screen requires identical source trees, no dictionary above +1% paired median, and at least 9/12 faster Jitendex pairs on each host. It is not a universal non-regression guarantee or release approval.

Raw logs, each individual browser report, original patches, source hashes, and failed attempts are in this workflow’s artifacts. These checked-in patches contain no dictionary data, fonts, dependencies, or generated binaries.

