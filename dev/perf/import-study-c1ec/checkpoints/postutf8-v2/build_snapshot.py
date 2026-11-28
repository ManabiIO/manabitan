#!/usr/bin/env python3
"""Create one immutable checkpoint from retained evidence; no experiment runs."""
from __future__ import annotations

from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

if not __debug__:
    raise RuntimeError('Assertions are required for archive creation')
sys.dont_write_bytecode = True
ROOT = Path('/workspace/scratch/c1ec33aeb201')
REPO = ROOT / 'manabitan'
OUT = Path(__file__).resolve().parent
OLD = ROOT / 'profile-evidence/archive-snapshot-c1ec-precomponent-v1'
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MIN_FREE_BYTES = 24 * 1024 * 1024
assert not (OUT / 'payload.tar.gz').exists() and not (OUT / 'manifest.json').exists(), 'Never overwrite a checkpoint'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2) + '\n').encode()


def load(relative):
    return json.loads((ROOT / relative).read_text())


def file_sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def git(*args, data=None):
    return subprocess.check_output(['git', '-C', str(REPO), *args], input=data,
        env={**os.environ, 'GIT_NO_LAZY_FETCH': '1', 'GIT_TERMINAL_PROMPT': '0'}, timeout=30)


files, payloads, excluded = {}, {}, []


def add_bytes(name, data, groups, original=None):
    assert not name.startswith('/') and '..' not in Path(name).parts
    assert len(data) < 24 * 1024 * 1024, name
    if name in payloads:
        assert payloads[name] == data, f'Input changed while freezing: {name}'
        files[name]['groups'] = sorted(set(files[name]['groups']) | set(groups))
        return
    files[name] = {'archivePath': name, 'bytes': len(data), 'sha256': sha(data), 'groups': sorted(set(groups))}
    if original:
        files[name]['originalPath'] = original
    payloads[name] = data


def add(relative, group):
    path = ROOT / relative
    assert path.is_file() and not path.is_symlink(), relative
    add_bytes('evidence/' + relative, path.read_bytes(), [group], relative)


def tree(relative, group, small_generated=False):
    base = ROOT / relative
    assert base.is_dir(), relative
    for directory, dirs, names in os.walk(base, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in {'node_modules', '.git', '__pycache__'}
                         and not (Path(directory) / name).is_symlink())
        for name in sorted(names):
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                continue
            suffix = path.suffix.lower()
            omit = '.trace.json' in name or suffix in {'.zip', '.png', '.html', '.pyc'}
            omit |= not small_generated and suffix in {'.gz', '.xz', '.wasm', '.so', '.a'}
            if omit:
                excluded.append({'path': str(path.relative_to(ROOT)), 'bytes': path.stat().st_size,
                                 'reason': 'Raw package/trace or reproducible generated artifact; not a unique report.'})
                continue
            add(str(path.relative_to(ROOT)), group)


old_manifest_bytes = (OLD / 'manifest.json').read_bytes()
assert sha(old_manifest_bytes) == '96cff2ccaccb4b80f94c5f6d9cb9f26343eb9a5ad0da8475978609b430be65f0'
old_manifest = json.loads(old_manifest_bytes)
old_archive = (OLD / 'payload.tar.gz').read_bytes()
assert sha(old_archive) == '026ea697a1e738e1381ec5318fb071a2aec4b15e98a9f9a4e43c5637f78da712'
add_bytes('prior-checkpoints/precomponent-v1/payload.tar.gz', old_archive, ['complete-unchanged-prior-checkpoint'])
for name in ['manifest.json', 'README.md', 'results.json', 'receipt.json', 'verification.json', 'preflight.json',
             'source-reconstruction.json', 'build_snapshot.py', 'verify_archive.py']:
    add_bytes('prior-checkpoints/precomponent-v1/' + name, (OLD / name).read_bytes(), ['prior-checkpoint-metadata'])
nested = [{'archivePath': 'prior-checkpoints/precomponent-v1/payload.tar.gz',
           'sha256': sha(old_archive), 'manifestSha256': sha(old_manifest_bytes),
           'meaning': 'Exact prior1076-member archive, including all conservative raw reports removed only as duplicate filesystem extractions. Its metadata retains its historical timestamp and status.'}]
del old_archive

directories = [
    ('profile-evidence/utf8-parser-study-c1ec', 'held-four-arm-utf8-cohort'),
    ('profile-evidence/utf8-pair-study-c1ec', 'held-paired-utf8-cohort'),
    ('profile-evidence/utf8-shape-review', 'utf8-prior-art-and-mechanism'),
    ('profile-evidence/native-writer-component-c1ec', 'frozen-writer-harness-reader-pending-hosted-result'),
    ('profile-evidence/native-writer-component-review', 'writer-projection-and-reader-gates'),
    ('profile-evidence/native-gzip-expanded-339360', 'expanded-actual-chrome-correctness'),
    ('profile-evidence/native-gzip-validation-20c8', 'corrected-conservative-source-gates'),
    ('profile-evidence/native-vndb-expanded-conservative-46110757721-audit', 'expanded-vndb-independent-cell'),
    ('profile-evidence/native-vndb-expanded-baseline-46110757721-audit', 'expanded-vndb-independent-cell'),
    ('profile-evidence/native-await-draft', 'unapplied-browser-and-ci-test-drafts'),
    ('profile-evidence/native-gzip-confirmation-c1ec', 'unexecuted-confirmation-plan'),
    ('profile-evidence/vndb-native-expanded-c1ec', 'expanded-vndb-frozen-plan'),
    ('profile-evidence/baseline-ordinary-46105395307', 'existing-ordinary-baseline-evidence'),
    ('profile-evidence/native-worktree-prune-c1ec', 'reversible-cleanup-receipts'),
    ('profile-evidence/workspace-prune-c1ec', 'reversible-cleanup-receipts'),
    ('profile-evidence/remaining-static-prune-c1ec', 'reversible-cleanup-receipts'),
]
for relative, group in directories:
    tree(relative, group)
for relative in ['native-utf8-inline-candidate/builds/perf/utf8-inline',
                 'native-utf8-word-candidate/builds/perf/utf8-word',
                 'native-utf8-pair-candidate/builds/perf/utf8-pair',
                 'native-gzip-writer-candidate/builds/perf/native-writer']:
    tree(relative, 'complete-local-source-gates-and-failures', small_generated=True)
for path in sorted((ROOT / 'profile-evidence').iterdir()):
    if path.is_file() and not path.is_symlink() and path.suffix in {'.json', '.md', '.py', '.log', '.txt', '.yml'}:
        add(str(path.relative_to(ROOT)), 'current-profile-receipts')
for dictionary in ['jmdict', 'jitendex', 'vndb']:
    tree(f'profile-evidence/native-screen-{dictionary}-46107561217-audit', 'conservative-derived-audits')
for relative in ['ext/js/dictionary/term-bank-wasm-parser.js', 'test/term-bank-native-inflate.test.js']:
    add('native-gzip-writer-candidate/' + relative, 'direct-writer-frozen-source-copy')

source_refs = [dict(item) for item in old_manifest['sourceRefs']]
for experiment, commit, tree_id in [
    ('utf8-inline-held', '593c1d69a350594a557832a92ece7f9d4412f676', 'c23585fa7e3479b4b0cc3e9d53d827ebf26681fd'),
    ('utf8-continuation-word-held', '6d8fd14fa1f14e3ee9497450effb2919454d9699', '0679962b0fa41e241c0dde67741eddda11a20a34'),
    ('utf8-paired-cjk-v2-held', '74aa8bab3de19470fc681f8f9ada55e3df389787', '0807f9a38826048f1fd60ca7bb0a034512501f8f'),
]:
    source_refs.append({'experiment': experiment, 'commit': commit, 'tree': tree_id,
                        'statusAtSnapshot': 'Correctness-qualified source; completed fixed Node component cohort held/inconclusive. No browser promotion or product PR.'})
for item in source_refs:
    assert git('rev-parse', item['commit'] + '^{tree}').decode().strip() == item['tree']
    item['changedPathsFromBaseline'] = git('diff', '--name-only', BASE, item['commit']).decode().splitlines()
    item['commitsInDependencyOrder'] = git('rev-list', '--reverse', '--topo-order', BASE + '..' + item['commit']).decode().splitlines()
    if 'repetitive' in item['experiment']:
        item['statusAtSnapshot'] = 'Expanded Chrome correctness passes; both independent VNDB screens are slower and fail memory gates. Held; no promotion.'
heads = list(dict.fromkeys(item['commit'] for item in source_refs))
ordered = git('rev-list', '--reverse', '--topo-order', *heads, '--not', BASE).decode().splitlines()
commit_records, known = [], {BASE}
old_commits = {item['commit']: item for item in old_manifest['sourceCommitPatches']}
for commit in ordered:
    raw = git('cat-file', 'commit', commit)
    headers = raw.split(b'\n\n', 1)[0].decode().splitlines()
    parents = [line[7:] for line in headers if line.startswith('parent ')]
    assert len(parents) == 1 and parents[0] in known
    parent = parents[0]
    args = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', parent, commit]
    patch = git(*args)
    if commit in old_commits:
        assert sha(raw) == old_commits[commit]['rawCommitSha256']
        assert sha(patch) == old_commits[commit]['patchSha256']
    raw_path, patch_path = f'commit-objects/{commit}.raw', f'source-patches/{commit}.patch'
    add_bytes(raw_path, raw, ['complete-source-parent-closure'])
    add_bytes(patch_path, patch, ['complete-binary-source-patches'])
    changed = []
    for name in git('diff', '--name-only', parent, commit).decode().splitlines():
        entry = git('ls-tree', commit, '--', name).decode().strip()
        if not entry:
            changed.append({'path': name, 'deleted': True})
            continue
        mode, kind, rest = entry.split(' ', 2)
        blob, actual = rest.split('\t', 1)
        data = git('cat-file', 'blob', blob)
        changed.append({'path': actual, 'mode': mode, 'kind': kind, 'gitBlob': blob, 'bytes': len(data), 'sha256': sha(data)})
    commit_records.append({'commit': commit, 'parent': parent, 'tree': headers[0][5:],
        'rawCommitPath': raw_path, 'rawCommitSha256': sha(raw), 'patchPath': patch_path,
        'patchSha256': sha(patch), 'patchBytes': len(patch), 'patchGitArguments': args, 'changedFiles': changed})
    known.add(commit)

external = [dict(item) for item in old_manifest['externalArtifacts']]
expanded_receipt = load('profile-evidence/native-vndb-expanded-run-receipt-c1ec.json')
expanded = []
for comparison in ['conservative', 'baseline']:
    relative = f'profile-evidence/native-vndb-expanded-{comparison}-46110757721-audit/independent-audit.json'
    audit = load(relative)
    job = next(item for item in expanded_receipt['jobs'] if item['comparison'] == comparison)
    artifact = next(item for item in expanded_receipt['artifacts'] if f'-{comparison}-' in item['name'])
    assert artifact['digest'] == 'sha256:' + audit['artifactSha256']
    expanded.append({'comparison': comparison, 'runId': expanded_receipt['runId'], 'jobId': job['id'],
        'artifactId': artifact['id'], 'auditPath': 'evidence/' + relative,
        'auditSha256': files['evidence/' + relative]['sha256'],
        **{key: audit[key] for key in ['candidateVsBaseline', 'identicalCodeControl', 'memoryPassed',
            'artifactAuditStatus', 'sourceAndPackagesVerified', 'analysisAuditErrors', 'scope']}})
    external.append({'label': 'expanded-vndb-' + comparison, 'runId': expanded_receipt['runId'],
        'jobId': job['id'], 'artifactId': artifact['id'], 'artifactSha256': audit['artifactSha256'],
        'localOuterPath': f'profile-evidence/native-vndb-expanded-{comparison}-46110757721.zip',
        'receipt': relative, 'includePayloadInCompactArchive': False})
identity = load('profile-evidence/native-gzip-expanded-339360/identity-audit.json')
external.append({'label': 'expanded-native-chrome-correctness',
    **{key: identity[key] for key in ['runId', 'jobId', 'artifactId', 'artifactSha256']},
    'receipt': 'profile-evidence/native-gzip-expanded-339360/identity-audit.json',
    'includePayloadInCompactArchive': False})
for item in external:
    path = ROOT / item['localOuterPath'] if item.get('localOuterPath') else None
    if path and path.exists():
        assert not path.is_symlink()
        digest = file_sha(path)
        assert digest == item.get('artifactSha256', item.get('sha256'))
        item['outerBytesAtSnapshot'] = path.stat().st_size
        item['outerSha256RecheckedAtSnapshot'] = digest
    else:
        item['outerSha256RecheckedAtSnapshot'] = None
        item['outerRetentionNote'] = 'Reports/immutable retrieval identity retained; no new package duplicate created.'

utf8 = {}
for label, directory in [('inlineAndWord', 'utf8-parser-study-c1ec'), ('pairedCjkV2', 'utf8-pair-study-c1ec')]:
    relative = f'profile-evidence/{directory}/cohort-01/cohort.json'
    cohort = load(relative)
    assert cohort['status'] == 'complete-node-component-screen-only' and cohort['controlQualified'] is False
    utf8[label] = {'path': 'evidence/' + relative, 'sha256': files['evidence/' + relative]['sha256'],
        'planSha256': cohort['planSha256'], 'correctnessChildren': len(cohort['correctness']),
        'timedChildren': len(cohort['observations']), 'controlQualified': False,
        'comparisons': {name: {metric: {key: value for key, value in data.items() if key != 'pairs'}
                              for metric, data in comparison.items()} for name, comparison in cohort['comparisons'].items()},
        'candidateDecisions': cohort['candidateDecisions'],
        'scope': 'Node component only; no whole-import, browser or memory claim. No missing observations or performance replacements.'}
old_results = json.loads((OLD / 'results.json').read_text())
results = {'snapshot': OUT.name, 'createdAt': datetime.now(timezone.utc).isoformat(),
    'status': 'Durable checkpoint ready for parent publication; no product PR is supported by completed experiments.',
    'completedConservativeScreens': old_results['completedConservativeScreens'],
    'completedExpandedVndbCells': expanded, 'expandedChromeCorrectness': identity,
    'completedUtf8ComponentScreens': utf8,
    'previousHeldExperiments': old_results['heldOrRejected'],
    'pendingOrUnapplied': [
        'Direct-writer source/plan/reader are frozen; hosted component result remains pending and is not inferred here.',
        'Native-await cancellation/bad-CRC browser plus CI drafts are unapplied and unexecuted.',
        'Conservative confirmation plan remains unexecuted.',
        'A new guarded group-burst source is being prepared separately; only its read-only prospective assessment is included. No qualification is claimed.',
        'A possible pure fused-export diagnostic and maintained pair-specific test proposal are separate pending work; not executed by this checkpoint.'
    ],
    'limits': old_results['limits'] + [
        'The old1076-member payload is embedded unchanged. Its historical status and older broad privacy wording remain historical bytes, not new claims.',
        'The current publication pattern screen checks only explicitly listed token/key/signed-URL patterns. It is not an exhaustive secret audit.',
        'Both expanded VNDB cells are independent hosts; do not pool or subtract their effects.',
        'Failed correctness processes, superseded unmeasured sourcev1, failed post-audit float assertion and all fixed performance observations remain retained.',
        'The initial Python exact-float audit mismatch was corrected only in a separately named audit script; JavaScript means and all acquisition decisions were unchanged.'
    ]}
add_bytes('results.json', encoded(results), ['current-results-summary'])
readme = f'''# Import research checkpoint after the UTF-8 studies

This is an evidence checkpoint, not a product release. No completed candidate in
this checkpoint supports a performance PR. Original observations, failures,
source patches and prospective decisions are preserved.

## Completed outcomes

| Experiment | Outcome |
| --- | --- |
| Conservative native gzip, JMdict | Paired median −5.67%, equal-work −1.70%, only4/6 faster; private-memory median +5.36% failed. Held. |
| Conservative native gzip, Jitendex | Paired median +25.48%,0/6 faster; memory gates failed. Held. |
| Conservative native gzip, VNDB | Paired median +0.55%; memory sampling unqualified. Held. |
| Expanded native gzip, VNDB versus conservative | Independent six-pair median +48.81%,0/6 faster; memory gate failed. |
| Expanded native gzip, VNDB versus9e | Independent six-pair median +42.49%,0/6 faster; memory gate failed. |
| Inline-only and continuation-word UTF-8 | Complete4-preflight/32-child Node cohort. Neither passed; identical control was outside the prospective CPU limits. |
| Paired-CJK v2 | Complete3-preflight/36-child Node cohort, three measured pass means per child. B/A CPU median +1.15% versus B/C −5.83%; identical C/A equal-work +8.21% failed. Held/inconclusive. |

The native correctness canaries pass their stated logical input/output and
failure-order checks; correctness does not establish speed or memory improvement.
Expanded VNDB effects belong to separate hosts and must not be pooled or
subtracted. The UTF-8 results cover parser plus completed lookup CPU in Node;
they do not measure full imports. Their complete semantic projections passed.

## What is retained

- `results.json` gives exact comparisons, intervals, controls and limits.
- `evidence/profile-evidence/utf8-parser-study-c1ec/` and
  `evidence/profile-evidence/utf8-pair-study-c1ec/` retain plans, approval receipts,
  every child/pass/group, source identities, complete audits and failed attempts.
- All inline/word/pair source gates are retained, including pairv1 (unmeasured),
  the killed v2 correctness command, its separately authorized successful retry,
  and the initial post-acquisition floating-point audit failure.
- Both expanded VNDB raw reports, strict readers, frozen plans and job receipts
  are included. Large hosted ZIPs remain outside the compact payload with their
  immutable IDs, sizes and SHA-256 recorded in the manifest.
- Direct-writer source and its frozen diagnostic/reader are retained; its pending
  hosted result is not invented. New guarded-burst code is outside this snapshot.
- Browser cancellation/CRC and CI test drafts remain explicitly unapplied.

## Unchanged prior checkpoint

`prior-checkpoints/precomponent-v1/payload.tar.gz` is the exact6,680,444-byte
archive SHA-256 `026ea697a1e738e1381ec5318fb071a2aec4b15e98a9f9a4e43c5637f78da712`.
It retains all1,076 original members: string masks, broad/narrow record fields,
publication fusion, descriptor diagnosis, original native gates, all conservative
raw reports, source closure, and failed observations. Nesting this compact payload
preserves every original byte without restoring57MB of redundant raw filesystem
extractions. Its historical summaries remain historical; this checkpoint's
`results.json` records the newer outcomes.

## Verification and source restoration

Run `python3 verify_archive.py payload.tar.gz --repo /path/to/manabitan`.
The repository needs exact published baseline `{BASE}` and its objects. Every
retained source commit is reconstructed in dependency order by applying its
binary patch to a separate temporary Git index; each tree and raw commit object
must match. The real index and worktrees remain unchanged. The verifier also
checks every top-level and nested prior-checkpoint member hash and safe path.
`source-patches/` includes regenerated WASM/manifests and tests, not just C/JS text.
Small standalone oracle binaries/WASM are preserved with their source/receipts;
dependencies and external dictionary ZIPs are excluded.

## Publication boundary

The archive creator performs no remote write or new experiment. Root may publish
the adjacent files listed in `publication-manifest.json` on one research evidence
branch. That manifest provides local paths, exact SHA-256 and Git blob identities.
Future hosted outcomes require a new named addition, never rewriting this one.
The publication pattern screen lists its exact patterns and match count. It is
not an exhaustive secret audit. The earlier checkpoint's broader wording is
preserved as historical evidence and is not repeated as a current assurance.
'''
add_bytes('README.md', readme.encode(), ['readable-checkpoint-index'])
for name in ['build_snapshot.py', 'verify_archive.py']:
    add_bytes(name, (OUT / name).read_bytes(), ['reproducible-archive-tools'])

spec = importlib.util.spec_from_file_location('archive_verifier', OUT / 'verify_archive.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
baseline = {'commit': BASE, 'tree': git('rev-parse', BASE + '^{tree}').decode().strip(),
            'repository': 'https://github.com/ManabiIO/manabitan',
            'retrieval': 'Fetch exact published9e baseline and tree/blob objects. No dependency or dictionary fixture bytes are embedded.'}
source_manifest = {'baseline': baseline, 'sourceCommitPatches': commit_records}
reconstruction = verifier.reconstruct_sources(REPO, source_manifest, payloads.__getitem__)
add_bytes('source-reconstruction.json', encoded(reconstruction), ['actual-temporary-index-reconstruction'])

patterns = {
    'github-token': re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b'),
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'aws-access-key': re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'unmasked-bearer': re.compile(rb'(?i)authorization["\s]*[:=]["\s]*(?:bearer|basic) +[A-Za-z0-9_+/.-]{24,}'),
    'signed-url': re.compile(rb'(?i)[?&](?:X-Amz-Signature|access_token|sig)=[A-Za-z0-9%_+/.-]{24,}'),
}
findings = []
for name, data in payloads.items():
    if name.endswith('payload.tar.gz'):
        continue  # The unchanged nested checkpoint has its own preserved pattern-screen receipt.
    for label, pattern in patterns.items():
        for match in pattern.finditer(data):
            findings.append({'archivePath': name, 'pattern': label, 'line': data[:match.start()].count(b'\n') + 1})
screen = {'status': 'zero-listed-pattern-matches' if not findings else 'requires-review',
    'testedPatterns': {key: value.pattern.decode() for key, value in patterns.items()},
    'matchCount': len(findings), 'findings': findings,
    'scope': 'Only these token/key/signed-URL patterns in selected current payload bytes. The unchanged nested checkpoint retains its prior receipt. This is not an exhaustive secret audit.'}
if findings:
    (OUT / 'publication-pattern-review-required.json').write_bytes(encoded(screen))
    raise SystemExit('Listed publication pattern found; inspect location-only receipt before export')
manifest = {'schemaVersion': 3, 'snapshot': OUT.name, 'createdAt': datetime.now(timezone.utc).isoformat(),
    'status': 'Actual local immutable checkpoint; remote publication is separate',
    'baseline': baseline, 'sourceRefs': source_refs, 'sourceCommitPatches': commit_records,
    'remoteSourceIdentities': old_manifest['remoteSourceIdentities'],
    'files': sorted(files.values(), key=lambda item: item['archivePath']), 'nestedArchives': nested,
    'externalArtifacts': external, 'publicationPatternScreen': screen,
    'excluded': excluded, 'explicitlyPendingSource': ['native-gzip-group-burst', 'unacquired pure-fused-export diagnostic'],
    'sourceReconstruction': 'All source parents to published9e included; every binary patch/tree/raw commit verified in temporary indexes.',
    'knownLimits': results['limits'] + ['External artifact IDs/checksums do not guarantee permanent download retention.']}
manifest_bytes = encoded(manifest)
free_before = shutil.disk_usage(ROOT).free
assert free_before > MAX_ARCHIVE_BYTES + MIN_FREE_BYTES
preflight = {'createdAt': datetime.now(timezone.utc).isoformat(), 'files': len(payloads),
    'uncompressedBytesIncludingNestedCompactCheckpoint': sum(map(len, payloads.values())) + len(manifest_bytes),
    'sourceCommits': len(commit_records), 'freeBeforeBytes': free_before,
    'archiveOutputCapBytes': MAX_ARCHIVE_BYTES, 'minimumFreeBytes': MIN_FREE_BYTES,
    'uncompressedStagingCopy': False, 'publicationPatternScreen': screen,
    'actualSourceReconstructionPassed': True}
(OUT / 'preflight.json').write_bytes(encoded(preflight))
print(json.dumps({'phase': 'preflight', 'files': len(payloads), 'sourceCommits': len(commit_records),
                  'inputBytes': preflight['uncompressedBytesIncludingNestedCompactCheckpoint'], 'freeBeforeBytes': free_before}), flush=True)


class LimitedWriter:
    def __init__(self, stream):
        self.stream, self.written = stream, 0

    def write(self, data):
        if self.written + len(data) > MAX_ARCHIVE_BYTES or shutil.disk_usage(ROOT).free < MIN_FREE_BYTES:
            raise RuntimeError('Archive output cap/free-space guard reached')
        result = self.stream.write(data)
        self.written += result
        return result

    def flush(self):
        return self.stream.flush()


partial = OUT / 'payload.tar.gz.partial'
with partial.open('xb') as raw:
    with gzip.GzipFile(fileobj=LimitedWriter(raw), mode='wb', filename='', mtime=0, compresslevel=6) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
            for name, data in [('manifest.json', manifest_bytes), *sorted(payloads.items())]:
                member = tarfile.TarInfo(name)
                member.size, member.mode, member.mtime, member.uid, member.gid = len(data), 0o644, 0, 0, 0
                archive.addfile(member, io.BytesIO(data))
final = OUT / 'payload.tar.gz'
partial.rename(final)
verification = verifier.inspect_archive(final, REPO)
assert verification['manifestSha256'] == sha(manifest_bytes)
assert len(verification['nestedArchives']) == 1 and verification['nestedArchives'][0]['memberCount'] == 1076
for name in ['README.md', 'results.json', 'source-reconstruction.json']:
    (OUT / name).write_bytes(payloads[name])
(OUT / 'manifest.json').write_bytes(manifest_bytes)
(OUT / 'verification.json').write_bytes(encoded(verification))
receipt = {'completedAt': datetime.now(timezone.utc).isoformat(), 'status': 'verified-local-checkpoint-not-remotely-published',
    'archivePath': str(final.relative_to(ROOT)), 'archiveBytes': verification['archiveBytes'],
    'archiveSha256': verification['archiveSha256'], 'manifestSha256': sha(manifest_bytes),
    'memberCount': verification['memberCount'], 'nestedPriorMembers': 1076, 'sourceCommitCount': len(commit_records),
    'allSourceTreesReconstructed': True, 'allRawCommitObjectsVerified': True, 'realIndexUnchanged': True,
    'allCurrentAndNestedMemberHashesVerified': True, 'priorCheckpointBytesUnchanged': True,
    'publicationPatternScreen': screen, 'freeAfterBytes': shutil.disk_usage(ROOT).free,
    'laterOutcomesRequireNewNamedCheckpoint': True}
(OUT / 'receipt.json').write_bytes(encoded(receipt))
publication_files = []
for name in ['payload.tar.gz', 'manifest.json', 'README.md', 'results.json', 'verification.json',
             'source-reconstruction.json', 'receipt.json', 'preflight.json', 'build_snapshot.py', 'verify_archive.py']:
    data = (OUT / name).read_bytes()
    blob = git('hash-object', '-w', '--stdin', data=data).decode().strip()
    assert blob == hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    publication_files.append({'localPath': str(OUT / name), 'name': name, 'bytes': len(data),
        'sha256': sha(data), 'gitBlob': blob,
        'suggestedRepositoryPath': 'dev/perf/import-study-c1ec/checkpoints/postutf8-v2/' + name})
publication = {'status': 'ready-for-parent-research-branch-publication; no remote write performed here',
    'snapshot': OUT.name, 'files': publication_files, 'scope': 'Evidence only. No performance PR is supported by these completed experiments.',
    'localGitObjectsWritten': True, 'remoteObjectsNotClaimed': True,
    'includeThisManifestAlongsideFiles': True, 'sourceBase': BASE}
(OUT / 'publication-manifest.json').write_bytes(encoded(publication))
assert file_sha(OLD / 'payload.tar.gz') == nested[0]['sha256']
print(json.dumps({'phase': 'complete', 'archiveBytes': receipt['archiveBytes'],
    'archiveSha256': receipt['archiveSha256'], 'manifestSha256': receipt['manifestSha256'],
    'members': receipt['memberCount'], 'nestedPriorMembers': 1076, 'sourceCommits': len(commit_records),
    'publicationManifest': str(OUT / 'publication-manifest.json'),
    'publicationManifestSha256': file_sha(OUT / 'publication-manifest.json')}), flush=True)
