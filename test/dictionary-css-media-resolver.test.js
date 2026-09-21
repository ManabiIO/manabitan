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

import {describe, expect, test, vi} from 'vitest';
import {DictionaryCssMediaResolver, getMdictMediaPathFromComputedUrl, getMdictMediaPathsFromComputedCss} from '../ext/js/display/dictionary-css-media-resolver.js';

describe('DictionaryCssMediaResolver', () => {
    test('maps active MDX CSS image media to cached blob URLs and revokes them on clear', async () => {
        const getMedia = vi.fn().mockResolvedValue([{
            dictionary: 'MDict',
            path: 'mdict-media/styles/images/green.png',
            mediaType: 'image/png',
            content: 'AAECAw==',
            width: 1,
            height: 1,
        }]);
        const createObjectURL = vi.fn().mockReturnValue('blob:mdict-green');
        const revokeObjectURL = vi.fn();
        const resolver = new DictionaryCssMediaResolver(
            {getMedia},
            {createObjectURL, revokeObjectURL},
        );

        await expect(resolver.resolve([
            {dictionary: 'MDict', path: 'mdict-media/styles/images/green.png'},
            {dictionary: 'MDict', path: 'mdict-media/styles/images/green.png'},
        ])).resolves.toBe(true);

        const source = [
            '.native { background-image: url("mdict-media/styles/images/green.png"); }',
            '.plain { color: red; }',
        ].join('\n');
        expect(resolver.rewriteStyles('MDict', source)).toContain('url("blob:mdict-green")');
        expect(resolver.rewriteStyles('Other', source)).toBe(source);
        expect(getMedia).toHaveBeenCalledTimes(1);
        expect(getMedia).toHaveBeenCalledWith([{
            dictionary: 'MDict',
            path: 'mdict-media/styles/images/green.png',
        }]);
        expect(createObjectURL).toHaveBeenCalledTimes(1);

        await expect(resolver.resolve([
            {dictionary: 'MDict', path: 'mdict-media/styles/images/green.png'},
        ])).resolves.toBe(false);
        expect(getMedia).toHaveBeenCalledTimes(1);

        resolver.clear();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:mdict-green');
        expect(resolver.rewriteStyles('MDict', source)).toBe(source);
    });

    test('keeps missing media references unresolved without inventing blob URLs', async () => {
        const getMedia = vi.fn().mockResolvedValue([]);
        const createObjectURL = vi.fn();
        const resolver = new DictionaryCssMediaResolver(
            {getMedia},
            {createObjectURL, revokeObjectURL: vi.fn()},
        );
        const source = '.native { background: url("mdict-media/missing.png"); }';

        await expect(resolver.resolve([
            {dictionary: 'MDict', path: 'mdict-media/missing.png'},
        ])).resolves.toBe(false);
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(resolver.rewriteStyles('MDict', source)).toBe(source);
    });

    test('discarded async media results cannot repopulate a cleared cache', async () => {
        const deferred = Promise.withResolvers();
        const createObjectURL = vi.fn().mockReturnValue('blob:late');
        const resolver = new DictionaryCssMediaResolver(
            {getMedia: vi.fn(() => deferred.promise)},
            {createObjectURL, revokeObjectURL: vi.fn()},
        );

        const pending = resolver.resolve([
            {dictionary: 'MDict', path: 'mdict-media/late.png'},
        ]);
        resolver.clear();
        deferred.resolve([{
            dictionary: 'MDict',
            path: 'mdict-media/late.png',
            mediaType: 'image/png',
            content: 'AA==',
            width: 0,
            height: 0,
        }]);

        await expect(pending).resolves.toBe(false);
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    test('prunes blob URLs no longer referenced by enabled dictionary styles', async () => {
        const revokeObjectURL = vi.fn();
        const resolver = new DictionaryCssMediaResolver(
            {
                getMedia: vi.fn().mockResolvedValue([
                    {
                        dictionary: 'A',
                        path: 'mdict-media/a.png',
                        mediaType: 'image/png',
                        content: 'AA==',
                        width: 0,
                        height: 0,
                    },
                    {
                        dictionary: 'B',
                        path: 'mdict-media/b.png',
                        mediaType: 'image/png',
                        content: 'AQ==',
                        width: 0,
                        height: 0,
                    },
                ]),
            },
            {
                createObjectURL: vi.fn()
                    .mockReturnValueOnce('blob:a')
                    .mockReturnValueOnce('blob:b'),
                revokeObjectURL,
            },
        );

        await resolver.resolve([
            {dictionary: 'A', path: 'mdict-media/a.png'},
            {dictionary: 'B', path: 'mdict-media/b.png'},
        ]);
        resolver.prune([
            {name: 'A', enabled: true, styles: '.a { background: url("mdict-media/a.png"); }'},
            {name: 'B', enabled: false, styles: '.b { background: url("mdict-media/b.png"); }'},
        ]);

        expect(revokeObjectURL).toHaveBeenCalledWith('blob:b');
        expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:a');
    });
});

describe('getMdictMediaPathFromComputedUrl', () => {
    test('extracts only same-extension-origin MDict media URLs', () => {
        const baseUrl = 'chrome-extension://example/search.html';
        expect(getMdictMediaPathFromComputedUrl(
            'chrome-extension://example/mdict-media/styles/images/green.png',
            baseUrl,
        )).toBe('mdict-media/styles/images/green.png');
        expect(getMdictMediaPathFromComputedUrl(
            'chrome-extension://example/mdict-media/images/space%20name.png',
            baseUrl,
        )).toBe('mdict-media/images/space name.png');
        expect(getMdictMediaPathFromComputedUrl(
            'https://example.invalid/mdict-media/images/green.png',
            baseUrl,
        )).toBeNull();
        expect(getMdictMediaPathFromComputedUrl('blob:https://example.invalid/id', baseUrl)).toBeNull();
    });

    test('extracts active MDict URLs from multi-layer computed CSS values', () => {
        expect(getMdictMediaPathsFromComputedCss(
            [
                'linear-gradient(red, blue)',
                'url("chrome-extension://example/mdict-media/images/a%20b.png")',
                'url("https://example.invalid/mdict-media/no.png")',
            ].join(', '),
            'chrome-extension://example/search.html',
        )).toStrictEqual(['mdict-media/images/a b.png']);
    });
});
