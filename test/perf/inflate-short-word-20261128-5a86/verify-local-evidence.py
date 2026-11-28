#!/usr/bin/env python3
"""Verify recovered local evidence without running a decoder or acquisition."""
import argparse
import ast
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile

BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = '1c93b0a18f5dd53a13dfdd3d054687c85e097247'
TREE = '7bf2f889a94d955bf8845b9f8d9e2d4afb464617'
ORACLE = '507c25a0257d5fd8b789e294386f6b703f77efda0863e0ef64b7c176e06d8023'
ORIGINALS = {
 'original-component/observe.mjs': '4bd1085be4fd16cc5e5246be3682bcabfdb546331afb4d5ce123084a9f37a4e4',
 'original-component/run.py': '6740a59f94254e2d0060f094993c818f73a472fd9b7be96deceaa13139274c92',
 'original-component/plan.json': '1ae467eaa524b3aa71d25463fab594379d6d2ee607294bfb351cdde266eee802',
 'original-component/observer-manifest.json': '881d693de5f1170c82da4e944e1bc38b7a05c226081a165f7951c6f4ed1e3f82',
 'original-component/failed-cohort/report.json': 'd44110e5083129327c21fb0af231ac2ec7adda02e5a614f28537899d83691402',
 'original-component/failed-cohort/controller-receipt.json': '990c229edf6dc6b76d5215195bcef11b106b6dd1af9f2162b8eca4329fe64cd9',
 'original-component/failed-cohort/controller.log': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
 'original-reviews/prior-work-failure-review.json': '11ce7d08c149d065324038f6ffefa0c3143d475319c8e337a8eb2c065dbfc1b3',
 'original-reviews/storage-pre-acquisition-review.json': '920ee42fc35556bb23b18e9bc4c4f6988e0c7d6c41793adf474f7f5e58c640e4',
 'original-component/preflight-20261128/observer-manifest.json': 'd62a43d67d16f20c5b094bf637c354d5834ed00107957fea7b7c81797ae6e429',
 'original-component/preflight-20261128/receipts.json': 'd0db209556cc06c819eb5c7fca985d3920626942746f646fcdef59cc4fad07b6',
 'original-component/preflight-plain-uint8array-20261128/observer-manifest.json': 'e1aa20efa81c1153d648933714e035d3debfe0364515069f11a527f66fe2192e',
 'original-component/preflight-plain-uint8array-20261128/preflight-A.json': '2f772775a7eb6a28b6945a206c138f84c3d50bed12650fc14beea8828eba2b7f',
 'original-component/preflight-plain-uint8array-20261128/preflight-B.json': '4b628ec8347bbf8dcd7130903a62c3414bc1e6d318cce64f455cfa2c12a0bb81',
 'original-component/preflight-plain-uint8array-20261128/receipts.json': 'dacf52b8cc39eae13caebae1a182b1e69be6beea0b8e3ae2eca8a9de5cd48ff2',
}


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe(name):
    p = PurePosixPath(name)
    require(not p.is_absolute() and '..' not in p.parts and p.as_posix() == name and name not in ('', '.'), 'Unsafe member path')


def repack(payloads):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(payloads.items()):
            item = tarfile.TarInfo(name)
            item.size = len(data); item.mode = 0o644; item.mtime = 0
            item.uid = item.gid = 0; item.uname = item.gname = ''
            archive.addfile(item, io.BytesIO(data))
    result = io.BytesIO()
    with gzip.GzipFile(fileobj=result, mode='wb', filename='', mtime=0, compresslevel=9) as archive:
        archive.write(raw.getvalue())
    return result.getvalue()


def verify(evidence, repository=None, check_repack=False):
    manifest = json.loads((evidence / 'local-evidence-manifest.json.txt').read_bytes())
    require(manifest['schemaVersion'] == 1 and manifest['completeOriginalEvidence'] is False, 'Missing incomplete-evidence disclosure')
    require(manifest['unavailableOriginalOracle'] == {'sha256': ORACLE, 'available': False, 'notRecreated': True}, 'Original unavailable oracle was relabelled')
    code = Path(__file__).read_bytes()
    require(manifest['verifier'] == {'path': 'verify-local-evidence.py', 'bytes': len(code), 'sha256': sha(code)}, 'Verifier identity mismatch')
    record = manifest['archive']
    require(record['path'] == 'local-evidence.tar.gz', 'Unexpected archive path')
    archive_bytes = (evidence / record['path']).read_bytes()
    require(len(archive_bytes) == record['bytes'] and sha(archive_bytes) == record['sha256'], 'Archive identity mismatch')
    records = {row['member']: row for row in manifest['members']}
    require(len(records) == len(manifest['members']) == record['memberCount'], 'Duplicate or missing manifest members')
    payloads = {}
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
        for item in archive.getmembers():
            safe(item.name)
            require(item.isfile() and item.name not in payloads and item.name in records, 'Unexpected archive member')
            require(item.mode == 0o644 and item.uid == item.gid == item.mtime == 0 and item.uname == item.gname == '', 'Noncanonical archive metadata')
            with archive.extractfile(item) as stream:
                data = stream.read()
            expected = records[item.name]
            require(len(data) == item.size == expected['bytes'] and sha(data) == expected['sha256'], 'Member identity mismatch')
            payloads[item.name] = data
    require(list(payloads) == sorted(records) and sum(map(len, payloads.values())) == record['payloadBytes'], 'Archive coverage mismatch')
    require(set(ORIGINALS) <= payloads.keys(), 'Required original missing')
    for name, digest in ORIGINALS.items():
        require(sha(payloads[name]) == digest, 'Pre-loss original hash mismatch: ' + name)
    expected_inputs = {kind: {'member': 'original-component/' + name, 'bytes': len(payloads['original-component/' + name]),
                             'sha256': ORIGINALS['original-component/' + name]}
                       for kind, name in [('observer', 'observe.mjs'), ('controller', 'run.py'), ('plan', 'plan.json')]}
    require(manifest['componentInputs'] == expected_inputs, 'Only three exact recovered component inputs are permitted')
    load = lambda name: json.loads(payloads[name])
    plan = load('original-component/plan.json')
    report = load('original-component/failed-cohort/report.json')
    outer = load('original-component/failed-cohort/controller-receipt.json')
    require(report == {'complete': False, 'manifestSha256': ORIGINALS['original-component/observer-manifest.json'],
                       'planSha256': ORIGINALS['original-component/plan.json'], 'plan': plan, 'observations': [], 'failure': None}, 'Original failed zero-data report changed')
    require(outer['exitCode'] is None and outer['signal'] == 9 and outer['logSha256'] == sha(payloads['original-component/failed-cohort/controller.log']), 'Failure receipt mismatch')
    require(plan['sources']['A'] == plan['sources']['C'] and plan['sources']['A']['commit'] == BASELINE and
            plan['sources']['B']['commit'] == CANDIDATE and plan['sources']['B']['tree'] == TREE, 'Original source identities changed')
    require(plan['freshProcesses'] == 36 and plan['sweeps'] == {'cold': 1, 'postcold': 4, 'selectiveDiscard': False, 'steadyStateClaim': False}, 'Original schedule changed')
    require(plan['oracle']['sha256'] == ORACLE and plan['continuation']['onFailure'] == 'hold; no unchanged local rerun', 'Original oracle/failure policy changed')
    ast.parse(payloads['original-component/run.py'])
    observer = payloads['original-component/observe.mjs'].decode()
    require(observer.index("if (mode === 'preflight')") < observer.index('process.exit(0)') < observer.index('inflateCompressedTermBankSourcesWasm(group, {}, true)'), 'Original preflight performs a decode')
    original_preflight = load('original-component/preflight-20261128/receipts.json')
    require(original_preflight[-1]['returnCode'] == 1, 'Original preflight failure missing')
    corrected = load('original-component/preflight-plain-uint8array-20261128/receipts.json')
    for receipt, arm in zip(corrected, ['A', 'B']):
        require(receipt['returnCode'] == 0 and receipt['command'][-1] == 'preflight', 'Corrected preflight mode/result changed')
        value = load('original-component/preflight-plain-uint8array-20261128/preflight-' + arm + '.json')
        require(value['preflight'] is True and value['noDecodeOrTimingObservation'] is True and value['source'] == plan['sources'][arm], 'Corrected preflight relabelled')
    prior = load('original-reviews/prior-work-failure-review.json')
    require(prior['observedChildren'] == prior['completedSweeps'] == 0 and prior['signal'] == 9 and
            prior['continuation']['eligibleFromThisCohort'] is False and all(v is None for v in prior['statistics'].values()), 'Historical failure audit changed')
    storage = load('original-reviews/storage-structured-failure-assessment.json')
    require(storage['status'] == 'FAILED_BEFORE_FIRST_CHILD' and storage['innerReport'] == {'complete': False, 'observations': [], 'failure': None} and
            storage['controller']['signal'] == 9 and storage['noNewAcquisition'] is True, 'Independent failure assessment changed')
    availability = load(manifest['availabilityMember'])
    require(availability['completeOriginalEvidence'] is False and availability['historicalReviewIsPreReset'] is True and
            availability['missingRawEvidenceIsNotRecreated'] is True and availability['newHostedOracleIsIndependent'] is True and
            availability['unavailableInventoryComplete'] is False, 'Missing loss/qualification limitations')
    require(len(availability['oldComponentFiles']) == len(prior['files']), 'Incomplete historical inventory reconciliation')
    for row in availability['oldComponentFiles']:
        name = row['originalPath'].removeprefix('profile/short-word-screen/')
        require({'bytes': row['bytes'], 'sha256': row['sha256']} == prior['files'][name], 'Original inventory identity changed')
        member = row['availableMember']
        if member is not None:
            require(member in payloads and sha(payloads[member]) == row['sha256'] and len(payloads[member]) == row['bytes'], 'Recovery availability overclaimed')
        else:
            require(row['availability'] == 'unavailable after reset', 'Unavailable member mislabelled')
    require(any(row['sha256'] == ORACLE for row in availability['otherUnavailableEvidence']), 'Missing original census loss record')
    require(not any(sha(data) == ORACLE for data in payloads.values()), 'Unavailable oracle was unexpectedly substituted')
    product = manifest['originalProduct']
    require(product['baseline'] == BASELINE and product['commit'] == CANDIDATE and product['tree'] == TREE, 'Original product identity changed')
    require(product['sourceHashes']['dev/data/dictionary-wasm/term-bank-parser.wasm'] == plan['sources']['B']['wasmSha256'], 'Original native module changed')
    bundle = payloads[product['bundleMember']]
    header = bundle.split(b'\n\n', 1)[0]
    require(CANDIDATE.encode() in header and BASELINE.encode() in header, 'Original Git bundle identity mismatch')
    if repository:
        git = lambda *args: subprocess.check_output(['git', '-C', str(repository), *args])
        require(git('rev-parse', CANDIDATE + '^{tree}').decode().strip() == TREE, 'Original Git tree mismatch')
        require(set(git('diff', '--name-only', BASELINE, CANDIDATE).decode().splitlines()) == set(product['sourceHashes']), 'Original product delta mismatch')
        for path, digest in product['sourceHashes'].items():
            require(sha(git('show', CANDIDATE + ':' + path)) == digest, 'Original source Git object mismatch')
        with tempfile.NamedTemporaryFile(suffix='.bundle') as temporary:
            temporary.write(bundle); temporary.flush()
            result = subprocess.run(['git', '-C', str(repository), 'bundle', 'verify', temporary.name], capture_output=True, text=True)
            require(result.returncode == 0, 'Original Git bundle verification failed')
    if check_repack:
        require(repack(payloads) == archive_bytes, 'Deterministic repack differs')
    return {'status': 'PASS: available originals and explicit loss ledger verified', 'noNewAcquisition': True,
            'completeOriginalEvidence': False, 'archiveSha256': record['sha256'], 'members': len(payloads),
            'originalHashChecks': len(ORIGINALS), 'originalProduct': product,
            'localCohort': {'status': 'FAILED/HOLD', 'children': 0, 'sweeps': 0, 'signal': 9, 'timingEstimate': None},
            'unavailableOriginalOracle': ORACLE, 'originalProductGitVerified': bool(repository),
            'qualificationLimit': 'This archive does not reverify lost native census or raw validation logs. Historical reviews and transcript facts are labelled separately. The independently generated hosted oracle and full source/leak-enabled gates belong to the separate prospective study.'}, payloads


def main():
    require(__debug__, 'Do not run under optimized Python (-O)')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--repository', type=Path)
    parser.add_argument('--check-repack', action='store_true')
    parser.add_argument('--extract', type=Path)
    args = parser.parse_args()
    result, payloads = verify(args.evidence, args.repository, args.check_repack)
    if args.extract:
        require(not args.extract.exists(), 'Extraction destination must be new')
        args.extract.mkdir(parents=True)
        for name, data in payloads.items():
            target = args.extract / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        raise SystemExit(1) from error
