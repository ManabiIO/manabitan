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

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseJson} from './json.js';

export const dictionaryWasmRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sourceDirectory = 'ext/js/dictionary/wasm';
const artifactDirectory = 'dev/data/dictionary-wasm';
const artifactNames = ['term-bank-parser.wasm', 'term-content-canonical-scan-v1.wasm'];
const digestPattern = /^[a-f0-9]{64}$/;

/**
 * @typedef {object} DictionaryWasmManifest
 * @property {number} format
 * @property {{compilerVersion: string, linkerVersion: string}} toolchain
 * @property {string} sourceDigest
 * @property {number} sourceFileCount
 * @property {{name: string, sources: string[], arguments: string[], sha256: string}[]} targets
 */

/**
 * @param {Uint8Array|string} bytes
 * @returns {string}
 */
export function dictionaryWasmHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/**
 * Bind all native C/header inputs, including portable inflater headers, by
 * relative name and bytes. This also detects added and deleted source files.
 * @param {string} [root]
 * @returns {{digest: string, count: number}}
 * @throws {Error}
 */
export function getDictionaryWasmSourceIdentity(root = dictionaryWasmRoot) {
    /** @type {string[]} */
    const files = [];
    /**
     * @param {string} directory
     * @throws {Error}
     */
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) { throw new Error(`Linked native source is unsupported: ${file}`); }
            if (entry.isDirectory()) {
                visit(file);
            } else if (entry.isFile() && /\.[ch]$/i.test(entry.name)) {
                files.push(path.relative(root, file).replace(/\\/g, '/'));
            }
        }
    };
    visit(path.join(root, sourceDirectory));
    const hash = createHash('sha256');
    for (const file of files.sort()) { hash.update(`${file}\0${dictionaryWasmHash(fs.readFileSync(path.join(root, file)))}\n`); }
    return {digest: hash.digest('hex'), count: files.length};
}

/**
 * @param {string} [root]
 * @returns {DictionaryWasmManifest}
 * @throws {Error}
 */
export function getDictionaryWasmManifest(root = dictionaryWasmRoot) {
    const value = parseJson(fs.readFileSync(path.join(root, artifactDirectory, 'manifest.json'), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid dictionary WASM manifest'); }
    const manifest = /** @type {DictionaryWasmManifest} */ (value);
    if (manifest.format !== 1 || !digestPattern.test(manifest.sourceDigest) || !Number.isSafeInteger(manifest.sourceFileCount) || manifest.sourceFileCount <= 0 ||
    manifest.toolchain === null || typeof manifest.toolchain !== 'object' ||
    !/^\d+\.\d+\.\d+$/.test(manifest.toolchain.compilerVersion) || !/^\d+\.\d+\.\d+$/.test(manifest.toolchain.linkerVersion) ||
    !Array.isArray(manifest.targets) || manifest.targets.length !== artifactNames.length) { throw new Error('Invalid dictionary WASM manifest'); }
    const seen = new Set();
    for (const target of manifest.targets) {
        if (target === null || typeof target !== 'object' || !artifactNames.includes(target.name) || seen.has(target.name) ||
        !digestPattern.test(target.sha256) || !Array.isArray(target.sources) || target.sources.length === 0 ||
        !target.sources.every((source) => typeof source === 'string' && source.startsWith(sourceDirectory + '/') && !source.split('/').includes('..') && source.endsWith('.c')) ||
        !Array.isArray(target.arguments) || !target.arguments.every((argument) => typeof argument === 'string')) { throw new Error('Invalid dictionary WASM target'); }
        seen.add(target.name);
    }
    return manifest;
}

/**
 * Validate every input and module before changing any generated output.
 * Ordinary builds never choose a compiler from the host PATH.
 * @param {string} [root]
 * @returns {Map<string, Buffer>}
 * @throws {Error}
 */
export function loadDictionaryWasm(root = dictionaryWasmRoot) {
    const manifest = getDictionaryWasmManifest(root);
    const source = getDictionaryWasmSourceIdentity(root);
    if (source.digest !== manifest.sourceDigest || source.count !== manifest.sourceFileCount) {
        throw new Error('Dictionary WASM sources changed; regenerate with npm run build:dictionary-wasm -- --write and review the artifacts');
    }
    /** @type {Map<string, Buffer>} */
    const result = new Map();
    for (const target of manifest.targets) {
        const bytes = fs.readFileSync(path.join(root, artifactDirectory, target.name));
        if (dictionaryWasmHash(bytes) !== target.sha256 || !WebAssembly.validate(bytes)) { throw new Error(`Invalid dictionary WASM artifact: ${target.name}`); }
        result.set(target.name, bytes);
    }
    return result;
}

/**
 * @param {string} outputDirectory
 * @param {string} [root]
 * @throws {Error}
 */
export function copyDictionaryWasm(outputDirectory, root = dictionaryWasmRoot) {
    const modules = loadDictionaryWasm(root);
    const directoryState = fs.lstatSync(outputDirectory, {throwIfNoEntry: false});
    if (typeof directoryState !== 'undefined' && !directoryState.isDirectory()) { throw new Error(`Unexpected dictionary WASM output directory: ${outputDirectory}`); }
    fs.mkdirSync(outputDirectory, {recursive: true});
    // Resolve parent aliases such as macOS /var before writing. Reject a link
    // at the selected output directory itself, rather than harmless ancestors.
    const realOutputDirectory = fs.realpathSync(outputDirectory);
    for (const name of modules.keys()) {
        const outputPath = path.join(realOutputDirectory, name);
        const state = fs.lstatSync(outputPath, {throwIfNoEntry: false});
        if (typeof state !== 'undefined' && !state.isFile()) { throw new Error(`Unexpected dictionary WASM output: ${outputPath}`); }
    }
    for (const [name, bytes] of modules) { fs.writeFileSync(path.join(realOutputDirectory, name), bytes); }
}

/**
 * @param {string} compiler
 * @param {string} linker
 * @param {DictionaryWasmManifest['toolchain']} expected
 * @throws {Error}
 */
export function verifyDictionaryWasmToolchain(compiler, linker, expected) {
    if (compiler.match(/\bclang version (\d+\.\d+\.\d+)\b/)?.[1] !== expected.compilerVersion ||
    linker.match(/\bLLD (\d+\.\d+\.\d+)\b/)?.[1] !== expected.linkerVersion) {
        throw new Error(`Dictionary WASM regeneration requires Clang ${expected.compilerVersion} and LLD ${expected.linkerVersion}`);
    }
}
