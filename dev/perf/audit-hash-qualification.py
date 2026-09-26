#!/usr/bin/env python3
"""Pinned whole-import hash A/B experiment. Product source restored after each build."""
import hashlib
import io
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import zipfile

PIN = '384d1c97dae6bd17555973b77ad415e038438499'
root = Path(sys.argv[1]).resolve()
corpus = sys.argv[2]
out = Path(sys.argv[3]).resolve()
out.mkdir(parents=True, exist_ok=True)
os.chdir(root)

def run(args, name, timeout=900):
    with (out / f'{name}.log').open('w') as log:
        subprocess.run(args, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def put(name, value):
    (out / name).write_text(json.dumps(value, indent=2) + '\n')

head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
assert head == PIN, head
source = root / 'ext/js/dictionary/term-entry-content-hash.js'
original = source.read_text()
old = '''    let h1 = hashContentXxh32(bytes, 0x811c9dc5);
    const h2 = hashContentXxh32(bytes, 0x9e3779b9);'''
new = '''    let h1;
    let h2;
    if (bytes.length >= 512) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        h1 = hashContentXxh32View(bytes, view, 0x811c9dc5);
        h2 = hashContentXxh32View(bytes, view, 0x9e3779b9);
    } else {
        h1 = hashContentXxh32(bytes, 0x811c9dc5);
        h2 = hashContentXxh32(bytes, 0x9e3779b9);
    }'''
assert original.count(old) == 1
helper = original[original.index('function hashContentXxh32(bytes, seed) {'):]
helper = helper.replace('function hashContentXxh32(bytes, seed)', 'function hashContentXxh32View(bytes, view, seed)')
helper = helper.replace('readUint32Le(bytes, offset)', 'view.getUint32(offset, true)')
candidate = original.replace(old, new) + '''\n/**
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {number} seed
 * @returns {number}
 */
''' + helper
(out / 'hash-baseline.mjs').write_text(original)
(out / 'hash-candidate.mjs').write_text(candidate)
parity = '''import assert from 'node:assert/strict'
import {hashTermEntryContentBytesPair as a} from './hash-baseline.mjs'
import {hashTermEntryContentBytesPair as b} from './hash-candidate.mjs'
let cases = 0
for (const shared of [false, true]) {
 for (const size of [...Array(1050).keys(), 2048, 4096, 65535, 65536, 1048576]) {
  for (const offset of [0, 1, 3, 7, 15]) {
   const backing = shared ? new SharedArrayBuffer(size + offset + 17) : new ArrayBuffer(size + offset + 17)
   const all = new Uint8Array(backing)
   for (let i = 0; i < all.length; ++i) all[i] = (i * 131 + size * 7) & 255
   const copy = all.slice()
   const view = new Uint8Array(backing, offset, size)
   assert.deepEqual(b(view), a(view))
   assert.deepEqual(all, copy)
   ++cases
  }
 }
}
console.log(JSON.stringify({cases, status: 'success'}))
'''
(out / 'parity.mjs').write_text(parity)
run(['node', str(out / 'parity.mjs')], 'parity')
package = root / 'builds/manabitan-chrome-dev.zip'
packages = {}
try:
    for arm, text in [('A', original), ('B', candidate)]:
        source.write_text(text)
        run(['npm', 'run', 'build', '--', '--target', 'chrome-dev'], f'build-{arm}')
        packages[arm] = package.read_bytes()
finally:
    source.write_text(original)

with zipfile.ZipFile(io.BytesIO(packages['A'])) as a, zipfile.ZipFile(io.BytesIO(packages['B'])) as b:
    assert set(a.namelist()) == set(b.namelist())
    differences = [name for name in a.namelist() if a.read(name) != b.read(name)]
    assert len(differences) == 1 and differences[0].endswith('js/dictionary/term-entry-content-hash.js'), differences
put('identities.json', {'pin': PIN, 'corpus': corpus, 'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'sources': {'A': digest(original.encode()), 'B': digest(candidate.encode())},
    'packages': {k: digest(v) for k,v in packages.items()}, 'changedMembers': differences})

schedule = [('warmup', 0, 'A'), ('warmup', 0, 'B')]
for group in range(3):
    for control in range(2):
        pair = group * 2 + control
        schedule += [('AA', pair, 'A'), ('AA', pair, 'A')]
    for i in range(4):
        pair = group * 4 + i
        schedule += [('AB', pair, arm) for arm in ('AB' if pair % 2 == 0 else 'BA')]
put('schedule.json', schedule)
observations = []
for number, (kind, pair, arm) in enumerate(schedule):
    package.write_bytes(packages[arm])
    sample = out / f'{number:03}-{kind}-{pair:02}-{arm}'
    print(f'{corpus} {number+1}/{len(schedule)} {kind} pair={pair} arm={arm}', flush=True)
    run(['node', 'dev/perf/import-benchmark.js', corpus, '--runs', '1', '--no-build', '--output', str(sample)], f'sample-{number:03}')
    summary = json.loads((sample / 'summary.json').read_text())
    observation = summary['runs'][0]
    assert observation['totalImportMs'] > 0
    observations.append({'number': number, 'kind': kind, 'pair': pair, 'arm': arm,
                         'totalImportMs': observation['totalImportMs'], 'summary': str(sample.relative_to(out) / 'summary.json')})
    put('observations.json', observations)

results = {}
for kind in ('AB', 'AA'):
    pairs = []
    for pair in sorted({x['pair'] for x in observations if x['kind'] == kind}):
        rows = [x for x in observations if x['kind'] == kind and x['pair'] == pair]
        assert len(rows) == 2
        if kind == 'AB':
            rows.sort(key=lambda x:x['arm'])
        a,b = (x['totalImportMs'] for x in rows)
        pairs.append({'pair': pair, 'aMs': a, 'bMs': b, 'changePct': (b/a-1)*100})
    results[kind] = {'pairs': pairs, 'medianPairedPct': statistics.median(x['changePct'] for x in pairs),
      'medianAbsolutePct': statistics.median(abs(x['changePct']) for x in pairs),
      'fasterPairs': sum(x['changePct'] < 0 for x in pairs),
      'aMedianMs': statistics.median(x['aMs'] for x in pairs),
      'bMedianMs': statistics.median(x['bMs'] for x in pairs),
      'equalWorkPct': (sum(x['bMs'] for x in pairs)/sum(x['aMs'] for x in pairs)-1)*100}
put('results.json', results)

# Diagnostic traffic counting is excluded from all benchmark statistics.
instrumented = original.replace('export function hashTermEntryContentBytesPair(bytes) {', '''export function hashTermEntryContentBytesPair(bytes) {
    const stats = globalThis.__manabitanHashAudit ??= {shortCalls: 0, shortBytes: 0, longCalls: 0, longBytes: 0};
    if (bytes.length >= 512) { ++stats.longCalls; stats.longBytes += bytes.length; }
    else { ++stats.shortCalls; stats.shortBytes += bytes.length; }''')
importer = root / 'ext/js/dictionary/dictionary-importer.js'
importer_original = importer.read_text()
needle = "            recordPhaseTiming('bulk-finalization', tBulkFinalizationStart, bulkFinalizationPhaseDetails);"
assert importer_original.count(needle) == 1
try:
    source.write_text(instrumented)
    importer.write_text(importer_original.replace(needle, needle + "\n            recordPhaseTiming('hash-audit', Date.now(), {stats: globalThis.__manabitanHashAudit ?? null});"))
    run(['npm', 'run', 'build', '--', '--target', 'chrome-dev'], 'build-diagnostic')
    run(['node', 'dev/perf/import-benchmark.js', corpus, '--runs', '1', '--no-build', '--output', str(out / 'diagnostic')], 'diagnostic')
finally:
    source.write_text(original)
    importer.write_text(importer_original)
assert source.read_text() == original and importer.read_text() == importer_original
put('complete.json', {'status': 'success', 'measuredObservations': len(observations)-2, 'warmups': 2, 'diagnosticRuns': 1})
print(json.dumps(results, indent=2), flush=True)
