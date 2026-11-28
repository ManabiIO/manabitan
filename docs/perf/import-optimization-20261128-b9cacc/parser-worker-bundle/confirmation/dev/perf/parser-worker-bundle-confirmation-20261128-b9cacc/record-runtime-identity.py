"""Record exact source, harness, generated asset and optional package identities."""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--registration', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--package', type=pathlib.Path)
parser.add_argument('--browser-binary', type=pathlib.Path)
parser.add_argument('--extracted-bundle', type=pathlib.Path)
args = parser.parse_args()
registration_bytes = args.registration.read_bytes()
reg = json.loads(registration_bytes)


def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def command(*argv):
    return subprocess.check_output(argv, text=True).strip()


if args.output.exists():
    raise ValueError('Never overwrite a runtime identity receipt')
result = {'schemaVersion': 1, 'status': 'failed',
          'registrationSha256': hashlib.sha256(registration_bytes).hexdigest()}
try:
    result['sourceHead'] = command('git', 'rev-parse', 'HEAD')
    result['sourceTree'] = command('git', 'rev-parse', 'HEAD^{tree}')
    result['sourceStatus'] = command('git', 'status', '--porcelain')
    result['nodeVersion'] = command('node', '--version')
    control_root = args.registration.resolve().parents[3]
    result['workflowHead'] = command('git', '-C', str(control_root), 'rev-parse', 'HEAD')
    result['workflowRunId'] = int(os.environ['GITHUB_RUN_ID'])
    result['workflowRunAttempt'] = int(os.environ['GITHUB_RUN_ATTEMPT'])
    if result['workflowHead'] != os.environ['GITHUB_SHA'] or result['workflowRunAttempt'] != 1:
        raise ValueError('Control checkout/run differs from its first published attempt')
    if result['sourceHead'] != reg['candidate'] or result['sourceTree'] != reg['candidateTree'] or result['sourceStatus'] != '':
        raise ValueError('Runtime source checkout differs from the clean frozen candidate')
    if result['nodeVersion'] != reg['nodeVersion']:
        raise ValueError('Node version differs from the frozen runtime')
    result['sourceFileSha256'] = {}
    for name, expected in reg['sourceFileSha256'].items():
        actual = checksum(pathlib.Path(name))
        if actual != expected:
            raise ValueError('Frozen source/harness hash mismatch: ' + name)
        result['sourceFileSha256'][name] = actual
    result['generatedRuntimePayloads'] = {}
    for name, expected in reg['expectedRuntimePayloads'].items():
        source = pathlib.Path('ext') / name
        actual = {'sha256': checksum(source), 'bytes': source.stat().st_size}
        if actual != expected:
            raise ValueError('Generated/source runtime asset mismatch: ' + name)
        result['generatedRuntimePayloads'][name] = actual
    if args.package is not None:
        result['package'] = {'path': str(args.package), 'sha256': checksum(args.package), 'bytes': args.package.stat().st_size}
        with zipfile.ZipFile(args.package) as package:
            names = package.namelist()
            if len(names) != len(set(names)):
                raise ValueError('Package contains duplicate member names')
            for name, expected in reg['expectedRuntimePayloads'].items():
                data = package.read(name)
                if {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)} != expected:
                    raise ValueError('Packaged runtime asset mismatch: ' + name)
        result['package']['runtimePayloadsVerified'] = True
    if args.browser_binary is not None:
        result['browser'] = {'path': str(args.browser_binary.resolve()), 'sha256': checksum(args.browser_binary),
                             'versionOutput': command(str(args.browser_binary), '--version')}
    if args.extracted_bundle is not None:
        expected = reg['expectedRuntimePayloads']['js/dictionary/term-bank-wasm-parser-worker.bundle.js']
        actual = {'sha256': checksum(args.extracted_bundle), 'bytes': args.extracted_bundle.stat().st_size}
        if actual != expected:
            raise ValueError('Generated worker changed in the extracted instrumented package')
        result['extractedBundle'] = actual
    result['status'] = 'passed'
except Exception as error:
    result['failure'] = {'type': type(error).__name__, 'message': str(error)}
args.output.parent.mkdir(parents=True, exist_ok=True)
with args.output.open('x') as destination:
    json.dump(result, destination, indent=2, allow_nan=False)
    destination.write('\n')
print(json.dumps(result, indent=2, allow_nan=False))
raise SystemExit(0 if result['status'] == 'passed' else 1)
