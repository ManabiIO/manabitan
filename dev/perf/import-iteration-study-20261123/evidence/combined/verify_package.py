"""Verify the compressed combined receipts without a browser or dictionary import."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import statistics
import subprocess
import tarfile
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_name(name):
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts and '\\' not in name,
            'Unsafe relative path: ' + name)
    require(path.as_posix() == name and name not in ('', '.'), 'Noncanonical path: ' + name)
    return path


def verify(package, node):
    manifest = json.loads((package / 'package-manifest.json').read_text())
    require(manifest['schemaVersion'] == 1, 'Unknown package format')
    require(manifest['runIds'] == [45114362649], 'Unexpected campaigns')
    listed = set()
    for identity in manifest['files']:
        name = identity['path']
        require(name not in listed, 'Duplicate package member')
        listed.add(name)
        file = package.joinpath(*safe_name(name).parts)
        require(file.is_file() and not file.is_symlink(), 'Missing or unsafe package member')
        data = file.read_bytes()
        require(len(data) == identity['bytes'] and digest(data) == identity['sha256'], 'Package member differs: ' + name)
    require(listed == {'audit_combined.mjs', 'build_evidence_package.py', 'collect_combined_artifacts.py',
                       'original-zip-verification.json',
                       'raw-members.json', 'raw-receipts.tar.xz', 'combined-audit.json',
                       'README.md', 'verify_package.py'}, 'Unexpected package file set')
    inventory = json.loads((package / 'raw-members.json').read_text())
    require(len(inventory) == manifest['rawMemberCount'], 'Raw member count differs')
    require(sum(row['bytes'] for row in inventory) == manifest['rawMemberBytes'], 'Raw byte count differs')
    require([row['path'] for row in inventory] == sorted(row['path'] for row in inventory), 'Raw inventory order changed')
    expected = {row['path']: row for row in inventory}
    require(len(expected) == len(inventory), 'Duplicate raw inventory member')
    with tempfile.TemporaryDirectory(prefix='manabitan-readback-verification-') as temporary:
        root = Path(temporary)
        seen = []
        with tarfile.open(package / 'raw-receipts.tar.xz', mode='r:xz') as archive:
            for member in archive:
                name = member.name
                require(name in expected and name not in seen, 'Unexpected/duplicate tar member: ' + name)
                require(member.isfile() and not member.issym() and not member.islnk(), 'Nonregular tar member')
                require(member.size == expected[name]['bytes'], 'Tar member size differs')
                require(member.mtime == 0 and member.uid == 0 and member.gid == 0 and member.mode == 0o644,
                        'Nondeterministic tar metadata')
                stream = archive.extractfile(member)
                require(stream is not None, 'Unreadable tar member')
                data = stream.read()
                require(digest(data) == expected[name]['sha256'], 'Raw member hash differs: ' + name)
                target = root.joinpath(*safe_name(name).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                seen.append(name)
        require(seen == [row['path'] for row in inventory], 'Tar members/order differ from inventory')
        receipt = json.loads((package / 'combined-audit.json').read_text())
        zip_verification = json.loads((package / 'original-zip-verification.json').read_text())
        require(len(zip_verification['artifacts']) == 6, 'Missing original ZIP verification')
        for original in zip_verification['artifacts']:
            collection = json.loads((root / original['manifestPath']).read_text())
            require(collection['artifact']['id'] == original['artifactId'], 'ZIP artifact identity differs')
            require(collection['verifiedZipSha256'] == original['sha256'], 'ZIP collection digest differs')
            require(collection['verifiedZipBytes'] == original['bytes'], 'ZIP collection size differs')
            require(collection['members'] == original['members'], 'Original member inventory differs')
            base = (root / original['manifestPath']).parent
            for member in original['members']:
                data = base.joinpath(*safe_name(member['path']).parts).read_bytes()
                require(len(data) == member['bytes'] and digest(data) == member['sha256'], 'Original ZIP member bytes changed')
        # A separate JavaScript verifier retains JSON.stringify semantics for the
        # exact complete-response digests originally computed in Chromium.
        process = subprocess.run([node, str(package / 'audit_combined.mjs'), str(root)],
                                 check=True, capture_output=True, text=True, timeout=120)
        recomputed = json.loads(process.stdout)
        require(recomputed == receipt, 'Independent semantic/physical/source audit differs')
        # Recompute the pair arithmetic independently in Python as well. Warmups
        # and memory observations are retained but never enter these pairs.
        for cell in receipt['cells']:
            evidence = root / str(cell['runId']) / f"combined-{cell['dictionary']}-{cell['replication']}" / 'combined' / cell['dictionary'] / str(cell['replication'])
            observations = json.loads((evidence / 'observations.json').read_text())
            for kind, count in [('candidate', 8), ('control-before', 2), ('control-after', 2)]:
                pairs = []
                for number in range(count):
                    selected = [row for row in observations if row['kind'] == kind and row['pair'] == number]
                    require(len(selected) == 2, 'Incomplete original pair')
                    if kind == 'candidate':
                        arms = {row['arm']: row for row in selected}
                        a, b = arms['A']['totalImportMs'], arms['B']['totalImportMs']
                    else:
                        a, b = [row['totalImportMs'] for row in selected]
                    pairs.append({'kind': kind, 'pair': number, 'order': ''.join(row['arm'] for row in selected),
                                  'observationIndexes': [row['index'] for row in selected],
                                  'baselineMs': a, 'comparisonMs': b, 'changePercent': 100 * (b / a - 1)})
                expected_pairs = cell['pairs'][kind]
                require(pairs == expected_pairs['pairs'], 'Python pair arithmetic differs')
                require(statistics.median(pair['changePercent'] for pair in pairs) == expected_pairs['medianChangePercent'], 'Python paired median differs')
                require(sum(pair['comparisonMs'] < pair['baselineMs'] for pair in pairs) == expected_pairs['fasterPairs'], 'Python pair direction count differs')
        require(receipt['memoryCoverage']['wholeTreeCoverageEstablished'] is False and
                receipt['memoryCoverage']['suitableForMemoryNonRegressionClaim'] is False,
                'Combined campaign unexpectedly makes a memory claim')
    return {'status': 'verified', 'packageManifestSha256': digest((package / 'package-manifest.json').read_bytes()),
            'rawMembers': manifest['rawMemberCount'], 'rawBytes': manifest['rawMemberBytes'],
            'observations': receipt['observationCount'], 'preAndPostRestartStates': receipt['preAndPostRestartStatesCheckedIncludingMemory'],
            'derivedCounters': receipt['checkedPhysicalCounters'], 'preservedFailedReplications': receipt['originalFailuresPreserved'],
            'memoryNonRegressionEstablished': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', nargs='?', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--node', default='node', help='Node.js 22 or later; no npm dependencies are required')
    args = parser.parse_args()
    print(json.dumps(verify(args.package.resolve(), args.node), indent=2))
