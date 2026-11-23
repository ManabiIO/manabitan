"""Create path-adapted media runners; preserve the original runners and receipts."""

import argparse
import hashlib
import json
from pathlib import Path
import re


def sha_file(filename):
    digest = hashlib.sha256()
    with Path(filename).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify_patch_postimages(patch, root):
    for section in patch.read_text().split('diff --git ')[1:]:
        identity = re.search(r'^index [0-9a-f]+\.\.([0-9a-f]+)', section, re.MULTILINE)
        filename = re.search(r'^\+\+\+ b/(.+)$', section, re.MULTILINE)
        if identity is None or filename is None:
            continue
        data = (root / filename.group(1)).read_bytes()
        digest = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        assert digest.startswith(identity.group(1)), f'Candidate does not match patch: {filename.group(1)}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant', choices=['pooled', 'direct', 'held-batch'], default='pooled')
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    baseline = args.baseline.resolve()
    candidate = args.candidate.resolve()
    archive = args.archive.resolve()
    output = args.output.resolve()
    assert package.parent != output and package.parent not in output.parents, 'Use an output directory outside the preserved package'
    assert not output.exists(), 'Use a fresh output directory'
    assert archive.stat().st_size == 291705969
    assert sha_file(archive) == 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792'
    parser_hash = 'cc749c53fc32dfb28eefbd69f99868f8c303caa1a3f1354231516dfa5a6e1b0f'
    assert sha_file(baseline / 'ext/lib/term-bank-parser.wasm') == parser_hash
    assert sha_file(candidate / 'ext/lib/term-bank-parser.wasm') == parser_hash
    provenance = json.loads((package / 'provenance.json').read_text())
    if args.variant == 'held-batch':
        originals = package.parent / 'held-media-batch'
        files = {'run-arm.mjs': 'run-arm.mjs', 'run.py': 'run.py'}
        verify_patch_postimages(originals / 'candidate.patch', candidate)
    else:
        originals = package
        files = {'capture.mjs': 'capture.mjs', 'run.py': 'run.py'}
        for filename, expected in provenance['baseline']['files'].items():
            assert sha_file(baseline / filename) == expected, f'Baseline changed: {filename}'
        if args.variant == 'pooled':
            files.update({'replay.mjs': 'replay.mjs', 'retention.py': 'retention.py'})
            files.update({
                'full-media-parity/run.py': 'full-media-parity/run.py',
                'full-media-parity/run-arm.mjs': 'full-media-parity/run-arm.mjs',
            })
            for filename, expected in provenance['candidate']['files'].items():
                assert sha_file(candidate / filename) == expected, f'Candidate changed: {filename}'
        else:
            files['direct-buffer-replay.mjs'] = 'replay.mjs'
            verify_patch_postimages(originals / 'direct-buffer-candidate.patch', candidate)
    output.mkdir(parents=True)
    original_baseline = '/workspace/scratch/71149a79699f/manabitan'
    replacements = {
        original_baseline: str(baseline),
        '/workspace/scratch/71149a79699f/manabitan-plan-scratch-base': str(baseline),
        '/workspace/scratch/71149a79699f/manabitan-media-iteration2': str(candidate),
        original_baseline + '/ext/lib/term-bank-parser.wasm': str(baseline / 'ext/lib/term-bank-parser.wasm'),
        '/workspace/scratch/fcfffdc555c8/fixtures/vndb_characters_by_bee.zip': str(archive),
        '/workspace/scratch/71149a79699f/media-diagnostics-study-20261123/native-media-chunks.bin': str(output / 'native-media-chunks.bin'),
    }
    records = []
    for source_name, destination_name in files.items():
        source = originals / source_name
        text = source.read_text()
        is_javascript = source.suffix == '.mjs'
        for old, new in replacements.items():
            text = text.replace(repr(old), json.dumps(new) if is_javascript else repr(new))
        if source_name == 'run-arm.mjs':
            escaped = str(baseline / 'ext/lib').replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')
            text = text.replace(original_baseline + '/ext/lib/${filename}', escaped + '/${filename}')
        destination = output / destination_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(text)
        records.append({'original': str(source), 'originalSha256': sha_file(source), 'adapted': str(destination), 'adaptedSha256': sha_file(destination)})
    (output / 'runner-provenance.json').write_text(json.dumps({
        'variant': args.variant, 'baseline': str(baseline), 'candidate': str(candidate), 'archive': str(archive),
        'note': 'Only literal filesystem paths were adapted. Observation schedules and measured production calls are unchanged. No observations have been run by this preparer.',
        'runners': records,
    }, indent=2) + '\n')
    print(json.dumps({'directory': str(output), 'runners': list(files.values())}, indent=2))


if __name__ == '__main__':
    main()
