/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {dictionaryWasmHash, dictionaryWasmRoot, getDictionaryWasmManifest, getDictionaryWasmSourceIdentity, loadDictionaryWasm, verifyDictionaryWasmToolchain} from '../dictionary-wasm.js';

/**
 * Resolve exactly the executable whose version is checked. In particular,
 * Clang must not silently choose a different linker from PATH.
 * @param {string} command
 * @returns {string}
 * @throws {Error}
 */
function executable(command) {
    const directories = path.isAbsolute(command) || command.includes('/') || command.includes('\\') ? [''] : (process.env.PATH ?? '').split(path.delimiter);
    for (const directory of directories) {
        for (const suffix of process.platform === 'win32' ? ['', '.exe'] : ['']) {
            const file = path.resolve(directory, command + suffix);
            try {
                fs.accessSync(file, fs.constants.X_OK);
                if (fs.statSync(file).isFile()) { return file; }
            } catch { /* Try the next executable location. */ }
        }
    }
    throw new Error(`Missing pinned WASM tool: ${command}`);
}

/**
 * @param {string[]} [argv]
 * @throws {Error}
 */
export function main(argv = process.argv.slice(2)) {
    const {values} = parseArgs({args: argv, options: {write: {type: 'boolean'}, check: {type: 'boolean'}}});
    if (values.write && values.check) { throw new Error('Choose --write or --check'); }
    const manifest = getDictionaryWasmManifest();
    if (!values.write) { loadDictionaryWasm(); }
    const compiler = executable(process.env.MANABITAN_CLANG || 'clang-18');
    const linker = executable(process.env.MANABITAN_WASM_LD || 'wasm-ld-18');
    const compilerVersion = execFileSync(compiler, ['--version'], {encoding: 'utf8'});
    const linkerVersion = execFileSync(linker, ['--version'], {encoding: 'utf8'});
    verifyDictionaryWasmToolchain(compilerVersion, linkerVersion, manifest.toolchain);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manabitan-pinned-wasm-'));
    try {
        /** @type {Map<string, Buffer>} */
        const generated = new Map();
        for (const target of manifest.targets) {
            const output = path.join(directory, target.name);
            execFileSync(compiler, [`--ld-path=${linker}`, ...target.arguments, '-o', output, ...target.sources.map((source) => path.join(dictionaryWasmRoot, source))], {stdio: 'inherit'});
            const bytes = fs.readFileSync(output);
            if (!WebAssembly.validate(bytes)) { throw new Error(`Compiler produced invalid WASM: ${target.name}`); }
            if (!values.write && dictionaryWasmHash(bytes) !== target.sha256) { throw new Error(`Pinned rebuild differs from checked-in WASM: ${target.name}`); }
            generated.set(target.name, bytes);
        }
        if (values.write) {
            const destination = path.join(dictionaryWasmRoot, 'dev/data/dictionary-wasm');
            if (fs.realpathSync(destination) !== path.resolve(destination)) { throw new Error('Refusing to regenerate through a linked artifact directory'); }
            for (const name of ['manifest.json', ...manifest.targets.map((target) => target.name)]) {
                const state = fs.lstatSync(path.join(destination, name), {throwIfNoEntry: false});
                if (typeof state !== 'undefined' && !state.isFile()) { throw new Error(`Unexpected dictionary WASM output: ${name}`); }
            }
            for (const target of manifest.targets) {
                const bytes = /** @type {Buffer} */ (generated.get(target.name));
                fs.writeFileSync(path.join(destination, target.name), bytes);
                target.sha256 = dictionaryWasmHash(bytes);
            }
            const source = getDictionaryWasmSourceIdentity();
            manifest.sourceDigest = source.digest;
            manifest.sourceFileCount = source.count;
            fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 4) + '\n');
        }
        process.stdout.write(JSON.stringify({mode: values.write ? 'write' : 'check', toolchain: manifest.toolchain, targets: manifest.targets.map(({name, sha256}) => ({name, sha256}))}, null, 2) + '\n');
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
}

if (/** @type {ImportMeta & {main?: boolean}} */ (import.meta).main) { main(); }
