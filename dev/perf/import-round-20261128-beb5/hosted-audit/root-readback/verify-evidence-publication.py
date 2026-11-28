#!/usr/bin/env python3
"""Verify remote retention objects against original local archives before moving a ref."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import zipfile

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main(args):
    expected = json.loads(args.metadata.read_text())
    commit = expected['commit']
    git = lambda *parts: subprocess.check_output(['git', *parts], cwd=args.repo)
    assert git('rev-parse', commit + '^{tree}').decode().strip() == expected['tree']
    assert git('rev-list', '--parents', '-n', '1', commit).decode().split() == [commit, expected['parent']]
    changed = git('diff', '--name-only', expected['parent'], commit).decode().splitlines()
    assert changed and all(path.startswith('dev/perf/import-round-20261128-beb5/') for path in changed)
    for node in expected['nodes']:
        assert git('rev-parse', commit + ':' + node['path']).decode().strip() == node['sha'], node['path']
    cached = {}
    def blob(path):
        if path not in cached:
            cached[path] = git('show', commit + ':' + path)
        return cached[path]
    files = expected['hostedObjects'] + expected['localFiles']
    files += [{**item, 'path': 'dev/perf/import-round-20261128-beb5/' + item['path']} for item in expected['sourceFollowup']['entries']]
    verified = []
    for item in files:
        data = blob(item['path'])
        assert len(data) == item['bytes'], item['path']
        assert sha(data) == item['sha256'], item['path']
        object_id = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        assert object_id == item.get('gitBlobSha', item.get('sha')), item['path']
        verified.append({key: item[key] for key in ['path', 'bytes', 'sha256']})
    archives = []
    root = 'dev/perf/import-round-20261128-beb5/hosted-audit/'
    for key in ['prefix-jmdict', 'prefix-jitendex', 'prefix-vndb', 'crc-no-unroll-jmdict']:
        data = blob(root + key + '/original-artifact.zip')
        original = (args.originals / (key + '.zip')).read_bytes()
        assert data == original, key
        archives.append({'entry': key, 'mode': 'verbatim-original', 'bytes': len(data), 'sha256': sha(data)})
    report_checks = []
    for dictionary in ['jmdict', 'jitendex', 'vndb']:
        key = 'canonical-' + dictionary
        original_path = args.originals / (key + '.zip')
        reduced = blob(root + key + '/evidence-without-reproducible-packages.zip')
        with zipfile.ZipFile(original_path) as original, zipfile.ZipFile(io.BytesIO(reduced)) as retained:
            original_files = [entry.filename for entry in original.infolist() if not entry.is_dir()]
            retained_files = [entry.filename for entry in retained.infolist() if not entry.is_dir()]
            assert len(set(original_files)) == len(original_files)
            assert len(set(retained_files)) == len(retained_files)
            omitted = {'package-A.zip', 'package-B.zip'}
            assert omitted <= set(original_files)
            assert set(retained_files) == set(original_files) - omitted, key
            for name in retained_files:
                assert original.read(name) == retained.read(name), key + ':' + name
            receipt = json.loads(blob(root + key + '/retention.json'))
            assert receipt['retainedArchiveSha256'] == sha(reduced)
            assert receipt['retainedArchiveBytes'] == len(reduced)
            assert receipt['originalOuterSha256'] == sha(original_path.read_bytes())
            assert {row['path'] for row in receipt['omittedOriginalMembers']} == omitted
            archives.append({'entry': key, 'mode': 'all-original-member-bytes-except-package-zips',
                             'verifiedRetainedMembers': len(retained_files), 'omissions': sorted(omitted),
                             'sha256': sha(reduced), 'bytes': len(reduced)})
        remote_report = json.loads(blob(root + key + '/independent-audit.json'))
        local_report = json.loads((args.canonical / dictionary / 'independent-audit.json').read_text())
        differing = sorted(key for key in set(remote_report) | set(local_report)
                           if remote_report.get(key) != local_report.get(key))
        assert not differing, dictionary + ': independent report differs in ' + str(differing)
        report_checks.append({'dictionary': dictionary, 'completeReportDeepEqual': True,
                              'observations': remote_report['validatedObservationCount'],
                              'memoryPassed': remote_report['memoryPassed']})
    return {'complete': True, 'commit': commit, 'tree': expected['tree'], 'parent': expected['parent'],
            'scope': 'Read-only local rehash and exact original-member comparison of the remote evidence commit before ref publication. No measurements rerun.',
            'changedPathsAllWithinEvidence': True, 'changedPaths': changed,
            'registeredNodesChecked': len(expected['nodes']), 'fileHashesChecked': len(verified),
            'files': verified, 'originalArchiveComparisons': archives,
            'independentCanonicalReports': report_checks}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--metadata', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--originals', type=Path, required=True)
    parser.add_argument('--canonical', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    assert not args.out.exists()
    try:
        result = main(args)
    except Exception as error:
        args.out.write_text(json.dumps({'complete': False, 'type': type(error).__name__, 'error': str(error)}, indent=2) + '\n')
        raise
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['complete', 'commit', 'registeredNodesChecked', 'fileHashesChecked', 'originalArchiveComparisons', 'independentCanonicalReports']}))
