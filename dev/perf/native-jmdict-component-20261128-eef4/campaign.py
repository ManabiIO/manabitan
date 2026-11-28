"""Run every registered candidate cohort once; retain failures and continue the schedule."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import subprocess


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--campaign', type=Path, required=True)
args = parser.parse_args()
campaign = json.loads(args.campaign.read_text())
root = args.campaign.resolve().parent
result_path = root / 'campaign-result.json'
assert not result_path.exists(), 'Do not repeat or resume an acquisition'
assert not os.environ.get('NODE_OPTIONS')
result = {'schema': 1, 'complete': False, 'campaignSha256': sha(args.campaign),
          'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'cohorts': []}


def save():
    result_path.write_text(json.dumps(result, indent=2) + '\n')


def guard(path, expected_sha):
    assert sha(path) == expected_sha
    plan = json.loads(path.read_text())
    assert not os.environ.get('NODE_OPTIONS')
    for name, expected in plan['runnerHashes'].items():
        assert sha(path.parent / 'runners' / name) == expected
    assert sha(Path(plan['nodeExecutable'])) == plan['nodeExecutableSha256']
    variant = Path(plan['variantRoot'])
    assert sha(variant / 'variant.json') == plan['candidateBuildReceiptSha256']
    assert sha(variant / 'ext/js/dictionary/wasm/term-bank-parser.c') == plan['candidateSourceSha256']
    assert sha(variant / 'ext/lib/term-bank-parser.wasm') == plan['candidateWasmSha256']
    baseline = Path(plan['baselineRoot'])
    assert subprocess.check_output(['git', '-C', str(baseline), 'rev-parse', 'HEAD'], text=True).strip() == plan['baseline']
    assert not subprocess.check_output(['git', '-C', str(baseline), 'status', '--porcelain', '--untracked-files=no'], text=True).strip()
    return plan


save()
try:
    for item in campaign['plans']:
        path = Path(item['path'])
        record = {'candidate': item['candidate'], 'planSha256': item['sha256'],
                  'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        result['cohorts'].append(record)
        save()
        try:
            guard(path, item['sha256'])
            assert not (path.parent / 'result.json').exists()
            assert not list(path.parent.glob('block-*.json')) and not list(path.parent.glob('block-*.log'))
            with (path.parent / 'acquisition.log').open('wb') as log:
                child = subprocess.run(['python3', str(path.parent / 'runners/run.py'), '--plan', str(path)],
                                       stdout=log, stderr=subprocess.STDOUT)
            record['acquisitionReturnCode'] = child.returncode
            guard(path, item['sha256'])
            acquisition = path.parent / 'result.json'
            if acquisition.exists():
                record['resultSha256'] = sha(acquisition)
            assert child.returncode == 0
            with (path.parent / 'strict-summary.log').open('wb') as log:
                child = subprocess.run(['python3', str(path.parent / 'runners/summarize.py'),
                                        '--result', str(acquisition), '--out', str(path.parent / 'strict-summary.json')],
                                       stdout=log, stderr=subprocess.STDOUT)
            record['summaryReturnCode'] = child.returncode
            assert child.returncode == 0
            record['complete'] = True
        except BaseException as error:
            record['complete'] = False
            record['error'] = {'type': type(error).__name__, 'message': str(error)}
        record['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()
        print(json.dumps(record), flush=True)
    result['complete'] = len(result['cohorts']) == len(campaign['plans']) and all(item['complete'] for item in result['cohorts'])
finally:
    result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
raise SystemExit(0 if result['complete'] else 1)
