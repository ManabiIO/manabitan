#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Verify preserved native metadata component proof without rerunning a corpus."""
from pathlib import Path
import hashlib
import json
import tarfile

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'artifact-hashes.json.txt').read_text())
summary = json.loads((root / 'summary.json.txt').read_text())
archive = root / manifest['archive']
raw = archive.read_bytes()
assert len(raw) == manifest['bytes']
assert hashlib.sha256(raw).hexdigest() == manifest['sha256']
expected = {item['path']: item for item in manifest['entries']}
with tarfile.open(archive, 'r:gz') as data:
    names = data.getnames()
    assert len(names) == len(set(names))
    assert set(names) == set(expected)
    members = {}
    for name in names:
        raw = data.extractfile(name).read()
        assert len(raw) == expected[name]['bytes']
        assert hashlib.sha256(raw).hexdigest() == expected[name]['sha256']
        members[name] = raw

assert hashlib.sha256(members['measured-replay.mjs']).hexdigest() == summary['runnerSha256']
rows = groups = 0
for item in summary['results']:
    raw = members[item['rawReport']]
    assert hashlib.sha256(raw).hexdigest() == item['rawSha256']
    report = json.loads(raw)
    assert report['complete'] is True
    assert report['runnerSha256'] == summary['runnerSha256']
    assert report['node'] == summary['node']
    assert report['grouping']['parserWorkers'] == item['workerPolicy']
    assert report['sources']['candidate']['git']['sha'] == summary['candidate']['localCommit']
    for arm in ('baseline', 'candidate'):
        hashes = report['sources'][arm]['hashes']
        assert hashes['ext/lib/term-bank-parser.wasm'] == summary[arm]['wasmSha256']
        assert hashes['dev/data/dictionary-wasm/term-bank-parser.wasm'] == summary[arm]['wasmSha256']
    result, = report['dictionaries']
    assert result['dictionary'] == item['dictionary']
    assert result['rows'] == item['rows']
    assert len(result['groups']) == item['groups']
    assert result['baseline'] == item['baseline']
    assert result['candidate'] == item['candidate']
    observed_rows = 0
    crc_bytes = 0
    for group in result['groups']:
        baseline, candidate = group['baseline'], group['candidate']
        for field in ('rows', 'digest', 'keys', 'nativePrepared', 'mediaRows',
                      'nativeSegments', 'nativeFallbacks', 'scratchReuseGroups',
                      'scratchReuseBytes', 'scratchReuseMisses', 'fusedAttempts',
                      'fusedFallbacks', 'crcScannedBytes', 'crcReusedBytes',
                      'crcReusedGlossaries'):
            assert baseline[field] == candidate[field], (item['rawReport'], field)
        assert candidate['nativePrepared'] is True
        assert candidate['scratchReuseGroups'] == 1
        for field in ('scratchReuseMisses', 'nativeFallbacks', 'fusedFallbacks'):
            assert candidate[field] == 0
        observed_rows += candidate['rows']
        crc_bytes += candidate['crcScannedBytes'] + candidate['crcReusedBytes']
    assert observed_rows == item['rows']
    if item['dictionary'] == 'vndb':
        assert crc_bytes == item['sourceBytes']
    rows += item['rows']
    groups += item['groups']
assert len(summary['results']) == 9
assert rows == summary['totalRowsComparedPerArm']
assert groups == summary['totalGroupsPerArm']
print(f'PASS: all raw hashes and nine complete component proofs; {rows:,} rows and {groups} groups per arm')
