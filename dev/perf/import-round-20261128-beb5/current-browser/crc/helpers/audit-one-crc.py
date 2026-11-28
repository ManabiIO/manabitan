"""Acquire no new measurements; audit one already downloaded original CRC artifact."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path('/tmp/manabitan-beb5/current-browser-artifacts')
RECEIPTS = ROOT / 'crc-receipts'
SOURCE = Path('/tmp/manabitan-beb5/crc-current-audit-source')
HELPER = RECEIPTS / 'verify-extract-and-summarize.py'
AUDITOR = SOURCE / 'dev/perf/crc-no-unroll-browser-20261128-beb5/audit-browser.py'
DICTIONARY = sys.argv[1]
assert DICTIONARY in ['jmdict', 'jitendex', 'vndb']
assert hashlib.sha256(HELPER.read_bytes()).hexdigest() == 'd4c9d2201ac0e5fc4ebe57d381ebe3caf9c34488711798a4303e7d52d5b27ff4'
assert hashlib.sha256(AUDITOR.read_bytes()).hexdigest() == 'b9fa8c952d63e712cad908a58a5d1e0d71d0b25d5ffd0927203255e71d306cf5'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip() == '477fb271ef25fac533fb1faf737a5dab898190e3'
assert subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=SOURCE) == b''
output = ROOT / ('crc-' + DICTIONARY)
census = RECEIPTS / (DICTIONARY + '-census.json')
assert not output.exists() and not census.exists(), 'Never replace an extraction or earlier audit attempt'
commands = [
    ('extract', [sys.executable, str(HELPER), 'extract', DICTIONARY,
                 '--zip', str(ROOT / ('crc-' + DICTIONARY + '.zip')),
                 '--metadata', str(RECEIPTS / (DICTIONARY + '-artifact-api.json')),
                 '--run', str(RECEIPTS / (DICTIONARY + '-run-api.json')),
                 '--job', str(RECEIPTS / (DICTIONARY + '-job-api.json')),
                 '--out', str(output), '--census', str(census)]),
    ('frozen-audit', [sys.executable, str(AUDITOR), str(output),
                      '--out', str(output / 'local-independent-audit.json')]),
    ('absolute-summary', [sys.executable, str(HELPER), 'summarize',
                          '--audit', str(output / 'local-independent-audit.json'),
                          '--census', str(census),
                          '--out', str(RECEIPTS / (DICTIONARY + '-absolute-summary.json'))]),
]
report = {'dictionary': DICTIONARY, 'python': sys.version,
          'launcherSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'scope': 'Analysis of original fixed observations only; frozen auditor is unchanged.',
          'results': []}
for name, command in commands:
    stdout = RECEIPTS / (DICTIONARY + '-' + name + '.stdout')
    stderr = RECEIPTS / (DICTIONARY + '-' + name + '.stderr')
    with stdout.open('xb') as a, stderr.open('xb') as b:
        result = subprocess.run(command, cwd=SOURCE, stdout=a, stderr=b)
    row = {'stage': name, 'command': command, 'exitCode': result.returncode,
           'stdout': str(stdout), 'stderr': str(stderr),
           'stdoutSha256': hashlib.sha256(stdout.read_bytes()).hexdigest(),
           'stderrSha256': hashlib.sha256(stderr.read_bytes()).hexdigest()}
    report['results'].append(row)
    (RECEIPTS / (DICTIONARY + '-local-stages.json')).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(row), flush=True)
    if result.returncode:
        print(stderr.read_text(errors='replace')[-5000:])
        break
assert subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=SOURCE) == b''
