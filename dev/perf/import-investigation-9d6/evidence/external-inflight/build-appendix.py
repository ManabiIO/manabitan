"""Package the completed independent audit; this performs no new measurements."""
import hashlib
import io
import json
from pathlib import Path
import platform
import sys
import tarfile
import zipfile

WORKSPACE = Path('/workspace/scratch/9d6dcf05cf8f/benchmark-setup')
OUTPUT = Path('/home/agent/manabitan-inflight-peer-9d6')
CELLS = [f'{dictionary}-host-{host}' for dictionary in ('jmdict', 'jitendex', 'vndb') for host in (1, 2)]
DIRECTORIES = {name: WORKSPACE / 'inflight-peer-whole' / name for name in CELLS}
DIRECTORIES['vndb-host-2'] = OUTPUT / 'vndb-host-2'
TEXT_SUFFIXES = {'.json', '.jsonl', '.py', '.mjs', '.js', '.yml', '.yaml', '.md', '.txt', '.log'}
sha = lambda data: hashlib.sha256(data).hexdigest()


def percent(value):
    return f'{value:+.3f}%'


def metric_cell(metric):
    low, high = metric['descriptiveBootstrap95Percent']
    return f"{percent(metric['medianPairedChangePercent'])} [{percent(low)}, {percent(high)}]"


def selected(name):
    return not name.endswith('.trace.json') and Path(name).suffix in TEXT_SUFFIXES


audits = {name: json.loads((directory / 'independent-audit.json').read_text()) for name, directory in DIRECTORIES.items()}
receipts = {name: json.loads((directory / 'download-receipt.json').read_text()) for name, directory in DIRECTORIES.items()}
disposition = json.loads((WORKSPACE / 'inflight-hosted/disposition.json').read_text())
assert disposition['peerQualification']['fullAcquisitionAudited'] is True
assert len(disposition['peerQualification']['completedAuditedCells']) == 6
assert sum(a['validatedReports'] for a in audits.values()) == 282
assert sum(a['memory']['rawScanCount'] for a in audits.values()) == 2098
assert all(a['complete'] and a['commandFailures'] == 0 for a in audits.values())
assert sum(a['memory']['passesProspectiveMemoryScreen'] for a in audits.values()) == 4
source_sets = {json.dumps(a['source'], sort_keys=True) for a in audits.values()}
assert len(source_sets) == 1

summary = {
    'schemaVersion': 1,
    'scope': 'Independent audit of an external candidate and its original six-cell hosted qualification. No new profiling, implementation, timing, rerun, threshold change or outlier exclusion.',
    'attribution': 'The runtime candidate b4d0f54e23f8d4065df33bd40f5ea299bad57c6b and run 46104891607 belong to a concurrent external in-flight study. This appendix is our independent review of that existing evidence, not a new optimization or measurement cohort.',
    'source': json.loads(next(iter(source_sets))),
    'runId': 46104891607,
    'lastWorkflowObservationUtc': '2026-11-28T05:57:03Z',
    'conclusion': disposition['peerQualification']['currentAssessment'],
    'recommendation': disposition['peerQualification']['endpointPrRecommendation'],
    'counts': disposition['peerQualification']['auditCounts'],
    'cells': audits,
    'correctness': json.loads((WORKSPACE / 'inflight-peer-whole/correctness-job-audit.json').read_text()),
}
(OUTPUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')

lines = [
    '# External in-flight import qualification: independent audit',
    '',
    '**No replicated complete-import gain was established for JMdict, Jitendex or VNDB.** Both VNDB hosts additionally failed the unchanged sampler coverage gate. Their results do not establish either increased or unchanged peak memory use.',
    '',
    'This is an independent review of the concurrent external runtime candidate `b4d0f54e23f8d4065df33bd40f5ea299bad57c6b`, not a new candidate or cohort. The original qualification is [run 46104891607](https://github.com/ManabiIO/manabitan/actions/runs/46104891607), tooling commit `154c06d0784c2d9b6d06fb0c22921d59acc95710`, against frozen baseline `9e10d3b3fcf66d344ab31bc42c9b522fa5215da2`. The separately developed in-flight component optimization was held because its observed production mechanism materially overlapped this external candidate. This completed endpoint evidence does not support reviving a duplicate PR.',
    '',
    '## Complete-import results',
    '',
    'Each cell contains 12 fixed balanced A/B/C blocks. A and C use the identical baseline package; B uses the candidate. Host 2 reverses each registered order. Every observation uses a fresh browser profile. Three registered warmups per cell precede the authoritative blocks. Percentages below are median paired changes; negative is faster. Brackets show the original descriptive 95% percentile bootstrap interval, independently reproduced with the frozen seed and algorithm. These are per-host results, with no pooling or control subtraction.',
    '',
    '| Dictionary / host | B/A | B/C | C/A control | Faster pairs B/A, B/C |',
    '|---|---:|---:|---:|---:|',
]
for name, a in audits.items():
    m = a['metrics']
    lines.append(f"| {a['dictionary']} / {a['replication']} | {metric_cell(m['B/A'])} | {metric_cell(m['B/C'])} | {percent(m['C/A']['medianPairedChangePercent'])} | {m['B/A']['fasterPairs']}/12, {m['B/C']['fasterPairs']}/12 |")
lines += [
    '',
    'JMdict changes direction between hosts: small favorable medians on host 1 and small unfavorable medians on host 2. Jitendex host 1 disagrees between controls, while host 2 is favorable. VNDB host 1 is unfavorable against both; host 2 disagrees between controls. No dictionary shows a replicated favorable result against both controls on both hosts.',
    '',
    'All tails remain. JMdict host 1 includes C/A blocks of −19.617%, −12.869% and +33.212%; host 2 includes a first-block C/A change of +16.105%. Equal-work totals and every individual ratio remain in `summary.json` and the per-cell audit files. No observation was removed and no replacement cohort was acquired.',
    '',
    '## Memory qualification',
    '',
    'All 24 separate memory imports completed and retained their raw scans. The unchanged auditor independently reproduced 2,098 scans. Both JMdict hosts and both Jitendex hosts passed the prospective PSS/private-memory screen: qualified coverage, median paired increase at most 5%, and every paired increase at most 10%.',
    '',
    '**The two VNDB failures are sampler coverage failures, not measured memory growth.** The registered maximum covered import scan gap is 250 ms. The failed observations below retain null maxima and null paired memory changes. They were not repaired, treated as zero, excluded, or rerun.',
    '',
    '| VNDB host | Observation | Maximum covered scan gap | Failure |',
    '|---|---|---:|---|',
]
for name in ('vndb-host-1', 'vndb-host-2'):
    for row in audits[name]['memoryObservationCoverage']:
        if not row['qualifiedForWholeTreePss']:
            assert row['qualificationFailures'] == ['covered-import-scan-gap-over-250ms']
            assert row['maxSampledPssKiB'] is None and row['maxSampledPrivateKiB'] is None
            lines.append(f"| {audits[name]['replication']} | {row['name']} | {row['maximumCoveredSampleGapMs']:.6f} ms | Coverage gap exceeds 250 ms |")
lines += [
    '',
    'VNDB host 1 has two qualified observations (A1 and B2), but neither complete A/B pair qualifies. Host 2 has no qualified observation. Both original failure records, complete failed-job logs, observations, comparisons and original raw scan data are included. The original driver correctly ended both jobs with failure after retaining every timing observation.',
    '',
    '## Lookup and correctness checks',
    '',
    'All 282 raw import reports passed independently recomputed semantic checks, including row/output digests, post-restart lookup results, storage identity, and the appropriate media checks. Twelve separate exhaustive-media imports cover both runtime arms on both hosts for each dictionary. In particular, every VNDB exhaustive pass checks all 146,570 media files (188,131,284 bytes); Jitendex checks all 236 files (4,992,155 bytes).',
    '',
    'First-pass timing is a separate diagnostic: the sum of 12 settings-page lookup RPCs after restart, followed by five warm passes. It is not part of import time, and no lookup improvement is claimed. Unfavorable directions remain visible. For example, JMdict host 1 first-pass medians are +59.791% versus A and +38.329% versus C, with both descriptive intervals crossing zero; the identical-code control median is −20.119% with a very wide interval. All six cells retain exact first-pass and warm-pass comparisons in their audits and `summary.json`.',
    '',
    'The separate correctness job `140855308314` checked the exact external runtime commit and passed scoped ESLint, all 670 unit-test files (15,159 tests passed, 47 skipped), both main/test TypeScript checks, and all seven dry build targets. The complete log and its SHA-256 receipt are included. Intentional negative-test stderr and dependency deprecation warnings remain in that log; the required job steps concluded success.',
    '',
    '## What was independently verified',
    '',
    'Each artifact was downloaded through the normal GitHub artifact interface and its complete ZIP size and SHA-256 verified against the API metadata before use. The audit then checked immutable source/tooling commits, frozen protocol and fixture lock, every package member, the sole runtime package difference (`js/dictionary/dictionary-database.js`), unchanged native assets, the exact 39-observation schedule, and all 130 recorded command outcomes per cell. It recomputed canonical receipts from the original ordinary/media/memory report JSON, separately checked trace-run semantics, reproduced the original paired statistics, and reran the unchanged memory auditor over the original scans. No new browser run, benchmark, trace or production change was made.',
    '',
    'Across six cells, this covers 216 authoritative timing imports, 18 fresh-profile warmups, 12 exhaustive-media imports, 24 separate memory imports and 12 diagnostic trace imports: 282 reports and 780 successful recorded commands. A successful semantic/identity audit is distinct from passing the memory qualification gate.',
    '',
    '## Artifact identities',
    '',
    '| Cell | Original GitHub artifact ID | ZIP bytes | SHA-256 |',
    '|---|---:|---:|---|',
]
for name, r in receipts.items():
    lines.append(f"| {name} | {r['artifact']['id']} | {r['verifiedBytes']} | `{r['verifiedSha256']}` |")
lines += [
    '',
    '## Appendix contents and reproduction limits',
    '',
    '`cells/<cell>/original/` retains every original JSON/JSONL report, canonical receipt, raw memory scan, command record/log and frozen workflow/protocol/helper text. The original failure files are retained. `cells/<cell>/audit/` contains the independent audit, verified download receipt, and SHA-256 inventory of every original artifact member. Shared audit scripts, the complete correctness log, final disposition, workflow API snapshot and this summary are included.',
    '',
    'The compact appendix omits only the two built product ZIPs, two large CPU-trace payloads and 47 rendered HTML duplicates per cell. Their complete original artifact and member hashes remain recorded in `source-map.json` and the per-cell inventories. Full verified ZIPs remain retained locally and identified by their original GitHub artifact IDs. The compact appendix therefore supports inspection/recalculation of timings and memory directly; independently repeating the original package-byte audit additionally requires those original full ZIPs. The included audit scripts are the exact scripts used and retain their recorded local checkout paths; adapting those paths for another machine does not change the frozen protocol or source identity checks.',
    '',
    'This appendix is separate from the earlier completed-study archives. It does not replace, amend or relabel prior receipts. `MANIFEST.json` records the size and SHA-256 of every included payload; the external publication receipt binds the completed archive itself.',
    '',
]
(OUTPUT / 'README.md').write_text('\n'.join(lines))

source_map = {'scope': 'All original text/JSON retained; only built packages, trace payloads and rendered HTML duplicates omitted.', 'artifacts': {}}
for name, directory in DIRECTORIES.items():
    r = receipts[name]
    inventory = json.loads((directory / 'artifact-files.json').read_text())
    with zipfile.ZipFile(r['localZip']) as z:
        files = [i for i in z.infolist() if not i.is_dir()]
        excluded = [i.filename for i in files if not selected(i.filename)]
        assert len(excluded) == 51
        assert sum(n.endswith('.html') for n in excluded) == 47
        assert sum(n.endswith('.trace.json') for n in excluded) == 2
        assert sum(n.endswith('.zip') for n in excluded) == 2
        source_map['artifacts'][name] = {
            'artifact': r['artifact'], 'verifiedBytes': r['verifiedBytes'], 'verifiedSha256': r['verifiedSha256'],
            'includedMembers': sum(selected(i.filename) for i in files),
            'excludedMembers': {n: inventory[n] for n in excluded},
        }
(OUTPUT / 'source-map.json').write_text(json.dumps(source_map, indent=2) + '\n')

payloads = []
archive = OUTPUT / 'external-inflight-qualification-46104891607.tar.xz'
with tarfile.open(archive, 'w:xz', preset=6) as tar:
    def add_bytes(name, data):
        assert name not in {p['path'] for p in payloads}
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = 0o644
        info.mtime = 0
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        tar.addfile(info, io.BytesIO(data))
        payloads.append({'path': name, 'bytes': len(data), 'sha256': sha(data)})

    for name, directory in DIRECTORIES.items():
        inventory = json.loads((directory / 'artifact-files.json').read_text())
        with zipfile.ZipFile(receipts[name]['localZip']) as z:
            for member in sorted(i.filename for i in z.infolist() if not i.is_dir() and selected(i.filename)):
                data = z.read(member)
                assert len(data) == inventory[member]['bytes'] and sha(data) == inventory[member]['sha256']
                add_bytes(f'cells/{name}/original/{member}', data)
        for file in sorted(directory.iterdir()):
            if file.is_file() and file.suffix in {'.json', '.log'}:
                add_bytes(f'cells/{name}/audit/{file.name}', file.read_bytes())

    local_files = {
        'README.md': OUTPUT / 'README.md',
        'summary.json': OUTPUT / 'summary.json',
        'source-map.json': OUTPUT / 'source-map.json',
        'workflow-status.json': OUTPUT / 'workflow-status.json',
        'independent/disposition.json': WORKSPACE / 'inflight-hosted/disposition.json',
        'independent/audit-inflight-peer-whole.py': WORKSPACE / 'audit-inflight-peer-whole.py',
        'independent/audit-inflight-peer-whole-v2.py': WORKSPACE / 'audit-inflight-peer-whole-v2.py',
        'independent/build-appendix.py': Path(__file__),
        'correctness/correctness-job-audit.json': WORKSPACE / 'inflight-peer-whole/correctness-job-audit.json',
        'correctness/correctness-job-140855308314.log': WORKSPACE / 'inflight-peer-whole/correctness-job-140855308314.log',
    }
    for file in sorted((WORKSPACE / 'inflight-peer-whole').glob('*audit.log')):
        local_files['independent/logs/' + file.name] = file
    local_files['independent/logs/vndb-host-2-audit.log'] = OUTPUT / 'vndb-host-2-audit.log'
    for name, path in sorted(local_files.items()):
        add_bytes(name, path.read_bytes())
    manifest = {'schemaVersion': 1, 'payloads': payloads.copy(), 'manifestExcludesItsOwnEntry': True}
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
    (OUTPUT / 'MANIFEST.json').write_bytes(manifest_bytes)
    add_bytes('MANIFEST.json', manifest_bytes)

expected = {entry['path']: entry for entry in payloads}
with tarfile.open(archive, 'r:xz') as tar:
    assert len(tar.getmembers()) == len(expected)
    for member in tar:
        data = tar.extractfile(member).read()
        assert len(data) == expected[member.name]['bytes']
        assert sha(data) == expected[member.name]['sha256']
with archive.open('rb') as f:
    archive_sha = hashlib.file_digest(f, 'sha256').hexdigest()
publication = {
    'schemaVersion': 1,
    'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': archive_sha,
    'payloadCountIncludingManifest': len(payloads),
    'uncompressedPayloadBytes': sum(p['bytes'] for p in payloads),
    'allArchiveMembersReadBackAndSha256Verified': True,
    'manifestPath': str(OUTPUT / 'MANIFEST.json'), 'manifestSha256': sha(manifest_bytes),
    'readmePath': str(OUTPUT / 'README.md'), 'readmeSha256': sha((OUTPUT / 'README.md').read_bytes()),
    'summaryPath': str(OUTPUT / 'summary.json'), 'summarySha256': sha((OUTPUT / 'summary.json').read_bytes()),
    'buildScriptSha256': sha(Path(__file__).read_bytes()),
    'pythonVersion': sys.version, 'platform': platform.platform(),
    'noNewMeasurements': True,
}
(OUTPUT / 'publication-manifest.json').write_text(json.dumps(publication, indent=2) + '\n')
print(json.dumps(publication, indent=2))
