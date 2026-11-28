/*
 * Copyright (C) 2026 Manabitan authors
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
import {safePerformance} from '../core/safe-performance.js';

// Lazy trainer-only module worker. The owning scheduler sends one bounded job;
// synchronous WASM work is stopped by terminating this worker on foreground use.
/** @typedef {{HEAPU8: Uint8Array, _malloc: (size: number) => number, _free: (pointer: number) => void, _manabitan_train_dictionary: (destination: number, capacity: number, samples: number, sampleBytes: number, lengths: number, count: number, strategy: number, level: number, written: number) => number}} TrainerModule */
/** @typedef {{id: unknown, samples: unknown, lengths: unknown, dictionaryCapacity: unknown, strategy: unknown, level: unknown}} TrainerRequest */
let used = false;
self.addEventListener('message', async ({data: rawData}) => {
    if (used) { return; }
    used = true;
    const data = /** @type {unknown} */ (rawData);
    if (typeof data !== 'object' || data === null) {
        self.postMessage({id: null, error: 'Invalid trainer input', errorKind: 'invalid-input'});
        return;
    }
    const request = /** @type {TrainerRequest} */ (data);
    const {id} = request;
    /** @type {number[]} */
    const allocations = [];
    /** @type {TrainerModule|null} */
    let module = null;
    try {
        const {samples, lengths, dictionaryCapacity, strategy, level} = request;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 ||
        !(samples instanceof Uint8Array) || !(samples.buffer instanceof ArrayBuffer) ||
        !(lengths instanceof Uint8Array) || !(lengths.buffer instanceof ArrayBuffer) ||
        samples.byteLength === 0 || samples.byteLength > 32 * 1024 * 1024 ||
        lengths.byteLength % 4 !== 0 || lengths.byteLength < 32 || lengths.byteLength > 200000 ||
        typeof dictionaryCapacity !== 'number' || !Number.isInteger(dictionaryCapacity) || dictionaryCapacity < 1024 || dictionaryCapacity > 112640 ||
        typeof strategy !== 'number' || !Number.isInteger(strategy) || strategy < 0 || strategy > 2 ||
        typeof level !== 'number' || !Number.isInteger(level) || level < -1 || level > 9) {
            self.postMessage({id, error: 'Invalid trainer input', errorKind: 'invalid-input'});
            return;
        }
        const sizes = new DataView(lengths.buffer, lengths.byteOffset, lengths.byteLength);
        let sum = 0;
        for (let i = 0; i < lengths.byteLength; i += 4) {
            const n = sizes.getUint32(i, true);
            if (n === 0 || n > 262144) {
                self.postMessage({id, error: 'Invalid trainer sample length', errorKind: 'invalid-input'});
                return;
            }
            sum += n;
            if (sum > samples.byteLength) {
                self.postMessage({id, error: 'Trainer sample lengths exceed slab', errorKind: 'invalid-input'});
                return;
            }
        }
        if (sum !== samples.byteLength) {
            self.postMessage({id, error: 'Trainer sample lengths do not cover slab', errorKind: 'invalid-input'});
            return;
        }
        const initializeStart = safePerformance.now();
        const loadedModule = await import('./zstd-trainer-module.js');
        const createModule = /** @type {(options: {locateFile: (name: string) => string}) => Promise<TrainerModule>} */ (
            /** @type {unknown} */ (loadedModule.default)
        );
        const trainerModule = await createModule({locateFile: (/** @type {string} */ name) => (name.endsWith('.wasm') ? new URL('zstd-trainer.wasm', import.meta.url).href : name)});
        module = trainerModule;
        const mallocFunction = /** @type {TrainerModule['_malloc']} */ (/** @type {unknown} */ (Reflect.get(trainerModule, '_malloc')));
        const trainFunction = /** @type {TrainerModule['_manabitan_train_dictionary']} */ (/** @type {unknown} */ (Reflect.get(trainerModule, '_manabitan_train_dictionary')));
        const initializedAt = safePerformance.now();
        /**
         * @param {number} n
         * @returns {number}
         * @throws {Error} If the WASM heap cannot allocate the requested buffer.
         */
        const allocate = (n) => {
            const p = mallocFunction(n);
            if (!p) {
                const error = new Error('Trainer allocation failed');
                error.name = 'ZstdTrainingResourceError';
                throw error;
            }
            allocations.push(p);
            return p;
        };
        const input = allocate(samples.byteLength);
        const table = allocate(lengths.byteLength);
        const destination = allocate(dictionaryCapacity);
        const written = allocate(4);
        // Never retain a heap view across allocations or the trainer call.
        trainerModule.HEAPU8.set(samples, input);
        trainerModule.HEAPU8.set(lengths, table);
        trainerModule.HEAPU8.fill(0, written, written + 4);
        const start = safePerformance.now();
        const status = trainFunction(
            destination,
            dictionaryCapacity,
            input,
            samples.byteLength,
            table,
            lengths.byteLength / 4,
            strategy,
            level,
            written,
        );
        const trainedAt = safePerformance.now();
        if (status !== 0) {
            const error = new Error('Trainer failed with status ' + status);
            switch (status) {
                case 1: error.name = 'ZstdTrainingInputError'; break;
                case 2:
                case 5: error.name = 'ZstdTrainingResourceError'; break;
                case 3: error.name = 'ZstdTrainingCorpusError'; break;
                default: error.name = 'ZstdTrainingOutputError'; break;
            }
            throw error;
        }
        const size = new DataView(trainerModule.HEAPU8.buffer).getUint32(written, true);
        if (size < 8 || size > dictionaryCapacity) {
            const error = new Error('Invalid trainer output length');
            error.name = 'ZstdTrainingOutputError';
            throw error;
        }
        const dictionary = trainerModule.HEAPU8.slice(destination, destination + size);
        self.postMessage({id,
            dictionary,
            initializeMs: initializedAt - initializeStart,
            trainMs: trainedAt - start,
            heapBytes: trainerModule.HEAPU8.byteLength}, [dictionary.buffer]);
    } catch (error) {
        const typedError = error instanceof Error ? error : new Error('Trainer failed');
        let errorKind = 'unavailable';
        switch (typedError.name) {
            case 'ZstdTrainingResourceError': errorKind = 'resource'; break;
            case 'ZstdTrainingCorpusError': errorKind = 'corpus'; break;
            case 'ZstdTrainingOutputError': errorKind = 'invalid-output'; break;
            case 'ZstdTrainingInputError': errorKind = 'invalid-input'; break;
            default: break;
        }
        self.postMessage({id, error: typedError.message, errorKind});
    } finally {
        if (module) {
            const freeFunction = /** @type {TrainerModule['_free']} */ (/** @type {unknown} */ (Reflect.get(module, '_free')));
            for (const pointer of allocations.reverse()) { freeFunction(pointer); }
        }
    }
});
