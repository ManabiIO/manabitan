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
import {DictionaryCssMediaResolver, getMdictMediaPathFromComputedUrl, getMdictMediaPathsFromComputedCss, getMdictMediaUrlPathMap} from '../ext/js/display/dictionary-css-media-resolver.js';

describe('DictionaryCssMediaResolver', () => {
    test('overlapping renders share one in-flight fetch for each media identity', async () => {
        const deferred = Promise.withResolvers();
        const media = {dictionary: 'A', path: 'mdict-media/a.png', mediaType: 'image/png', content: 'AA=='};
        const getMedia = vi.fn(() => deferred.promise);
        const createObjectURL = vi.fn(() => 'blob:a');
        const resolver = new DictionaryCssMediaResolver({getMedia}, {createObjectURL});
        const first = resolver.resolve([media]);
        const second = resolver.resolve([media]);
        deferred.resolve([media]);
        await Promise.all([first, second]);
        expect(getMedia).toHaveBeenCalledTimes(1);
        expect(createObjectURL).toHaveBeenCalledTimes(1);
    });

    test('disabling an unrelated dictionary preserves healthy in-flight results', async () => {
        const deferred = Promise.withResolvers();
        const media = ['A', 'B'].map((dictionary) => ({dictionary, path: 'mdict-media/a.png', mediaType: 'image/png', content: 'AA=='}));
        const createObjectURL = vi.fn(() => 'blob:a');
        const resolver = new DictionaryCssMediaResolver({getMedia: () => deferred.promise}, {createObjectURL});
        resolver.prune([{name: 'A', enabled: true}, {name: 'B', enabled: true}]);
        const pending = resolver.resolve(media);
        resolver.prune([{name: 'A', enabled: true}, {name: 'B', enabled: false}]);
        deferred.resolve(media);
        await expect(pending).resolves.toBe(true);
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(resolver.rewriteStyles('A', 'url(mdict-media/a.png)')).toBe('url("blob:a")');
        expect(resolver.rewriteStyles('B', 'url(mdict-media/a.png)')).toBe('url(mdict-media/a.png)');
    });

    test('failed decoding revokes staged URLs without publishing a partial batch, and can retry', async () => {
        const first = {dictionary: 'A', path: 'mdict-media/a.png', mediaType: 'image/png', content: 'AA=='};
        const second = {...first, path: 'mdict-media/b.png'};
        const getMedia = vi.fn().mockResolvedValueOnce([first, {...second, content: '%%%'}]).mockResolvedValueOnce([first, second]);
        const createObjectURL = vi.fn().mockReturnValueOnce('blob:staged').mockReturnValueOnce('blob:a')
            .mockReturnValueOnce('blob:b');
        const revokeObjectURL = vi.fn();
        const resolver = new DictionaryCssMediaResolver({getMedia}, {createObjectURL, revokeObjectURL});
        await expect(resolver.resolve([first, second])).rejects.toThrow();
        expect(resolver.rewriteStyles('A', 'url(mdict-media/a.png)')).toBe('url(mdict-media/a.png)');
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:staged');
        await expect(resolver.resolve([first, second])).resolves.toBe(true);
        expect(resolver.rewriteStyles('A', 'url(mdict-media/a.png)')).toBe('url("blob:a")');
        expect(resolver.rewriteStyles('A', 'url(mdict-media/b.png)')).toBe('url("blob:b")');
    });

    test('obsolete completion cannot evict a replacement in-flight request', async () => {
        const old = Promise.withResolvers();
        const current = Promise.withResolvers();
        const media = {dictionary: 'A', path: 'mdict-media/a.png', mediaType: 'image/png', content: 'AA=='};
        const getMedia = vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(current.promise);
        const resolver = new DictionaryCssMediaResolver({getMedia}, {createObjectURL: () => 'blob:current'});
        const obsolete = resolver.resolve([media]);
        resolver.clear();
        const replacement = resolver.resolve([media]);
        old.resolve([media]);
        await expect(obsolete).resolves.toBe(false);
        const joined = resolver.resolve([media]);
        current.resolve([media]);
        await Promise.all([replacement, joined]);
        expect(getMedia).toHaveBeenCalledTimes(2);
        expect(resolver.rewriteStyles('A', 'url(mdict-media/a.png)')).toBe('url("blob:current")');
    });

    test('a joined failure settles independent batches before returning and permits retry', async () => {
        const failed = Promise.withResolvers();
        const healthy = Promise.withResolvers();
        const first = {dictionary: 'A', path: 'mdict-media/a.png', mediaType: 'image/png', content: 'AA=='};
        const second = {...first, path: 'mdict-media/b.png'};
        const getMedia = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(healthy.promise)
            .mockResolvedValueOnce([first]);
        const resolver = new DictionaryCssMediaResolver({getMedia}, {createObjectURL: () => 'blob:healthy'});
        const error = new Error('Media unavailable');
        const original = resolver.resolve([first]).catch((reason) => reason);
        let settled = false;
        const joined = resolver.resolve([first, second]).catch((reason) => {
            settled = true;
            return reason;
        });
        failed.reject(error);
        expect(await original).toBe(error);
        expect(settled).toBe(false);
        healthy.resolve([second]);
        expect(await joined).toBe(error);
        expect(resolver.rewriteStyles('A', 'url(mdict-media/b.png)')).toBe('url("blob:healthy")');
        await expect(resolver.resolve([first])).resolves.toBe(true);
        expect(getMedia).toHaveBeenCalledTimes(3);
    });

    test('allocation failure releases staged URLs, retaining previously cached media', async () => {
        const cached = {dictionary: 'A', path: 'mdict-media/cached.png', mediaType: 'image/png', content: 'AA=='};
        const first = {...cached, path: 'mdict-media/a.png'};
        const second = {...cached, path: 'mdict-media/b.png'};
        const getMedia = vi.fn().mockResolvedValueOnce([cached]).mockResolvedValueOnce([first, second]);
        const error = new Error('Object URL allocation failed');
        const createObjectURL = vi.fn().mockReturnValueOnce('blob:cached').mockReturnValueOnce('blob:staged')
            .mockImplementationOnce(() => { throw error; });
        const revokeObjectURL = vi.fn();
        const resolver = new DictionaryCssMediaResolver({getMedia}, {createObjectURL, revokeObjectURL});
        await resolver.resolve([cached]);
        await expect(resolver.resolve([cached, first, second])).rejects.toBe(error);
        expect(resolver.rewriteStyles('A', 'url(mdict-media/cached.png)')).toBe('url("blob:cached")');
        expect(resolver.rewriteStyles('A', 'url(mdict-media/a.png)')).toBe('url(mdict-media/a.png)');
        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:staged');
    });

    test('ignores unsolicited identities and duplicate deliveries before decoding', async () => {
        const media = {dictionary: 'A', path: 'mdict-media/a.png', mediaType: 'image/png', content: 'AA=='};
        const getMedia = vi.fn().mockResolvedValue([
            {...media, dictionary: 'B', content: '%%%'},
            {...media, path: 'mdict-media/unrequested.png', content: '%%%'},
            media,
            {...media, content: '%%%'},
        ]);
        const createObjectURL = vi.fn(() => 'blob:a');
        const resolver = new DictionaryCssMediaResolver({getMedia}, {createObjectURL});
        await expect(resolver.resolve([media])).resolves.toBe(true);
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(resolver.rewriteStyles('B', 'url(mdict-media/a.png)')).toBe('url(mdict-media/a.png)');
    });

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
            {name: 'A', enabled: true},
            {name: 'B', enabled: false},
        ]);

        expect(revokeObjectURL).toHaveBeenCalledWith('blob:b');
        expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:a');
    });
});

describe('getMdictMediaPathFromComputedUrl', () => {
    test('preserves ambiguous declared identities and does not fetch unused stylesheet resources', async () => {
        const baseUrl = 'chrome-extension://example/search.html';
        const paths = ['mdict-media/literal%20name.png', 'mdict-media/literal name.png'];
        const css = [
            ...paths.map((path, index) => `.image${index}{background:url("${path}")}`),
            '.unused{background:url("mdict-media/unused.png")}',
            '.duplicate{background:url("mdict-media/literal%20name.png")}',
            '/* url("mdict-media/comment.png") */',
            '.label{content:\'url("mdict-media/string.png")\'}',
        ].join('\n');
        const declaredPaths = getMdictMediaUrlPathMap(css, baseUrl);
        expect(declaredPaths.size).toBe(2);
        const computed = `url("${new URL(paths[0], baseUrl).href}")`;
        const activePaths = getMdictMediaPathsFromComputedCss(computed, baseUrl, declaredPaths);
        expect(activePaths).toStrictEqual(paths);
        expect(getMdictMediaPathsFromComputedCss('url("https://other.invalid/mdict-media/literal%20name.png")', baseUrl, declaredPaths)).toStrictEqual([]);

        const getMedia = vi.fn().mockResolvedValue(paths.map((path, index) => ({
            dictionary: 'A', path, mediaType: 'image/png', content: 'AA==', index,
        })));
        const resolver = new DictionaryCssMediaResolver({getMedia}, {
            createObjectURL: vi.fn().mockReturnValueOnce('blob:literal').mockReturnValueOnce('blob:space'),
            revokeObjectURL: vi.fn(),
        });
        await resolver.resolve(activePaths.map((path) => ({dictionary: 'A', path})));
        expect(getMedia).toHaveBeenCalledExactlyOnceWith(paths.map((path) => ({dictionary: 'A', path})));
        const rewritten = resolver.rewriteStyles('A', css);
        expect(rewritten).toContain('.image0{background:url("blob:literal")}');
        expect(rewritten).toContain('.image1{background:url("blob:space")}');
        expect(rewritten).toContain('.unused{background:url("mdict-media/unused.png")}');
        expect(resolver.rewriteStyles('B', css)).toBe(css);
    });

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
