#!/usr/bin/env python3
"""Package the previously frozen phase2B input set; no product execution.

Requires INPUT-FREEZE.json, its private captured input directory, and the six
already-copied unchanged raw archives. Never discovers later outcome files or
regenerates summaries. Published checkpoints use the standalone verifier.
"""
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
PROF = Path(__file__).resolve().parent
OUT = PROF / 'checkpoint-phase2b'
REPO = 'dev/perf/import-optimization-9bb32/phase2b'


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def main():
    module = importlib.util.spec_from_file_location('checkpoint_integrity', PROF / 'verify-phase2b-checkpoint.py')
    verifier = importlib.util.module_from_spec(module)
    module.loader.exec_module(verifier)
    identity, check, require = verifier.identity, verifier.check_identity, verifier.require
    frozen_bytes = (OUT / 'INPUT-FREEZE.json').read_bytes()
    freeze = json.loads(frozen_bytes)
    require(identity(frozen_bytes)['sha256'] == '29db58073ed1aef1cf33c165a342db43311f0cb133d7b85ab246cb26d6f0e87f', 'Frozen scope changed')
    input_root = Path(freeze['frozenProofInputRoot'])
    files, proof_rows = {}, []
    for item in freeze['proofInputs']:
        name = item['path']
        verifier.safe_name(name)
        data = (input_root / name).read_bytes()
        check(data, item, name)
        require(name not in files, 'Duplicate proof input')
        files[name] = data
        proof_rows.append({'path': name, **identity(data), 'originalPath': item['localPath'],
                           **{k: item[k] for k in ('sourceCommit', 'sourceTree', 'repositoryPath') if k in item}})

    def data_json(name):
        return json.loads(files[name])

    cells = []
    for frozen_cell in freeze['cellInputs']:
        cell = frozen_cell['cell']
        prefix = 'profiling/hosted-qualification/minsize/' + cell + '/'
        retention = data_json(prefix + 'retention-manifest.json')
        audit = data_json(prefix + 'independent-semantics-memory-audit.json')
        analysis = data_json(prefix + 'audit-and-stage-analysis.json')
        github = data_json(prefix + 'github-artifact.json')
        archive = OUT / frozen_cell['proposedArchiveName']
        archive_bytes = archive.read_bytes()
        check(archive_bytes, frozen_cell['archiveIdentity'], cell)
        check(archive_bytes, retention['retainedArchive'], cell)
        require(analysis['checksPassed'] and audit['passed'] and analysis['allImportCount'] == 42, 'Incomplete minsize cell')
        cells.append({
            'cell': cell, 'publicationName': archive.name, **identity(archive_bytes),
            'sourceArtifact': retention['sourceArtifact'], 'githubArtifactUrl': github['url'],
            'artifactExpiresAt': github['expires_at'], 'proofDirectory': prefix.rstrip('/'),
            'includedOriginalFiles': len(retention['included']), 'derivedFiles': len(retention['derived']),
            'omittedOriginalPayloads': len(retention['omittedRedundant']),
            'allImportCount': analysis['allImportCount'], 'sourceNativeStageChecks': analysis['checkCount'],
            'independentChecks': audit['checkCount'], 'rawMemoryScans': audit['memorySummary']['rawScanCount'],
            'memorySummary': audit['memorySummary'], 'frozenHarnessAnalysis': analysis['frozenHarnessAnalysis'],
            'rawArchiveRepacked': False,
        })
    require(len(cells) == 6 and sum(c['allImportCount'] for c in cells) == 252, 'Incomplete cell set')
    require(sum(c['rawMemoryScans'] for c in cells) == 2152, 'Memory count changed')
    decisions = data_json('profiling/import-experiment-summary/DECISIONS.json')
    require(decisions['decisions']['minsize']['decision'] == 'shelved-no-pr', 'Unexpected frozen decision')
    publication = data_json('profiling/jmdict-group-diagnostic/remote-publication.json')
    phase2a_members = []
    for r in freeze['priorMemberDependencies']:
        phase2a_members.append({'member': r['member'], 'bytes': r['bytes'], 'sha256': r['sha256'],
                               'gitBlobSha1': r['gitBlobSha1']})
    trace_review = data_json('profiling/jmdict-cross-group-trace-review.json')
    phase1_members = [{'member': trace_review[k]['path'], 'bytes': trace_review[k]['bytes'],
                      'sha256': trace_review[k]['sha256']} for k in ('trace', 'report')]
    dependencies = {
        'schemaVersion': 1, 'asOfUtc': freeze['asOfUtc'],
        'policy': 'No prior archive payload is copied. Immutable parent archive identities and exact member locators bind reused evidence.',
        'phase1': {**freeze['priorCheckpoints']['phase1'],
                   'archive': freeze['priorCheckpoints']['phase1']['archiveIdentity'], 'members': phase1_members},
        'phase2a': {**freeze['priorCheckpoints']['phase2a'],
                    'archive': {'name': 'proofs-and-sources.tar.gz', 'bytes': 1092904,
                                'sha256': 'c00ef090f0e0177361f78306b29b3beb4824b766c9d787fbaea83079a9c8ffc1',
                                'gitBlobSha1': 'e3246934cf6bd8c21f2fd32b7d259cea31544f4c'},
                    'members': phase2a_members},
        'repositorySourceDependency': {'repository': 'ManabiIO/manabitan', 'baselineCommit': freeze['baseCommit'],
                                       'scope': 'Baseline JS/C and build/harness sources remain recoverable from this immutable Git commit. No code execution is required for checkpoint byte verification.'},
    }
    status = {
        'schemaVersion': 1, 'asOfUtc': freeze['asOfUtc'],
        'purpose': 'As-of phase2B evidence checkpoint; packaging only, no new acquisition or product change',
        'baselineCommit': freeze['baseCommit'], 'parentEvidenceCommit': freeze['parentEvidenceCommit'],
        'assemblyStatus': 'Packaged; independent checkpoint review/publication are separate later receipts',
        'minsize': {'source': '2907ba1bad0958c22fe363f88d7cceb4d4bc604e', 'qualificationRun': 46104898097,
                    'workflowCommit': '0c2a8a75cd0322cc13348b977a7e915b555d5a88',
                    'sourceQaRun': 46104779877, 'sourceQa': 'PASS; raw log/receipt reused through immutable phase2A dependencies',
                    'completeCells': 6, 'totalImports': 252, 'rawMemoryScans': 2152, 'qualifiedMemoryCohorts': 5,
                    'decision': decisions['decisions']['minsize'],
                    'memoryFailure': 'VNDB AB failed frozen sampling coverage in both arms; null comparison metrics and all scans retained. This is not proof of increased memory use.'},
        'fingerprint': {'scope': 'Completed evidence remains in phase2A; unchanged root decision projection retained here',
                        'decision': decisions['decisions']['fingerprint']},
        'wideKeyword': {'source': 'ebf4278afc59d83f191692bd587f0e1f7e8682b3', 'qualificationRun': 46112384728,
                        'workflowCommit': '2720d950c2f0bad612e3611f14951eb0e092c5db',
                        'sourceQaRun': 46110109833, 'untimedParityRun': 46111036970,
                        'decision': decisions['decisions']['wide'], 'parallelSchedulingWaivesNoGate': True,
                        'outcomePayloadsIncluded': False},
        'coordinatorDiagnostic': {'source': publication['publishedCommit'], 'tree': publication['tree'],
                                  'runId': publication['runId'], 'fixedSlots': [1, 2, 3],
                                  'purpose': 'Coordinator-observed dependency order only; no relative-speed or removable-duration claim',
                                  'sourceSpecHistoryAndRemoteAlignmentIncluded': True, 'outcomePayloadsIncluded': False},
        'pendingOutcomes': freeze['pendingOutcomes'], 'pendingOutcomePayloadsIncluded': False,
        'pullRequestsCreatedByThisTask': decisions['pullRequestsCreated'],
        'runtimeVersions': {'hostedQaAndQualification': 'Node 22.22.0', 'separatePendingHostedParity': 'Node 24.20.0',
                            'priorLocalComponentScreens': 'Node 24.20.0'},
        'limits': ['Correctness or reproduced audit passes do not establish a speed gain',
                   'Persisted lookup receipts are sampled; full parser-output parity has a different scope',
                   'Sampled process-tree PSS/private is not a guaranteed absolute peak; failed coverage is not a measured regression',
                   'Internal stage durations overlap and do not isolate CPU cost',
                   'No wide or coordinator outcome is inferred from queued status; later evidence is additive'],
    }
    cell_index = {'schemaVersion': 1, 'asOfUtc': freeze['asOfUtc'], 'scope': 'All six fixed minsize cohorts; no observations removed, replaced or repeated',
                  'allImportCount': 252, 'rawMemoryScans': 2152, 'cells': cells,
                  'decision': 'Shelved; no reproducible full-import gain; no PR',
                  'timingPolicy': 'Use the unchanged root RESULTS projection; independent initial-order cohorts are not pooled'}
    exclusions = {
        'schemaVersion': 1, 'asOfUtc': freeze['asOfUtc'],
        'pendingOutcomes': freeze['pendingOutcomes'], 'pendingPayloadPolicy': 'Excluded because pending at this snapshot, not because of their results; retain later as separate evidence',
        'originalArtifactPayloads': {'perCell': '42 duplicate HTML renderings and two product ZIP payloads omitted only after original ZIP and both packages/all members were hashed and verified',
                                     'retained': 'All 269 original JSON/JSONL/log/protocol JS files plus derived-package-audit.json per cell',
                                     'receipts': 'Each cell retention-manifest.json lists every included, omitted and derived member size/SHA256 and original GitHub artifact identity',
                                     'verificationLimit': 'This checkpoint can rehash retained bytes and check omission receipts. It cannot rehash absent original ZIP/HTML/package payloads.'},
        'otherExcludedPayloads': ['Dictionary corpus binaries, compiler/runtime distributions, node_modules, browser executables, reproducible cache files',
                                  'Already-published phase1/phase2A archive payloads; immutable archive/member dependency locators retained instead'],
        'observationExclusions': [], 'failedOrUnqualifiedObservationsRemoved': False,
    }
    readme = f'''# Manabitan import optimization — phase2B checkpoint

This is an evidence snapshot as of **{freeze['asOfUtc']}**. It adds all six
completed composite-parser `minsize` cohorts and their audits, the exact root
results and decisions, pending wide-keyword scheduling/publication evidence,
and the frozen coordinator diagnostic source/specification/history. It changes
no product code, benchmark protocol, observation, or decision. Phase1 and
phase2A remain immutable.

## Review the conclusions directly

[RESULTS.md](RESULTS.md) and [DECISIONS.json](DECISIONS.json) are byte-for-byte
copies of the root's frozen projections, also present inside the proof archive.
Their original projection timestamps remain unchanged; the later checkpoint
timestamp does not imply that pending work completed.

The minsize candidate is **shelved with no PR**. Its two JMdict cohorts point in
opposite directions, both Jitendex cohorts point slower, and VNDB does not
replicate an import-speed improvement. All **252 prescribed imports** and
**2,152 raw memory scans** remain retained. Five memory cohorts qualify.
VNDB AB separately fails the frozen sampling-coverage condition in both arms;
its comparison fields remain null. That failure is not evidence of increased
memory use. The prior fingerprint candidate also remains shelved; its complete
raw evidence is in phase2A, and the unchanged decision is visible in the direct
root projection here.

The wide-keyword candidate's source QA, full-parser corpus parity and six-cell
qualification remain **pending** in this snapshot. The qualification was
prospectively scheduled in parallel with its correctness gates; no acceptance
gate was waived. No pending outcome payload is included or inferred. The
coordinator diagnostic is also queued: its three fixed observations will study
existing dependency order and cannot support a relative-speed claim.

## Contents and provenance

| Item | Scope |
|---|---|
| `minsize-*.raw-evidence.tar.gz` | Six existing raw cell archives, copied unchanged. Each retains 269 original JSON/JSONL/log/protocol files and one derived package audit. |
| `proofs-and-sources.tar.gz` | {len(files)} frozen proof/source files, including independent audits, scheduling/publication receipts, synthesis, original preparation history, all nine diagnostic source files and superseded prospective failure policies. |
| `CELL-INDEX.json` | Original artifact/run/job IDs, artifact digests, cell archive identities, audit counts and memory qualification scope. |
| `INPUT-FREEZE.json` | Exact input hashes and as-of scope, captured before packaging; its initial packaging-pending label is historical. |
| `PROOF-INVENTORY.json` / `INVENTORY.json` | Complete member and outer-file byte lengths, SHA256 and Git blob identities. The containing Git tree authenticates the inventory's own bytes. |
| `DEPENDENCIES.json` | Exact immutable phase1/phase2A archive and member locators; no duplicate prior archive bytes. |
| `STATUS.json` / `EXCLUSIONS.json` | Complete versus pending outcomes, omitted duplicate payloads and limits. |

The six minsize cohorts use baseline
`9e10d3b3fcf66d344ab31bc42c9b522fa5215da2` and candidate
`2907ba1bad0958c22fe363f88d7cceb4d4bc604e`, qualification run
`46104898097`, workflow commit
`0c2a8a75cd0322cc13348b977a7e915b555d5a88`. Source QA passed at the same
candidate: pinned native regeneration, 380 focused cases, JavaScript lint,
four TypeScript projects, 669 unit files / 15,135 passes / 47 skips, and all-target
dry build. That original log and receipt are bound through phase2A dependencies.

The diagnostic source is frozen at remote commit
`{publication['publishedCommit']}` and tree `{publication['tree']}`.
Its five observer files, driver, extractor, specification and workflow match
the independent source review and the verified remote blobs. The original
review, two superseded prospective driver/spec policies, supplemental approval,
local/remote identities and final same-tree alignment receipt are retained.
No diagnostic observation existed when its fail-stop policy was finalized.

The earlier preparation files describe a broader future checkpoint with twelve
cohort archives and missing outcomes. They are retained as **preparation
history**, not the scope of this snapshot. `INPUT-FREEZE.json` and this README
define the selected six-cell as-of snapshot. Later wide, parity, QA and
coordinator outcomes must be saved additively.

## What was verified before payload omission

Each original GitHub artifact ZIP was hash-verified. Both nested product ZIPs
and every one of their 554 members per arm were rehashed, and the exact two
allowed package differences were checked: parser C source and parser WASM.
Only the 42 duplicate HTML renderings and two product ZIP payloads per cell
were then omitted. Their complete size/digest records and actual package-member
proofs remain. No raw JSON, JSONL, log, failure, memory scan or prescribed import
was removed, and no observation was rerun to replace an unfavorable result.

The checkpoint verifier rehashes retained bytes and checks those original
receipts for consistency. It does **not** claim to rehash omitted payloads or to
reproduce a browser measurement.

## Verification and reproduction limits

From this directory, run:

```sh
python verify-phase2b-checkpoint.py . --phase2a ../phase2a/proofs-and-sources.tar.gz --phase1 ../phase1/checkpoint-phase1.tar.gz
```

An optional `--repack /new/absent/path.tar.gz` rebuilds the proof archive from
retained member bytes and requires an identical hash. The six raw cell archives
are verified as existing lossless archives and are never repacked. The builder
records how the original frozen workspace inputs were assembled; it never
discovers later results or executes product code.

Hosted QA/browser qualification used Node 22.22.0. The separately queued hosted
full-parser parity plan uses Node 24.20.0; earlier local component receipts also
use their recorded Node 24.20.0 runtime. Do not reinterpret one runtime as the
other or rerun failed local attempts.

Browser semantic receipts cover counts, normalized storage, restart, twelve
fixed lookup terms over six passes and separate all-referenced-media checks.
They do not establish exhaustive persisted-row equality. Full parser-output
digests have a different scope. Memory is sampled process-tree PSS/private,
not a guaranteed absolute peak. Stage timers overlap. Audit/correctness passes,
static code-size changes and coordinator-observed windows are not speedup
evidence. The complete, separate cohort results and the unchanged root decisions
govern promotion; **no product PR has been created by this task**.
'''
    generated = {
        'README.md': readme.encode(), 'STATUS.json': encoded(status), 'CELL-INDEX.json': encoded(cell_index),
        'DEPENDENCIES.json': encoded(dependencies), 'EXCLUSIONS.json': encoded(exclusions),
        'PROOF-INVENTORY.json': encoded({'schemaVersion': 1, 'asOfUtc': freeze['asOfUtc'], 'files': proof_rows,
                                       'scope': 'Exact frozen input members only; outer checkpoint metadata is not duplicated inside the proof archive'}),
        'build-phase2b-checkpoint.py': Path(__file__).read_bytes(),
        'verify-phase2b-checkpoint.py': (PROF / 'verify-phase2b-checkpoint.py').read_bytes(),
    }
    for name, member in freeze['directOuterProjections'].items():
        generated[name] = files[member]
    for name in generated:
        require(not (OUT / name).exists(), 'Generated output already exists: ' + name)
    require(not (OUT / 'proofs-and-sources.tar.gz').exists(), 'Proof archive already exists')
    for name, data in generated.items():
        with (OUT / name).open('xb') as stream:
            stream.write(data)
    verifier.pack(OUT / 'proofs-and-sources.tar.gz', files)
    packaging = {'schemaVersion': 1, 'asOfUtc': freeze['asOfUtc'], 'proofArchive': identity((OUT / 'proofs-and-sources.tar.gz').read_bytes()),
                 'proofMembers': len(files), 'proofUncompressedBytes': sum(len(b) for b in files.values()),
                 'rawArchivesCopiedByteForByte': 6, 'rawArchivesRepacked': False,
                 'determinism': {'gzipMtime': 0, 'gzipFilename': '', 'compressionLevel': 9, 'tarFormat': 'PAX',
                                 'memberOrder': 'sorted path', 'mode': '0644', 'uid': 0, 'gid': 0, 'mtime': 0, 'userGroupNames': ''}}
    with (OUT / 'PACKAGING.json').open('xb') as stream:
        stream.write(encoded(packaging))
    rows = []
    for path in sorted(OUT.iterdir()):
        require(path.is_file() and not path.is_symlink(), 'Unexpected output entry')
        rows.append({'name': path.name, **identity(path.read_bytes()), 'proposedRepositoryPath': REPO + '/' + path.name})
    inventory = {'schemaVersion': 1, 'asOfUtc': freeze['asOfUtc'], 'repositoryDirectory': REPO, 'files': rows,
                 'selfExcluded': 'INVENTORY.json; authenticated by containing Git tree and external publication manifest'}
    with (OUT / 'INVENTORY.json').open('xb') as stream:
        stream.write(encoded(inventory))
    publication_rows = [{**row, 'localPath': str(OUT / row['name'])} for row in rows]
    publication_rows.append({'name': 'INVENTORY.json', **identity((OUT / 'INVENTORY.json').read_bytes()),
                             'localPath': str(OUT / 'INVENTORY.json'), 'proposedRepositoryPath': REPO + '/INVENTORY.json'})
    publication = {'schemaVersion': 1, 'asOfUtc': freeze['asOfUtc'], 'publicationAuthorized': False,
                   'parentEvidenceCommit': freeze['parentEvidenceCommit'], 'repositoryDirectory': REPO,
                   'files': sorted(publication_rows, key=lambda row: row['name'])}
    publication_path = PROF / 'checkpoint-phase2b-publication-files.json'
    with publication_path.open('xb') as stream:
        stream.write(encoded(publication))
    print(json.dumps({'checkpoint': str(OUT), 'outerFiles': len(publication_rows), 'proofMembers': len(files),
                      'proofArchive': packaging['proofArchive'], 'publicationManifest': identity(publication_path.read_bytes())}, indent=2))


if __name__ == '__main__':
    main()
