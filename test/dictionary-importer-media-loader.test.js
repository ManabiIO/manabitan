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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('DictionaryImporterMediaLoader', () => {
    test('uses createImageBitmap when DOM Image is unavailable', async () => {
        const close = vi.fn();
        const createImageBitmap = vi.fn(async () => ({
            width: 31,
            height: 41,
            close,
        }));
        vi.stubGlobal('Image', null);
        vi.stubGlobal('createImageBitmap', createImageBitmap);

        const loader = new DictionaryImporterMediaLoader();
        const content = new ArrayBuffer(4);
        /** @type {Transferable[]} */
        const transfer = [];

        await expect(loader.getImageDetails(content, 'image/png', transfer)).resolves.toStrictEqual({
            content,
            width: 31,
            height: 41,
        });

        expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob));
        expect(close).toHaveBeenCalledTimes(1);
        expect(transfer).toStrictEqual([content]);
    });

    test('rejects when no image metadata decoder is available', async () => {
        vi.stubGlobal('Image', null);
        vi.stubGlobal('createImageBitmap', null);

        const loader = new DictionaryImporterMediaLoader();
        await expect(
            loader.getImageDetails(new ArrayBuffer(4), 'image/png'),
        ).rejects.toThrow('Image metadata decoding is not supported in this runtime');
    });

    test('times out DOM Image metadata loads that never settle', async () => {
        vi.useFakeTimers();
        const revokeObjectURL = vi.fn();
        const createObjectURL = vi.fn(() => 'blob:fixture');
        const removeAttribute = vi.fn();
        class FakeImage extends EventTarget {
            /** */
            constructor() {
                super();
                this.removeAttribute = removeAttribute;
            }
        }
        vi.stubGlobal('Image', FakeImage);
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL,
            revokeObjectURL,
        });

        const loader = new DictionaryImporterMediaLoader();
        const promise = loader.getImageDetails(new ArrayBuffer(4), 'image/png');
        const expectation = expect(promise).rejects.toThrow('Timed out loading image metadata after 60000ms');

        await vi.advanceTimersByTimeAsync(60_000);
        await expectation;

        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
        expect(removeAttribute).toHaveBeenCalledWith('src');
    });
});
