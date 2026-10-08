/* SPDX-License-Identifier: GPL-3.0-or-later */
import {expect, test} from 'vitest';
import {MAX_WEB_IMAGE_BYTES, webMediaResponse} from '../ext/web/media-response.js';

/**
 * @param {ArrayBuffer} content
 * @param {string} [mediaType]
 * @returns {import('../types/ext/dictionary-database.d.ts').Media}
 */
function media(content, mediaType = 'image/png') {
    return {dictionary: 'Test', path: 'cat.png', mediaType, width: 1, height: 1, content, index: 0};
}

test('web media omits unsupported and empty content without exposing extra database metadata', () => {
    expect(webMediaResponse(undefined)).toBeNull();
    expect(webMediaResponse(media(new ArrayBuffer(1), 'text/html'))).toBeNull();
    expect(webMediaResponse(media(new ArrayBuffer(0)))).toBeNull();
    const content = new ArrayBuffer(5);
    expect(webMediaResponse(media(content))).toEqual({content, mediaType: 'image/png'});
    expect(webMediaResponse(media(new ArrayBuffer(1), 'image/svg+xml'))?.mediaType).toBe('image/svg+xml');
});

test('web media limits the byte size before worker structured cloning', () => {
    expect(webMediaResponse(media(new ArrayBuffer(MAX_WEB_IMAGE_BYTES)))?.content.byteLength).toBe(MAX_WEB_IMAGE_BYTES);
    expect(() => webMediaResponse(media(new ArrayBuffer(MAX_WEB_IMAGE_BYTES + 1)))).toThrow('Dictionary image exceeds display size limit');
});
