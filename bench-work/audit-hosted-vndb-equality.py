"""Acquire one immutable hosted ZIP and independently audit every prescribed cohort."""
from pathlib import Path, PurePosixPath
import argparse
import datetime
import hashlib
import io
import json
import stat
import subprocess
import urllib.request
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cell', type=Path, required=True)
parser.add_argument('--order', choices=['forward', 'reverse'], required=True)
parser.add_argument('--artifact-id', type=int, required=True)
parser.add_argument('--bytes', type=int, required=True)
parser.add_argument('--sha256', required=True)
args = parser.parse_args()
workspace = Path(__file__).resolve().parent.parent
publication = read_json(workspace / 'native-analysis/native-vndb-equality-hosted-publish-receipt.json')
manifest = read_json(workspace / 'native-analysis/native-vndb-equality-publish-v1.json')
package = workspace / 'native-analysis/native-vndb-equality-hosted-v1/dev/perf/native-vndb-equality-component-20261128-eef4'
protocol = read_json(package / 'protocol.json')
source_identity_names = {
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/term-content-ownership.js',
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/js/dictionary/term-lookup-route.js',
    'ext/js/dictionary/term-record-preinterned-plan.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'ext/js/dictionary/wasm/term-bank-inflate.c',
    'dev/data/dictionary-wasm/manifest.json',
    'ext/lib/term-bank-parser.wasm', 'package-lock.json',
}
assert publication['allBlobsAndCompleteTreeVerified']
assert publication['branch'] == 'experiment/native-vndb-equality-component-20261128-eef4'
assert publication['baseline'] == manifest['baseline'] == protocol['baseline']
assert publication['tree'] == manifest['tree']
assert isinstance(publication['diagnosticRun'], int) and publication['diagnosticRun'] > 0
assert protocol['dictionary'] == 'vndb'
assert protocol['variantOrder'] == ['equality-bounded-tail']
assert protocol['rows'] == 6648310 and protocol['expectedGroups'] == 170
assert protocol['expectedDigest'] == 'fa7435ef7e6f3583e3f06e971c889d02122f899a92ec438d313edbd5a889b3cf'
for item in manifest['files']:
    assert sha(Path(item['localPath']).read_bytes()) == item['sha256']
root = args.cell.resolve()
root.mkdir(parents=True, exist_ok=True)
receipt_path = root / 'independent-audit.json'
assert not receipt_path.exists(), 'Do not overwrite an artifact audit'
reference = read_json(root / 'artifact-reference.json')
assert reference['artifact_id'] == args.artifact_id
with urllib.request.urlopen(reference['file_uri']['download_url'], timeout=60) as response:
    archive_bytes = response.read()
assert len(archive_bytes) == args.bytes
assert sha(archive_bytes) == args.sha256
download = {'artifactId': args.artifact_id, 'bytes': len(archive_bytes), 'sha256': sha(archive_bytes),
            'wholeArchiveVerified': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
(root / 'download-receipt.json').write_text(json.dumps(download, indent=2) + '\n')
files = []
with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
    names = archive.namelist()
    assert len(names) == len(set(names))
    for item in archive.infolist():
        path = PurePosixPath(item.filename)
        assert not path.is_absolute() and '..' not in path.parts
        assert not stat.S_ISLNK(item.external_attr >> 16)
        if item.is_dir():
            continue
        target = root / 'raw' / path
        assert not target.exists()
        target.parent.mkdir(parents=True, exist_ok=True)
        data = archive.read(item)
        target.write_bytes(data)
        files.append({'path': item.filename, 'bytes': len(data), 'sha256': sha(data)})
del archive_bytes
raw = root / 'raw'
campaign_path = raw / 'campaign.json'
receipt = {'schema': 1, 'artifact': download, 'order': args.order,
           'workflowCommit': publication['commit'], 'workflowRun': publication['diagnosticRun'],
           'auditorSha256': sha(Path(__file__).read_bytes()), 'files': files,
           'cohorts': [], 'complete': False,
           'scope': 'Actual preloaded production parser-worker component only. No complete-import or browser-memory claim. Every raw observation and failure remains.'}


def save():
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')


save()
if not campaign_path.exists():
    receipt['status'] = 'admission-failed-before-campaign'
    save()
    print(json.dumps({'status': receipt['status'], 'artifactId': args.artifact_id}))
    raise SystemExit(0)
campaign = read_json(campaign_path)
assert campaign['order'] == args.order
assert campaign['protocolSha256'] == sha((package / 'protocol.json').read_bytes())
assert campaign['host']['workflowSha'] == publication['commit']
assert str(campaign['host']['runId']) == str(publication['diagnosticRun'])
assert str(campaign['host']['runAttempt']) == '1'
names = protocol['variantOrder'] if args.order == 'forward' else list(reversed(protocol['variantOrder']))
orders = protocol['orders'] if args.order == 'forward' else [order[::-1] for order in reversed(protocol['orders'])]
assert campaign['variantOrder'] == names
assert [item['candidate'] for item in campaign['plans']] == names
campaign_result = read_json(raw / 'campaign-result.json') if (raw / 'campaign-result.json').exists() else None
if campaign_result is not None:
    assert campaign_result['campaignSha256'] == sha(campaign_path.read_bytes())
    assert len(campaign_result['cohorts']) <= len(names)
    assert [item['candidate'] for item in campaign_result['cohorts']] == names[:len(campaign_result['cohorts'])]
def audit_cohort(item, record):
    name = item['candidate']
    directory = raw / name
    plan_path = directory / 'plan.json'
    assert sha(plan_path.read_bytes()) == item['sha256']
    plan = read_json(plan_path)
    for field, expected in protocol.items():
        if field not in {'variants', 'variantOrder', 'orders'}:
            assert plan[field] == expected, f'Frozen protocol field changed: {field}'
    assert plan['candidate'] == name and plan['orders'] == orders
    assert plan['baseline'] == protocol['baseline']
    assert plan['baselineTree'] == manifest['baselineTree']
    assert plan['nodeVersion'] == protocol['nodeVersion']
    assert plan['nodeExecutableSha256'] == campaign['nodeExecutableSha256']
    assert plan['host'] == campaign['host']
    assert plan['fixtureSha256'] == protocol['fixtureSha256']
    assert plan['expectedDigest'] == protocol['expectedDigest']
    assert plan['protocolSha256'] == campaign['protocolSha256']
    assert plan['NODE_OPTIONS'] == ''
    assert plan['candidateSourceSha256'] == protocol['variants'][name]['sourceSha256']
    assert plan['candidateWasmSha256'] == protocol['variants'][name]['wasmSha256']
    for filename, expected_sha in plan['runnerHashes'].items():
        assert sha((directory / 'runners' / filename).read_bytes()) == expected_sha
        assert (directory / 'runners' / filename).read_bytes() == (package / filename).read_bytes()
    assert set(plan['runnerHashes']) == {'prepare.py', 'campaign.py', 'run.py', 'summarize.py', 'preloaded-worker-server.mjs', 'protocol.json', 'prerequisites.json'}
    assert plan['controllerSha256'] == plan['runnerHashes']['run.py']
    assert plan['serverSha256'] == plan['runnerHashes']['preloaded-worker-server.mjs']
    variant = directory / 'variant'
    assert sha((variant / 'variant.json').read_bytes()) == plan['candidateBuildReceiptSha256']
    assert sha((variant / 'ext/js/dictionary/wasm/term-bank-parser.c').read_bytes()) == plan['candidateSourceSha256']
    assert sha((variant / 'ext/lib/term-bank-parser.wasm').read_bytes()) == plan['candidateWasmSha256']
    assert sha((directory / 'identities/baseline.c').read_bytes()) == protocol['baselineSourceSha256']
    assert sha((directory / 'identities/baseline.wasm').read_bytes()) == protocol['baselineWasmSha256']
    assert sha((directory / 'identities/baseline-manifest.json').read_bytes()) == protocol['baselineManifestSha256']
    result_path = directory / 'result.json'
    record['sourceAndModuleBindingsPassed'] = True
    campaign_record = next((part for part in campaign_result['cohorts'] if part['candidate'] == name), None) if campaign_result else None
    if campaign_record is not None:
        assert campaign_record['planSha256'] == item['sha256']
        record['campaignRecord'] = campaign_record
    save()
    if not result_path.exists():
        record['status'] = 'cohort-not-started'
        save()
        return
    result = read_json(result_path)
    assert result['plan'] == plan
    assert result['planSha256'] == item['sha256']
    assert result['controllerSha256'] == plan['controllerSha256']
    record['resultSha256'] = sha(result_path.read_bytes())
    record['observationsRetained'] = len(result['observations'])
    schedule = [(block, arm) for block, order in enumerate(orders) for arm in order]
    assert len(result['observations']) <= len(schedule)
    assert [(part['block'], part['arm']) for part in result['observations']] == schedule[:len(result['observations'])]
    raw_checks = []
    record['rawPrefixChecks'] = raw_checks
    expected_source_identity = {source: sha((workspace / 'bench-base' / source).read_bytes()) for source in source_identity_names}
    for position, observation in enumerate(result['observations']):
        terminal = position == len(result['observations']) - 1
        label = f"block-{observation['block'] + 1}-{observation['arm']}"
        assert observation['order'] == orders[observation['block']]
        expected_output = str(Path(item['path']).parent / (label + '.json'))
        expected_command = [plan['nodeExecutable'], plan['serverPath'],
                            '--source-root', plan['baselineRoot'], '--cache-dir', plan['cacheDir'],
                            '--dictionary', plan['dictionary'], '--parser-workers', '3',
                            '--warmups', '2', '--runs', '1', '--out', expected_output]
        if observation['arm'] == 'B':
            expected_command.extend(['--variant-root', plan['variantRoot']])
        assert observation['command'] == expected_command
        if not terminal:
            assert observation.get('returnCode') == 0 and 'measurement' in observation
        if 'rawReport' not in observation:
            assert terminal and not result['complete'], 'Controller cannot continue past missing child output'
            raw_checks.append({'label': label, 'rawReceiptAvailable': False})
            continue
        recorded = observation['rawReport']
        assert recorded['path'] == expected_output
        data = (directory / (label + '.json')).read_bytes()
        assert sha(data) == recorded['sha256'] and len(data) == recorded['bytes']
        check = {'label': label, 'rawReceiptAvailable': True, 'bytes': len(data), 'sha256': sha(data)}
        raw_checks.append(check)
        try:
            child = json.loads(data)
            check['childComplete'] = child['complete']
            check['passesRetained'] = len(child['observations'])
            assert child['identity'] == expected_source_identity
            assert child['node'] == protocol['nodeVersion']
            assert child['runnerSha256'] == protocol['serverSha256']
            assert child['fixture']['sha256'] == protocol['fixtureSha256']
            assert child['fixture']['sizeBytes'] == protocol['fixtureBytes']
            assert child['fixture']['rows'] == protocol['rows']
            assert child['grouping']['workerCountPolicy'] == protocol['workerCountPolicy']
            for field, expected_value in protocol['expectedGrouping'].items():
                assert child['grouping'][field] == expected_value
            assert len(child['grouping']['groups']) == protocol['expectedGroups']
            bank_lists = json.dumps(child['grouping']['groups'], separators=(',', ':'), ensure_ascii=True).encode('utf-8')
            assert sha(bank_lists) == protocol['expectedGroupBankListsSha256']
            expected_module = plan['candidateWasmSha256'] if observation['arm'] == 'B' else plan['baselineWasmSha256']
            assert child['injectedWasmSha256'] == expected_module
            if observation['arm'] == 'B':
                assert child['diagnosticNativeOverride']['sourceSha256'] == plan['candidateSourceSha256']
            else:
                assert child['diagnosticNativeOverride'] is None
            if 'node' in observation:
                assert child['node'] == observation['node'] and child['v8'] == observation['v8']
            assert [part['pass'] for part in child['observations']] == list(range(len(child['observations'])))
            assert len(child['observations']) <= 4
            if not terminal or result['complete']:
                assert child['complete'] and len(child['observations']) == 4
                assert child['observations'][3]['digest'] == protocol['expectedDigest']
            for index, part in enumerate(child['observations']):
                assert part['warmup'] == (index < 2)
                assert part['timed'] == (index == 2)
                assert part['verification'] == (index == 3)
                assert [group['index'] for group in part['groups']] == list(range(len(part['groups'])))
                pass_finished = index < len(child['observations']) - 1 or child['complete'] or (
                    isinstance(part.get('memory'), dict) and 'maxRSSKiB' in part
                )
                if pass_finished:
                    assert len(part['groups']) == protocol['expectedGroups']
                    assert part['rows'] == protocol['rows']
                    expected_counts = protocol['expectedVerificationWorkCounts'] if part['verification'] else protocol['expectedWorkCounts']
                    assert part['workCounts'] == expected_counts
                    assert part['transferBytes'] == protocol['expectedTransferBytes']
                    if part['verification']:
                        assert part['digest'] == protocol['expectedDigest']
                else:
                    assert len(part['groups']) <= protocol['expectedGroups']
                    assert terminal and not result['complete'] and not child['complete']
                    assert index == len(child['observations']) - 1
            check['availableChildIdentitiesPassed'] = True
        except json.JSONDecodeError as error:
            assert terminal and not result['complete'], 'Controller cannot continue past malformed raw JSON'
            check['partialRawParseError'] = str(error)
        save()
    if campaign_record is not None and 'resultSha256' in campaign_record:
        assert campaign_record['resultSha256'] == record['resultSha256']
    if not result['complete'] or campaign_record is None or not campaign_record.get('complete'):
        record['status'] = 'incomplete-no-effect-estimate'
        record['error'] = result.get('error')
        save()
        return
    assert campaign_record['acquisitionReturnCode'] == 0
    assert campaign_record['summaryReturnCode'] == 0
    assert campaign_record['resultSha256'] == record['resultSha256']
    assert set(result['sourceIdentity']) == source_identity_names
    expected_source_identity = {name: sha((workspace / 'bench-base' / name).read_bytes()) for name in source_identity_names}
    assert result['sourceIdentity'] == expected_source_identity
    assert result['digest'] == protocol['expectedDigest']
    assert result['expectedWorkCounts'] == protocol['expectedWorkCounts']
    assert result['expectedVerificationWorkCounts'] == protocol['expectedVerificationWorkCounts']
    assert result['expectedTransferBytes'] == protocol['expectedTransferBytes']
    for observation in result['observations']:
        own = directory / Path(observation['rawReport']['path']).name
        child = read_json(own)
        assert child['node'] == protocol['nodeVersion']
        assert all(part['rows'] == protocol['rows'] for part in child['observations'])
        assert child['grouping']['workerCountPolicy'] == protocol['workerCountPolicy']
        assert child['fixture']['sizeBytes'] == protocol['fixtureBytes']
        if observation['arm'] == 'B':
            assert child['diagnosticNativeOverride']['sourceSha256'] == plan['candidateSourceSha256']
        else:
            assert child['diagnosticNativeOverride'] is None
    summary_path = root / f'{name}-strict-summary-independent.json'
    with (root / f'{name}-strict-summary-independent.log').open('wb') as log:
        subprocess.run(['python3', str(package / 'summarize.py'), '--result', str(result_path),
                        '--out', str(summary_path)], stdout=log, stderr=subprocess.STDOUT, check=True)
    summary = read_json(summary_path)
    assert summary == read_json(directory / 'strict-summary.json')
    assert summary['comparisons'] == result['comparisons']
    assert summary['armMedians'] == result['armMedians']
    assert summary['perBlock'] == result['perBlock']
    record.update({'complete': True, 'status': 'all-prescribed-observations-and-parity-passed',
                   'rawPasses': 72, 'warmups': 36, 'timedPasses': 18, 'verificationPasses': 18,
                   'digest': result['digest'], 'summarySha256': sha(summary_path.read_bytes()),
                   'comparisons': summary['comparisons'], 'armMedians': summary['armMedians']})
    save()


for item in campaign['plans']:
    record = {'candidate': item['candidate'], 'planSha256': item['sha256'], 'complete': False,
              'sourceAndModuleBindingsPassed': False}
    receipt['cohorts'].append(record)
    save()
    try:
        audit_cohort(item, record)
    except Exception as error:
        record['complete'] = False
        record['status'] = 'independent-audit-failed-no-effect-estimate'
        record['auditError'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        save()
receipt['complete'] = len(receipt['cohorts']) == 1 and all(item['complete'] for item in receipt['cohorts'])
receipt['campaignCompleteReported'] = campaign_result['complete'] if campaign_result is not None else False
receipt['auditedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
if receipt['complete']:
    assert receipt['campaignCompleteReported']
    for name in ['context/baseline-final.diff', 'context/harness-final.diff']:
        assert (raw / name).read_bytes() == b''
save()
print(json.dumps({'artifactId': args.artifact_id, 'complete': receipt['complete'],
                  'cohorts': [{key: value for key, value in item.items() if key in {'candidate', 'status', 'complete', 'rawPasses'}} for item in receipt['cohorts']]}))
