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

import {IDBKeyRange, indexedDB} from 'fake-indexeddb';
import {BlobWriter, TextReader, ZipWriter} from '@zip.js/zip.js';
import {vi} from 'vitest';
import {chrome, fetch} from '../test/mocks/common.js';
import {setupStubs} from '../test/utilities/database.js';

/**
 * Installs the globals used by the dictionary import and lookup benchmarks.
 * @returns {void}
 */
export function installBenchmarkGlobals() {
    setupStubs();
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('chrome', chrome);
}

/**
 * @returns {{
 *   kind: 'directory',
 *   getDirectoryHandle: (name: string, options?: {create?: boolean}) => Promise<unknown>,
 *   getFileHandle: (name: string, options?: {create?: boolean}) => Promise<unknown>,
 *   removeEntry: (name: string) => Promise<void>,
 *   entries: () => AsyncGenerator<[string, unknown], void, unknown>,
 *   values: () => AsyncGenerator<unknown, void, unknown>
 * }}
 */
export function createInMemoryOpfsDirectoryHandle() {
    /** @type {Map<string, ReturnType<typeof createInMemoryOpfsDirectoryHandle>>} */
    const directories = new Map();
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();

    /**
     * @param {string} fileName
     * @returns {{
     *   kind: 'file',
     *   getFile: () => Promise<{size: number, arrayBuffer: () => Promise<ArrayBuffer>, slice: (start?: number, end?: number) => {arrayBuffer: () => Promise<ArrayBuffer>}}>,
     *   createWritable: (options?: {keepExistingData?: boolean}) => Promise<{
     *     seek: (offset: number) => Promise<void>,
     *     truncate: (size: number) => Promise<void>,
     *     write: (chunk: Uint8Array|ArrayBuffer) => Promise<void>,
     *     close: () => Promise<void>
     *   }>
     * }}
     */
    const createFileHandle = (fileName) => ({
        kind: /** @type {'file'} */ ('file'),
        async getFile() {
            const bytes = files.get(fileName) ?? new Uint8Array(0);
            return {
                size: bytes.byteLength,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                slice(start = 0, end = bytes.byteLength) {
                    const normalizedStart = Math.max(0, Math.trunc(start));
                    const normalizedEnd = Math.max(normalizedStart, Math.min(bytes.byteLength, Math.trunc(end)));
                    const sliceBytes = bytes.subarray(normalizedStart, normalizedEnd);
                    return {
                        arrayBuffer: async () => sliceBytes.buffer.slice(sliceBytes.byteOffset, sliceBytes.byteOffset + sliceBytes.byteLength),
                    };
                },
            };
        },
        async createWritable(options = {}) {
            let bytes = options.keepExistingData === true ? Uint8Array.from(files.get(fileName) ?? new Uint8Array(0)) : new Uint8Array(0);
            let position = 0;

            /**
             * @param {number} requiredLength
             * @returns {void}
             */
            const ensureCapacity = (requiredLength) => {
                if (requiredLength <= bytes.byteLength) {
                    return;
                }
                const next = new Uint8Array(requiredLength);
                next.set(bytes, 0);
                bytes = next;
            };

            return {
                seek: async (offset) => {
                    position = Math.max(0, Math.trunc(offset));
                },
                truncate: async (size) => {
                    const nextSize = Math.max(0, Math.trunc(size));
                    if (nextSize < bytes.byteLength) {
                        bytes = Uint8Array.from(bytes.subarray(0, nextSize));
                    } else if (nextSize > bytes.byteLength) {
                        const next = new Uint8Array(nextSize);
                        next.set(bytes, 0);
                        bytes = next;
                    }
                    if (position > nextSize) {
                        position = nextSize;
                    }
                },
                write: async (chunk) => {
                    const source = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    const end = position + source.byteLength;
                    ensureCapacity(end);
                    bytes.set(source, position);
                    position = end;
                },
                close: async () => {
                    files.set(fileName, bytes);
                },
            };
        },
    });

    return {
        kind: /** @type {'directory'} */ ('directory'),
        async getDirectoryHandle(name, options = {}) {
            const existing = directories.get(name);
            if (typeof existing !== 'undefined') {
                return existing;
            }
            if (options.create !== true) {
                throw new Error(`NotFoundError: directory '${name}'`);
            }
            const created = createInMemoryOpfsDirectoryHandle();
            directories.set(name, created);
            return created;
        },
        async getFileHandle(name, options = {}) {
            if (!files.has(name)) {
                if (options.create !== true) {
                    throw new Error(`NotFoundError: file '${name}'`);
                }
                files.set(name, new Uint8Array(0));
            }
            return createFileHandle(name);
        },
        async removeEntry(name) {
            if (files.delete(name) || directories.delete(name)) {
                return;
            }
            throw new Error(`NotFoundError: entry '${name}'`);
        },
        async *entries() {
            for (const [name, directoryHandle] of directories) {
                yield [name, directoryHandle];
            }
            for (const [name] of files) {
                yield [name, createFileHandle(name)];
            }
        },
        async *values() {
            for (const [, directoryHandle] of directories) {
                yield directoryHandle;
            }
            for (const [name] of files) {
                yield createFileHandle(name);
            }
        },
    };
}

/**
 * @param {unknown} rootDirectoryHandle
 * @returns {() => void}
 */
export function installInMemoryOpfsNavigator(rootDirectoryHandle) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const previousNavigator = /** @type {unknown} */ (globalThis.navigator);
    /** @type {Record<string, unknown>} */
    let navigatorBase = {};
    if (typeof previousNavigator === 'object' && previousNavigator !== null) {
        navigatorBase = /** @type {Record<string, unknown>} */ (previousNavigator);
    }
    const nextNavigator = {...navigatorBase};
    nextNavigator.storage = {
        getDirectory: async () => rootDirectoryHandle,
    };
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: nextNavigator,
    });
    return () => {
        if (typeof descriptor !== 'undefined') {
            Object.defineProperty(globalThis, 'navigator', descriptor);
            return;
        }
        Reflect.deleteProperty(globalThis, 'navigator');
    };
}

/**
 * @param {{dictionaryName?: string, bankCount?: number, rowsPerBank?: number, glossaryCharacters?: number}} [options]
 * @returns {Promise<{archiveData: ArrayBuffer, dictionaryName: string, termCount: number, expressions: string[]}>}
 */
export async function createGeneratedDictionaryArchiveData(options = {}) {
    const dictionaryName = typeof options.dictionaryName === 'string' && options.dictionaryName.length > 0 ?
        options.dictionaryName :
        'Generated Benchmark Dictionary';
    const bankCount = Math.max(1, Math.trunc(options.bankCount ?? 4));
    const rowsPerBank = Math.max(1, Math.trunc(options.rowsPerBank ?? 1536));
    const glossaryCharacters = Math.max(32, Math.trunc(options.glossaryCharacters ?? 192));
    const zipFileWriter = new BlobWriter();
    const zipWriter = new ZipWriter(zipFileWriter, {level: 0});
    const expressions = [];

    await zipWriter.add('index.json', new TextReader(JSON.stringify({
        title: dictionaryName,
        format: 3,
        revision: 'benchmark',
        sequenced: true,
    })));

    await zipWriter.add('tag_bank_1.json', new TextReader(JSON.stringify([
        ['n', 'partOfSpeech', 0, 'noun', 0],
        ['v1', 'partOfSpeech', 0, 'ichidan verb', 0],
        ['adj-i', 'partOfSpeech', 0, 'i-adjective', 0],
        ['P', 'popular', 0, 'popular term', 0],
    ])));

    let globalIndex = 0;
    for (let bankIndex = 0; bankIndex < bankCount; ++bankIndex) {
        /** @type {Array<[string, string, string, string, number, string[], number, string]>} */
        const rows = [];
        for (let rowIndex = 0; rowIndex < rowsPerBank; ++rowIndex, ++globalIndex) {
            const id = String(globalIndex).padStart(6, '0');
            const expression = `term-${id}`;
            const reading = `reading-${id}`;
            const entryType = globalIndex % 3;
            const definitionTag = entryType === 0 ? 'n' : (entryType === 1 ? 'v1' : 'adj-i');
            const rules = entryType === 0 ? 'n' : (entryType === 1 ? 'v1' : 'adj-i');
            const glossary = [
                createGlossaryLine('definition', id, glossaryCharacters),
                createGlossaryLine('example', id, glossaryCharacters),
            ];
            rows.push([
                expression,
                reading,
                definitionTag,
                rules,
                (globalIndex % 500) + 1,
                glossary,
                globalIndex + 1,
                (globalIndex % 5) === 0 ? 'P' : '',
            ]);
            expressions.push(expression);
        }
        await zipWriter.add(`term_bank_${bankIndex + 1}.json`, new TextReader(JSON.stringify(rows)));
    }

    const blob = await zipWriter.close();
    return {
        archiveData: await blob.arrayBuffer(),
        dictionaryName,
        termCount: expressions.length,
        expressions,
    };
}

/**
 * @param {string[]} expressions
 * @param {number} count
 * @param {number} [offset]
 * @returns {string[]}
 */
export function createExpressionSample(expressions, count, offset = 0) {
    if (expressions.length === 0 || count <= 0) {
        return [];
    }
    const step = Math.max(1, Math.floor(expressions.length / count));
    /** @type {string[]} */
    const result = [];
    for (let i = 0; i < count; ++i) {
        const index = (offset + (i * step)) % expressions.length;
        result.push(expressions[index]);
    }
    return result;
}

/**
 * @param {string} label
 * @param {string} id
 * @param {number} glossaryCharacters
 * @returns {string}
 */
function createGlossaryLine(label, id, glossaryCharacters) {
    const prefix = `${label} ${id} `;
    const suffixLength = Math.max(0, glossaryCharacters - prefix.length);
    return `${prefix}${'x'.repeat(suffixLength)}`;
}
