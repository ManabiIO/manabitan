/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const BASE_SHA = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2';
export const STORE_PATH = 'ext/js/dictionary/term-record-opfs-store.js';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const git = (root, ...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
export const localImport = (root, filename) => import(pathToFileURL(join(root, filename)).href);

export async function identity(root) {
    return {
        root, head: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'),
        trackedChanges: git(root, 'status', '--porcelain', '--untracked-files=no'),
        storeSha256: sha256(await readFile(join(root, STORE_PATH))),
        wasmSha256: sha256(await readFile(join(root, 'ext/lib/term-bank-parser.wasm'))),
        dependencyLockSha256: sha256(await readFile(join(root, 'package-lock.json'))),
        fixtureLockSha256: sha256(await readFile(join(root, 'test/perf/dictionaries.lock.json'))),
    };
}

// The private validator body is unchanged. Only relative static imports are
// made absolute, and one export is appended to this diagnostic-only module.
export async function exposeValidator(root) {
    const filename = join(root, STORE_PATH);
    const source = await readFile(filename, 'utf8');
    const instrumented = source.replace(/(from\s+)(['"])(\.\.?\/[^'"]+)\2/g,
        (_all, prefix, quote, specifier) => prefix + quote + new URL(specifier, pathToFileURL(filename)).href + quote) +
        '\nexport {parseCompactRecordFields as scoreValidation};\n';
    const loaded = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64'));
    return loaded.scoreValidation;
}

export function updateFramed(hash, bytes) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

export function updateValidationDigest(hash, fields) {
    for (const name of ['offsets', 'lengths', 'scoreKeys', 'scores']) { updateFramed(hash, fields[name]); }
}
