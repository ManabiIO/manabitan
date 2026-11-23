"""Rebuild CRC inputs at caller-supplied paths without changing the originals."""

import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile
import zlib


def sha_file(filename):
    digest = hashlib.sha256()
    with Path(filename).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--archives', required=True, type=Path)
    parser.add_argument('--clang', required=True, type=Path)
    parser.add_argument('--linker', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    original_path = package / 'crc-words-screen/inputs.json'
    original = json.loads(original_path.read_text())
    inputs = copy.deepcopy(original)
    output = args.output.resolve()
    assert package != output and package not in output.parents, 'Use an output directory outside the preserved package'
    assert not output.exists(), 'Use a fresh output directory'
    output.mkdir(parents=True)
    compiler = str(args.clang.resolve())
    linker = str(args.linker.resolve())
    compiler_version = subprocess.check_output([compiler, '--version'], text=True).splitlines()[0]
    linker_version = subprocess.check_output([linker, '--version'], text=True).strip()
    assert '21.1.8' in compiler_version and '21.1.8' in linker_version, 'Use the pinned clang and LLD 21.1.8'
    assert sha_file(package / 'crc-words-screen/candidate.patch') == original['candidatePatchSha256']
    for label, root in [('baseline', args.baseline.resolve()), ('candidate', args.candidate.resolve())]:
        recorded = original['variants'][label]
        assert sha_file(root / 'dev/data/dictionary-wasm/manifest.json') == recorded['manifestSha256']
        assert sha_file(root / 'dev/data/dictionary-wasm/term-bank-parser.wasm') == recorded['productWasmSha256']
        for filename, expected in recorded['sources'].items():
            assert sha_file(root / filename) == expected, f'{label} source changed: {filename}'
        module = output / f'{label}-crc-test.wasm'
        command = []
        for index, argument in enumerate(recorded['command']):
            if index == 0:
                command.append(compiler)
            elif argument.startswith('-fuse-ld='):
                command.append('-fuse-ld=' + linker)
            elif argument == recorded['testModulePath']:
                command.append(str(module))
            elif argument.startswith(recorded['root'] + '/'):
                command.append(str(root / argument[len(recorded['root']) + 1:]))
            else:
                command.append(argument)
        subprocess.run(command, check=True)
        assert sha_file(module) == recorded['testModuleSha256'], f'{label} rebuilt module differs'
        inputs['variants'][label].update(root=str(root), testModulePath=str(module), command=command)
    for label, recorded in original['corpora'].items():
        archive = args.archives.resolve() / Path(recorded['archive']).name
        assert sha_file(archive) == recorded['archiveSha256'], f'{label} archive differs'
        inputs['corpora'][label]['archive'] = str(archive)
        with zipfile.ZipFile(archive) as bundle:
            names = [name for name in bundle.namelist() if name.startswith('term_bank_') and name.endswith('.json')]
            assert len(names) == recorded['termBankCount']
            for index, bank in enumerate(recorded['banks']):
                data = bundle.read(bank['name'])
                assert len(data) == bank['bytes']
                assert hashlib.sha256(data).hexdigest() == bank['sha256']
                assert zlib.crc32(data) == bank['crc32']
                filename = output / Path(bank['path']).name
                filename.write_bytes(data)
                inputs['corpora'][label]['banks'][index]['path'] = str(filename)
    inputs['reproduction'] = {
        'originalInputsSha256': sha_file(original_path),
        'compilerVersion': compiler_version,
        'linkerVersion': linker_version,
        'note': 'Original identities and all compilation flags are preserved; only artifact/source paths are relocated. Both rebuilt module hashes and every source/archive/bank hash match the original inputs.',
    }
    destination = output / 'inputs.reproduced.json'
    destination.write_text(json.dumps(inputs, indent=2) + '\n')
    print(json.dumps({'inputs': str(destination), 'verifiedModules': 2, 'verifiedBanks': sum(len(c['banks']) for c in original['corpora'].values())}, indent=2))


if __name__ == '__main__':
    main()
