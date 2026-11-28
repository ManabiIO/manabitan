#!/usr/bin/env python3
"""Build the single frozen pragma candidate; fail before timing on any mismatch."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
MODULES = OUT / 'modules'
MODULES.mkdir(exist_ok=False)
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
PARSER = 'ext/js/dictionary/wasm/term-bank-parser.c'
INFLATE = 'ext/js/dictionary/wasm/term-bank-inflate.c'
CLANG = os.environ.get('MANABITAN_CLANG', '/usr/bin/clang-21')
LINKER = os.environ.get('MANABITAN_WASM_LD', '/usr/bin/wasm-ld-21')
REGISTRATION = json.loads((HERE / 'registration.json').read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO)


def checkpoint(value):
    (OUT / 'build-progress.json').write_text(json.dumps(value, indent=2) + '\n')


def uleb(data, offset):
    result = shift = 0
    while True:
        byte = data[offset]
        offset += 1
        result |= (byte & 127) << shift
        if byte < 128:
            return result, offset
        shift += 7


def sections(data):
    assert data[:8] == b'\0asm\x01\0\0\0'
    offset = 8
    result = []
    while offset < len(data):
        section_id = data[offset]
        size, start = uleb(data, offset + 1)
        result.append((section_id, data[start:start + size]))
        offset = start + size
    assert offset == len(data)
    return result


checkpoint({'stage': 'source-checks'})
assert REGISTRATION['baselineCommit'] == BASE
parents = git('rev-list', '--parents', '-n', '1', 'HEAD').decode().split()
assert parents[1:] == [BASE], parents
assert git('diff', '--name-only') == b''
assert git('diff', '--cached', '--name-only') == b''
allowed = set(REGISTRATION['sourceFiles']) | {str((HERE / 'registration.json').relative_to(REPO))}
changes = [line.split('\t') for line in git('diff', '--name-status', BASE, 'HEAD').decode().splitlines()]
assert {path for status, path in changes} == allowed
assert all(status == 'A' for status, path in changes), changes
for path, expected in REGISTRATION['sourceFiles'].items():
    data = (REPO / path).read_bytes()
    assert sha(data) == expected, path
    assert data == git('show', f'HEAD:{path}'), path

source = git('show', f'{BASE}:{PARSER}')
assert source == (REPO / PARSER).read_bytes()
assert sha(source) == REGISTRATION['baselineSourceSha256']
assert git('show', f'{BASE}:{INFLATE}') == (REPO / INFLATE).read_bytes()
needle = b'''    for (uint32_t offset = 0u; offset < final_group; offset += step) {
        for (uint32_t i = 0u; i < CRC32_BRAIDS; ++i) {
'''
assert source.count(needle) == 1
candidate = source.replace(needle, needle.replace(
    b'        for (uint32_t i',
    b'        #pragma clang loop unroll(disable)\n        for (uint32_t i'))
assert sha(candidate) == REGISTRATION['candidateSourceSha256']
(MODULES / 'baseline.c').write_bytes(source)
(MODULES / 'candidate.c').write_bytes(candidate)

compiler_version = subprocess.check_output([CLANG, '--version'], text=True)
linker_version = subprocess.check_output([LINKER, '--version'], text=True)
assert re.search(r'\bversion 21\.1\.8(?:\s|$)', compiler_version), compiler_version
assert re.search(r'\bLLD 21\.1\.8(?:\s|$)', linker_version), linker_version
manifest_bytes = git('show', f'{BASE}:dev/data/dictionary-wasm/manifest.json')
manifest = json.loads(manifest_bytes)
target = next(entry for entry in manifest['targets'] if entry['name'] == 'term-bank-parser.wasm')
assert manifest['toolchain'] == {'compilerVersion': '21.1.8', 'linkerVersion': '21.1.8'}
assert target['sha256'] == REGISTRATION['baselineWasmSha256']
source_files = git('ls-files', 'ext/js/dictionary/wasm').decode().splitlines()
receipt = {
    'sourceCommit': parents[0],
    'sourceTree': git('rev-parse', 'HEAD^{tree}').decode().strip(),
    'soleParent': BASE,
    'changedPaths': changes,
    'registrationSha256': sha((HERE / 'registration.json').read_bytes()),
    'compilerVersion': compiler_version,
    'compilerSha256': sha(Path(CLANG).read_bytes()),
    'linkerVersion': linker_version,
    'linkerSha256': sha(Path(LINKER).read_bytes()),
    'packageVersions': subprocess.check_output(['dpkg-query', '-W', 'clang-21', 'lld-21'], text=True),
    'nativeSourceSha256': {name: sha((REPO / name).read_bytes()) for name in source_files},
    'baselineManifestSha256': sha(manifest_bytes),
    'variants': {},
}
for name in ['baseline', 'candidate']:
    checkpoint({'stage': 'build', 'variant': name, 'completed': receipt})
    production = MODULES / f'{name}.wasm'
    command = [CLANG, f'-fuse-ld={LINKER}', *target['arguments'], '-o', str(production),
               str(MODULES / f'{name}.c'), str(REPO / INFLATE)]
    subprocess.run(command, cwd=REPO, check=True)
    digest = sha(production.read_bytes())
    assert digest == REGISTRATION[f'{name}WasmSha256'], (name, digest)
    if name == 'baseline':
        assert production.read_bytes() == git('show', f'{BASE}:dev/data/dictionary-wasm/term-bank-parser.wasm')
    assembly_command = [CLANG, '--target=wasm32-freestanding', '-O3', '-matomics',
                        '-mbulk-memory', '-msimd128', '-nostdlib', '-S',
                        str(MODULES / f'{name}.c'), '-o', str(MODULES / f'{name}.s')]
    subprocess.run(assembly_command, cwd=REPO, check=True)
    test_command = list(command)
    test_command[test_command.index('-o') + 1] = str(MODULES / f'{name}-test.wasm')
    test_command += ['-DTERM_BANK_CRC_TEST', '-Wl,--export=term_bank_crc32_test']
    subprocess.run(test_command, cwd=REPO, check=True)
    receipt['variants'][name] = {
        'command': command,
        'sourceSha256': sha((MODULES / f'{name}.c').read_bytes()),
        'wasmSha256': digest,
        'wasmBytes': production.stat().st_size,
        'assemblyCommand': assembly_command,
        'assemblySha256': sha((MODULES / f'{name}.s').read_bytes()),
        'testCommand': test_command,
        'testWasmSha256': sha((MODULES / f'{name}-test.wasm').read_bytes()),
        'testScope': 'CRC vector correctness only; never used for performance.',
    }

pattern = r'^([A-Za-z_][A-Za-z_0-9]*):[^\n]*\n.*?^\s*end_function'
assemblies = {}
for name in ['baseline', 'candidate']:
    assemblies[name] = {
        match[1]: '\n'.join(' '.join(line.split()) for line in re.sub(r'#.*', '', match[0]).splitlines() if line.strip())
        for match in re.finditer(pattern, (MODULES / f'{name}.s').read_text(), re.M | re.S)
    }
assert assemblies['baseline'].keys() == assemblies['candidate'].keys()
changed_functions = [name for name in assemblies['baseline'] if assemblies['baseline'][name] != assemblies['candidate'][name]]
assert changed_functions == ['crc32_bytes']
base_sections = sections((MODULES / 'baseline.wasm').read_bytes())
candidate_sections = sections((MODULES / 'candidate.wasm').read_bytes())
assert [x for x in base_sections if x[0] not in (6, 10, 11)] == [x for x in candidate_sections if x[0] not in (6, 10, 11)]
base_data = next(data for kind, data in base_sections if kind == 11)
candidate_data = next(data for kind, data in candidate_sections if kind == 11)
assert base_data[:2] == candidate_data[:2] == b'\x01\x01'
base_size, base_start = uleb(base_data, 2)
candidate_size, candidate_start = uleb(candidate_data, 2)
assert candidate_size == base_size + 32
assert candidate_data[candidate_start:candidate_start + 32] == b'\xff' * 4 + b'\0' * 28
assert candidate_data[candidate_start + 32:] == base_data[base_start:]
base_globals = next(data for kind, data in base_sections if kind == 6)
candidate_globals = next(data for kind, data in candidate_sections if kind == 6)
assert base_globals[:4] == candidate_globals[:4] == b'\x02\x7f\x01\x41'
base_stack, base_end = uleb(base_globals, 4)
candidate_stack, candidate_end = uleb(candidate_globals, 4)
assert candidate_stack == base_stack + 32
assert base_globals[base_end:] == candidate_globals[candidate_end:]
receipt['layoutProof'] = {
    'changedAssemblyFunctions': changed_functions,
    'unchangedOtherParserAssemblyFunctions': len(assemblies['baseline']) - 1,
    'constantPrefixBytes': 32,
    'initialStackPointer': {'baseline': base_stack, 'candidate': candidate_stack},
    'sameOtherNonCodeSections': True,
    'scope': 'The state initializer materializes as 32 constant bytes; static-address relocation changes are expected. This is not a memory-peak or correctness result.',
}
receipt['baselineReproducedByteExactly'] = True
receipt['passed'] = True
assert git('diff', '--name-only') == b''
(OUT / 'build.json').write_text(json.dumps(receipt, indent=2) + '\n')
checkpoint({'stage': 'complete', 'passed': True})
print(json.dumps({'passed': True, 'sourceCommit': receipt['sourceCommit'],
                  'variants': {key: {'wasmSha256': value['wasmSha256'], 'wasmBytes': value['wasmBytes']} for key, value in receipt['variants'].items()}}))
