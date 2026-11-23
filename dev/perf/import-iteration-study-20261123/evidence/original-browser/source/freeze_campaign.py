"""Freeze the completed original campaign without duplicating ZIP payloads."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    analysis = json.loads((source / 'analysis.json').read_text())
    api = json.loads((source / 'metadata-latest.json').read_text())
    if not analysis['all24JobsCompleted'] or analysis['artifactsAvailable'] != 24:
        raise ValueError('Refusing to freeze an incomplete original campaign')
    if len(api['artifacts']) != 24 or not all(job['status'] == 'completed' for job in api['jobs']):
        raise ValueError('Final API snapshot is incomplete')
    output.mkdir(parents=True, exist_ok=False)
    for name in ['source', 'derived', 'provenance', 'acquisition', 'raw']:
        (output / name).mkdir()
    for name in [
        'analyze_campaign.py', 'collect_artifact.py', 'freeze_campaign.py', 'verify_campaign.py',
        'campaign-driver-original.py', 'campaign-memory-sampler-original.py',
        'campaign-workflow-original.yml', 'reference-candidates.json',
        'reference-fixtures.json', 'reference-harness-hashes.json',
    ]:
        shutil.copyfile(source / name, output / 'source' / name)
    for name in ['analysis.json', 'analysis.md', 'memory-coverage-audit.json']:
        shutil.copyfile(source / name, output / 'derived' / name)
    shutil.copyfile(source / 'metadata-latest.json', output / 'provenance' / 'api-final.json')
    for path in sorted(source.glob('workflow-job-*.log')):
        shutil.copyfile(path, output / 'provenance' / path.name)
    cells = []
    members = 0
    uncompressed_bytes = 0
    archive_path = output / 'raw' / 'original-members.tar.gz'
    with archive_path.open('wb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=0, compresslevel=9) as compressed, tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for row in sorted(analysis['rows'], key=lambda value: value['directory']):
            directory = source / row['directory']
            acquisition = json.loads((directory / 'artifact-manifest.json').read_text())
            receipt_path = f"acquisition/{row['directory']}.json"
            shutil.copyfile(directory / 'artifact-manifest.json', output / receipt_path)
            evidence = directory / row['candidate'] / row['dictionary'] / str(row['replication'])
            observations = json.loads((evidence / 'observations.json').read_text())
            identity_rows = []
            for observation in observations:
                name = f"{observation['index']:02d}-{observation['kind']}-{observation['pair']}-{observation['arm']}"
                summary_path = evidence / name / 'summary.json'
                report_path = evidence / name / 'run-1.json'
                summary = json.loads(summary_path.read_text())
                identity_rows.append({
                    **{key: observation[key] for key in ['index', 'kind', 'pair', 'arm', 'totalImportMs', 'packageSha256']},
                    'sourceSha': summary['gitSha'],
                    'outputDigestSha256': observation['validation']['outputDigestSha256'],
                    'termRows': observation['validation']['termRows'],
                    'mediaRows': observation['validation']['mediaRows'],
                    'summaryMember': str(summary_path.relative_to(source)),
                    'summarySha256': digest(summary_path.read_bytes()),
                    'reportMember': str(report_path.relative_to(source)),
                    'reportSha256': digest(report_path.read_bytes()),
                })
            for member in sorted(acquisition['members'], key=lambda value: value['path']):
                data = (directory / member['path']).read_bytes()
                if len(data) != member['bytes'] or digest(data) != member['sha256']:
                    raise ValueError('Raw member changed after audit: ' + member['path'])
                info = tarfile.TarInfo(row['directory'] + '/' + member['path'])
                info.size = len(data)
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(data))
                members += 1
                uncompressed_bytes += len(data)
            cells.append({
                'candidate': row['candidate'], 'dictionary': row['dictionary'],
                'replication': row['replication'], 'directory': row['directory'],
                'jobId': row['workflowJob']['id'], 'jobConclusion': row['workflowJob']['conclusion'],
                'artifactId': acquisition['artifact']['id'], 'artifactName': acquisition['artifact']['name'],
                'originalZipSha256': acquisition['verifiedZipSha256'],
                'originalZipBytes': acquisition['verifiedZipBytes'],
                'acquisitionReceipt': receipt_path, 'memberCount': acquisition['memberCount'],
                'timingGuardsPassed': row['qualified'], 'guardFailures': row['guardFailures'],
                'qualifiedResultsJsonPresent': (evidence / 'results.json').exists(),
                'observations': identity_rows,
            })
    readme = '''# Original import campaign 45110694360

This package freezes all 24 cells of the original Linux Chromium comparison:
https://github.com/ManabiIO/manabitan/actions/runs/45110694360

The harness commit is `088d9c22ccd2b0dc05b240355c76320c9660ce3e`.
All 624 timed observations are retained in recorded order: 48 warmups,
384 candidate observations (192 AB/BA pairs), and 192 baseline-control
observations (96 AA pairs). Sixteen separate memory diagnostics are retained.
No observation or failed guard was removed or replaced.

## Storage and verification

`raw/original-members.tar.gz` contains every original Actions artifact file,
byte for byte, including all reports, observations, logs, identities, package
member manifests and raw memory samples. Tar metadata and the gzip timestamp
are fixed, so the archive is deterministic. Original ZIP containers are not
duplicated here. Their independently verified API digest/size and complete
member inventories remain in `acquisition/`; final API metadata and failure
job logs remain in `provenance/`.

Run `python3 source/verify_campaign.py` from this package directory. It verifies
all package files and original member bytes, reconstructs schedules, compares
raw browser boundaries/source/package/count/readback guards, recomputes paired
statistics, and verifies the original memory aggregates. It runs no imports.
The original collection/analyzer/freezer and harness sources are in `source/`.

The standalone original analyzer can be reproduced from the acquisition ZIPs:
download each artifact ID from the run through the GitHub Actions artifact API,
verify its advertised ZIP digest/size, retain the original directory layout,
and run `analyze_campaign.py` with the included final API and reference files.
Only its generated timestamp may differ. The included verifier instead works
directly with the compact lossless member archive and needs no network access.

## Interpretation and decisions

See `derived/analysis.md` and `derived/analysis.json` for every fixed pair and
baseline control. Negative percentage changes mean lower import time. Passing
guards establishes comparable evidence; it does not itself establish a speedup.
The measurement boundary is the browser file-input change through post-UI
import completion. Restart/readback and memory diagnostics are outside timing.

Twenty-two cells passed the original timing guards. Both owned-shared Jitendex
cells failed the cross-arm sampled-content digest and have no qualified
`results.json`. Their timings remain descriptive only, regardless of later
corrective campaigns. Original source/package/count/restart evidence is kept.
The original browser digest sampled 12 terms and could encode physical content
references; corrected semantic readback campaigns are separate evidence.

The original memory sampler did not establish whole Chromium/import-worker
coverage: 2,161 of 2,164 scans captured just one PID. The exact argv[0] basename
filter can omit Chromium processes after process-title rewriting. Original
readings cannot support whole-tree peak-memory or memory non-regression claims.
See `derived/memory-coverage-audit.json`; repaired memory runs are separate.

CRC word-loop decision: do not promote research commit
`930083af581bd4d8fe8dc42fe7e443e57666f8f9` to a production PR. Preserve its branch
and all local/hosted observations. Whole-import changes across the three
corpora are small and overlap baseline-control variation, so the evidence does
not justify the additional native/Wasm complexity.

The Actions artifact ZIP hashes were independently recomputed at acquisition.
Extension build ZIPs are absent: their recorded hashes were cross-checked with
every observation and complete packaged-file hash manifests. Full VNDB media
payload correctness lives in the separate component package; the browser
sampled readback here is not represented as full-payload coverage.
'''
    (output / 'README.md').write_text(readme)
    files = [{'path': str(path.relative_to(output)), 'bytes': path.stat().st_size,
              'sha256': digest(path.read_bytes())}
             for path in sorted(output.rglob('*')) if path.is_file()]
    manifest = {
        'schemaVersion': 1, 'runId': 45110694360, 'repository': 'ManabiIO/manabitan',
        'harness': analysis['harness'], 'cells': cells, 'files': files,
        'rawArchive': 'raw/original-members.tar.gz', 'originalMemberCount': members,
        'originalMemberBytes': uncompressed_bytes,
        'observations': sum(len(cell['observations']) for cell in cells),
        'timingGuardPassCells': sum(cell['timingGuardsPassed'] for cell in cells),
        'memoryCoverageEstablished': False,
        'crcProductionDecision': 'Do not promote; preserve inconclusive research evidence.',
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'directory': str(output), 'files': len(files) + 1,
                      'bytes': sum(path.stat().st_size for path in output.rglob('*') if path.is_file()),
                      'rawArchiveBytes': archive_path.stat().st_size,
                      'originalMembers': members, 'originalBytes': uncompressed_bytes,
                      'manifestSha256': digest((output / 'manifest.json').read_bytes())}))


if __name__ == '__main__':
    main()
