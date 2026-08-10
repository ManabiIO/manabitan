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

Reflect.set(globalThis, '__manabitanTermContentCompressionWorker', true);

const modulePromise = /** @type {Promise<typeof import('./zstd-term-content.js')>} */ (
    import('./zstd-term-content.js')
);
const initialization = modulePromise.then(({initializeTermContentZstd}) => initializeTermContentZstd());

void initialization.then(
    () => { self.postMessage({type: 'ready'}); },
    (error) => { self.postMessage({type: 'initialization-error', error: `${error}`}); },
);

self.addEventListener('message', (event) => {
    void compressContent(event);
});

/** @param {MessageEvent} event */
async function compressContent(event) {
    const rawData = /** @type {unknown} */ (event.data);
    const data = /** @type {{id?: unknown, content?: unknown, dictName?: unknown}} */ (rawData);
    const id = typeof data?.id === 'number' ? data.id : -1;
    try {
        const {compressTermContentZstd} = await modulePromise;
        await initialization;
        if (!(data.content instanceof Uint8Array)) {
            throw new TypeError('Compression worker input is not a Uint8Array');
        }
        const dictName = typeof data.dictName === 'string' ? data.dictName : null;
        const compressed = Uint8Array.from(compressTermContentZstd(data.content, dictName));
        self.postMessage({id, compressed: compressed.buffer}, [compressed.buffer]);
    } catch (error) {
        self.postMessage({id, error: `${error}`});
    }
}
