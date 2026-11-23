import hashlib
import json
import os
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).parent / 'crc-words-screen'
OUT.mkdir(exist_ok=True)
ROOTS = {
    'baseline': Path('/workspace/scratch/71149a79699f/manabitan-plan-scratch-base'),
    'candidate': Path('/workspace/scratch/71149a79699f/manabitan-native-round2'),
}
FIXTURES = {
    'jmdict': ('/workspace/scratch/71149a79699f/manabitan/builds/e2e-dictionary-cache/JMdict.zip', '7681ee09f9edfef48a5e50773565da237424eb750bdb0e1e59660784ecd53e8a'),
    'jitendex': ('/workspace/scratch/71149a79699f/manabitan/builds/e2e-dictionary-cache/jitendex-yomitan.zip', '8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc'),
    'vndb': ('/workspace/scratch/fcfffdc555c8/fixtures/vndb_characters_by_bee.zip', 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792'),
}

def sha(data):
    return hashlib.sha256(data).hexdigest()

report = {'preparedAtUtc': datetime.now(timezone.utc).isoformat(), 'variants': {}, 'corpora': {}}
compiler = os.environ['MANABITAN_CLANG']
linker = os.environ['MANABITAN_WASM_LD']
report['compilerVersion'] = subprocess.check_output([compiler, '--version'], text=True).splitlines()[0]
report['linkerVersion'] = subprocess.check_output([linker, '--version'], text=True).strip()
for label, root in ROOTS.items():
    manifest_path = root / 'dev/data/dictionary-wasm/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    target = next(t for t in manifest['targets'] if t['name'] == 'term-bank-parser.wasm')
    output = OUT / f'{label}-crc-test.wasm'
    command = [compiler, '-fuse-ld=' + linker, *target['arguments'], '-DTERM_BANK_CRC_TEST', '-Wl,--export=term_bank_crc32_test', '-o', str(output), *[str(root / s) for s in target['sources']]]
    subprocess.run(command, check=True)
    report['variants'][label] = {
        'root': str(root),
        'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'manifestSha256': sha(manifest_path.read_bytes()),
        'productWasmSha256': target['sha256'],
        'testModulePath': str(output),
        'testModuleSha256': sha(output.read_bytes()),
        'sources': {s: sha((root / s).read_bytes()) for s in target['sources']},
        'command': command,
    }
for label, (filename, expected_sha) in FIXTURES.items():
    archive = Path(filename)
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    assert digest.hexdigest() == expected_sha
    with zipfile.ZipFile(archive) as bundle:
        banks = sorted((i for i in bundle.infolist() if i.filename.startswith('term_bank_') and i.filename.endswith('.json')), key=lambda i: int(i.filename[10:-5]))
        selected = [banks[0], banks[len(banks) // 2], banks[-1]]
        corpus = {'archive': str(archive), 'archiveSha256': expected_sha, 'termBankCount': len(banks), 'banks': []}
        for entry in selected:
            data = bundle.read(entry)
            output = OUT / f'{label}-{entry.filename}.bin'
            output.write_bytes(data)
            corpus['banks'].append({'name': entry.filename, 'path': str(output), 'bytes': len(data), 'crc32': entry.CRC, 'sha256': sha(data)})
        report['corpora'][label] = corpus
patch = subprocess.check_output(['git', 'diff', '--binary', 'HEAD', '--', 'ext/js/dictionary/wasm/term-bank-parser.c', 'dev/data/dictionary-wasm', 'test/term-bank-crc.test.js'], cwd=ROOTS['candidate'])
(OUT / 'candidate.patch').write_bytes(patch)
report['candidatePatchSha256'] = sha(patch)
(OUT / 'inputs.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'inputs': str(OUT / 'inputs.json'), 'variants': {key: value['testModuleSha256'] for key, value in report['variants'].items()}, 'banks': {key: len(value['banks']) for key, value in report['corpora'].items()}}, indent=2))
