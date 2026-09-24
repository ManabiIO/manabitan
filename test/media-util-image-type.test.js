/*
 * Copyright (C) 2026  Yomitan Authors
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

import {describe, expect, test} from 'vitest';
import {getImageMediaTypeFromFileName} from '../ext/js/media/media-util.js';

describe('getImageMediaTypeFromFileName', () => {
    test.each([
        ['.apng', 'image/apng'],
        ['.avif', 'image/avif'],
        ['.bmp', 'image/bmp'],
        ['.gif', 'image/gif'],
        ['.ico', 'image/x-icon'],
        ['.cur', 'image/x-icon'],
        ['.jpg', 'image/jpeg'],
        ['.jpeg', 'image/jpeg'],
        ['.jfif', 'image/jpeg'],
        ['.pjpeg', 'image/jpeg'],
        ['.pjp', 'image/jpeg'],
        ['.png', 'image/png'],
        ['.svg', 'image/svg+xml'],
        ['.tif', 'image/tiff'],
        ['.tiff', 'image/tiff'],
        ['.webp', 'image/webp'],
    ])('recognizes %s case-insensitively', (extension, expected) => {
        expect(getImageMediaTypeFromFileName(`assets/image${extension}`)).toBe(expected);
        expect(getImageMediaTypeFromFileName(`assets/image${extension.toUpperCase()}`)).toBe(expected);
    });

    test.each([
        [''],
        ['image'],
        ['image.json'],
        ['image.thisisaverylongextension'],
        ['image.png?query'],
        ['image.jpg#fragment'],
        ['image.png/file'],
        ['image.jpeg\\file'],
        ['assets/.'],
    ])('rejects non-image path %s', (path) => {
        expect(getImageMediaTypeFromFileName(path)).toBeNull();
    });

    test('preserves path boundary behavior for dot-prefixed image names', () => {
        expect(getImageMediaTypeFromFileName('.png')).toBe('image/png');
        expect(getImageMediaTypeFromFileName('assets/.JPEG')).toBe('image/jpeg');
    });
});
