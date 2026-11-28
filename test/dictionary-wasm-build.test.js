import {mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'vitest';
import {copyDictionaryWasm, dictionaryWasmHash, getDictionaryWasmManifest, getDictionaryWasmSourceIdentity, loadDictionaryWasm, verifyDictionaryWasmToolchain} from '../dev/dictionary-wasm.js';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'manabitan-wasm-artifacts-'));
    const source = join(root, 'ext/js/dictionary/wasm');
    const artifacts = join(root, 'dev/data/dictionary-wasm');
    const output = join(root, 'output');
    await mkdir(source, {recursive: true});
    await mkdir(artifacts, {recursive: true});
    await mkdir(output);
    await writeFile(join(source, 'parser.c'), 'int parse(void) { return 1; }\n');
    const identity = getDictionaryWasmSourceIdentity(root);
    const module = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const manifest = {format: 1,
        sourceDigest: identity.digest,
        sourceFileCount: identity.count,
        toolchain: {compilerVersion: '21.1.8', linkerVersion: '21.1.8'},
        targets: ['term-bank-parser.wasm', 'term-content-canonical-scan-v1.wasm', 'term-index-hash-v1.wasm'].map((name) => ({name, sources: ['ext/js/dictionary/wasm/parser.c'], arguments: ['-O3'], sha256: dictionaryWasmHash(module)}))};
    for (const {name} of manifest.targets) { await writeFile(join(artifacts, name), module); }
    const saveManifest = () => writeFile(join(artifacts, 'manifest.json'), JSON.stringify(manifest));
    await saveManifest();
    return {root, source, artifacts, output, module, manifest, saveManifest};
}

test('normal builds copy the recorded WASM bytes without executing a host compiler', async () => {
    const value = await fixture();
    copyDictionaryWasm(value.output, value.root);
    for (const {name} of value.manifest.targets) { expect(await readFile(join(value.output, name))).toEqual(value.module); }
});

test('normal builds resolve parent directory aliases before copying', async () => {
    const value = await fixture();
    const alias = join(value.root, 'parent-alias');
    await symlink(value.output, alias, 'dir');
    const output = join(alias, 'generated');
    copyDictionaryWasm(output, value.root);
    for (const {name} of value.manifest.targets) { expect(await readFile(join(output, name))).toEqual(value.module); }
});

test('normal builds reject a linked output directory', async () => {
    const value = await fixture();
    const output = join(value.root, 'linked-output');
    await symlink(value.output, output, 'dir');
    expect(() => copyDictionaryWasm(output, value.root)).toThrow(/Unexpected dictionary WASM output directory/u);
});

test('a linked second output preserves the first output and the link target', async () => {
    const value = await fixture();
    const first = join(value.output, value.manifest.targets[0].name);
    const outside = join(value.root, 'outside.wasm');
    await writeFile(first, 'previous output');
    await writeFile(outside, 'outside output');
    await symlink(outside, join(value.output, value.manifest.targets[1].name));
    expect(() => copyDictionaryWasm(value.output, value.root)).toThrow(/Unexpected dictionary WASM output/u);
    expect(await readFile(first, 'utf8')).toBe('previous output');
    expect(await readFile(outside, 'utf8')).toBe('outside output');
});

test.each(['change', 'addition', 'header', 'uppercase-header'])('native source %s requires explicit regeneration', async (mode) => {
    const value = await fixture();
    /** @type {Record<string, string>} */
    const names = {change: 'parser.c', addition: 'new.c', header: 'new.h', 'uppercase-header': 'new.H'};
    const name = names[mode];
    await writeFile(join(value.source, name), 'changed source\n');
    expect(() => loadDictionaryWasm(value.root)).toThrow(/sources changed/u);
});

test('corruption of the second module preserves both previous output modules', async () => {
    const value = await fixture();
    for (const {name} of value.manifest.targets) { await writeFile(join(value.output, name), 'previous output'); }
    await writeFile(join(value.artifacts, value.manifest.targets[1].name), 'corrupted module');
    expect(() => copyDictionaryWasm(value.output, value.root)).toThrow(/Invalid dictionary WASM artifact/u);
    for (const {name} of value.manifest.targets) { expect(await readFile(join(value.output, name), 'utf8')).toBe('previous output'); }
});

test('matching a digest cannot make malformed WASM acceptable', async () => {
    const value = await fixture();
    const corrupt = Buffer.from('not a WASM module');
    await writeFile(join(value.artifacts, value.manifest.targets[0].name), corrupt);
    value.manifest.targets[0].sha256 = dictionaryWasmHash(corrupt);
    await value.saveManifest();
    expect(() => loadDictionaryWasm(value.root)).toThrow(/Invalid dictionary WASM artifact/u);
});

test.each(['format', 'duplicate', 'path'])('rejects invalid manifest %s', async (mode) => {
    const value = await fixture();
    if (mode === 'format') { value.manifest.format = 2; }
    if (mode === 'duplicate') { value.manifest.targets[1] = value.manifest.targets[0]; }
    if (mode === 'path') { value.manifest.targets[0].name = '../../outside.wasm'; }
    await value.saveManifest();
    expect(() => loadDictionaryWasm(value.root)).toThrow(/Invalid dictionary WASM/u);
});

test('checked-in artifacts match the current native inputs and are valid modules', () => {
    const manifest = getDictionaryWasmManifest();
    const modules = loadDictionaryWasm();
    // eslint-disable-next-line @stylistic/semi
    expect(modules.size).toBe(3)
    for (const target of manifest.targets) {
        const bytes = /** @type {Buffer} */ (modules.get(target.name));
        expect(dictionaryWasmHash(bytes)).toBe(target.sha256);
    }
});

test.each([
    {compiler: 'Ubuntu clang version 21.1.8 (1ubuntu1)', linker: 'Ubuntu LLD 21.1.8 (compatible with GNU linkers)', accepted: true},
    {compiler: 'Apple clang version 21.0.0', linker: 'LLD 21.1.8', accepted: false},
    {compiler: 'clang version 21.1.8', linker: 'LLD 21.1.9', accepted: false},
    {compiler: 'clang version 21.1.9', linker: 'LLD 21.1.8', accepted: false},
])('regeneration pins compiler and linker: $compiler / $linker', ({compiler, linker, accepted}) => {
    const check = () => verifyDictionaryWasmToolchain(compiler, linker, {compilerVersion: '21.1.8', linkerVersion: '21.1.8'});
    if (accepted) {
        expect(check).not.toThrow();
    } else {
        expect(check).toThrow(/Clang 21.1.8 and LLD 21.1.8/u);
    }
});
