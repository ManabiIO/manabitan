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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DOMParser} from '../ext/lib/linkedom.js';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {createMdictImportSources, normalizeMdictImportPath, resolveMddImportKey} from '../ext/js/dictionary/mdict-import-sources.js';

/**
 * @param {string} path
 * @returns {File}
 */
function file(path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const result = new File(['fixture'], name);
    Object.defineProperty(result, 'webkitRelativePath', {value: path.includes('/') ? path : ''});
    return result;
}

describe('MDict import path identity', () => {
    test.each([' ', '\t', '\u00a0', '\ufeff'])('preserves leading %j in file and directory identities', (prefix) => {
        for (const directory of ['', 'Folder/']) {
            const first = file(`${prefix}${directory}Book.mdx`);
            const firstMedia = file(`${prefix}${directory}BOOK.mdd`);
            const second = file(`${directory}Book.mdx`);
            const secondMedia = file(`${directory}book.mdd`);
            const selected = [firstMedia, second, secondMedia, first];
            const {sources, errors} = createMdictImportSources(selected);
            expect(errors).toEqual([]);
            expect(sources).toEqual([
                {type: 'mdx', mdxFile: first, mddFiles: [firstMedia]},
                {type: 'mdx', mdxFile: second, mddFiles: [secondMedia]},
            ]);
            expect(selected).toEqual([firstMedia, second, secondMedia, first]);
        }
    });

    test('does not donate an orphan resource after trimming its directory', () => {
        const mdxFile = file('Folder/Book.mdx');
        const {sources, errors} = createMdictImportSources([mdxFile, file(' Folder/Book.mdd')]);
        expect(sources).toEqual([{type: 'mdx', mdxFile, mddFiles: []}]);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('without a matching MDX');
    });

    test('preserves leading spaces while matching and sorting multipart resources', () => {
        const mdxFile = file(' Book.mdx');
        const mddFiles = [file(' Book.mdd'), file(' Book.2.mdd'), file(' Book.10.mdd')];
        const {sources, errors} = createMdictImportSources([mddFiles[2], mdxFile, mddFiles[1], mddFiles[0]]);
        expect(errors).toEqual([]);
        expect(sources).toEqual([{type: 'mdx', mdxFile, mddFiles}]);
        expect(resolveMddImportKey(' Book.2.MDD', new Set([' book']))).toBe(' book');
    });

    test('does not reinterpret trailing filename whitespace as an extension', () => {
        const mdxFile = file('Book.mdx');
        const {sources, errors} = createMdictImportSources([mdxFile, file('Book.mdd '), file('Book.zip\t')]);
        expect(sources).toEqual([{type: 'mdx', mdxFile, mddFiles: []}]);
        expect(errors).toHaveLength(2);
        expect(normalizeMdictImportPath(' Book.MDX ')).toBe(' book.mdx ');
    });

    test('retains case-insensitive basenames and path-separator normalization', () => {
        expect(normalizeMdictImportPath(' Folder\\BOOK.MDD')).toBe(' Folder/book.mdd');
        expect(resolveMddImportKey(' Folder\\Book.2.MDD', new Set([' Folder/book']))).toBe(' Folder/book');
    });
});


describe('MDict URL filename identity', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    /**
     * @param {string[]} links
     * @param {string|null} mdxFileName
     * @returns {ReturnType<DictionaryImportController['_parseMdxListingDocument']>}
     */
    function listing(links, mdxFileName) {
        vi.stubGlobal('DOMParser', DOMParser);
        const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        return controller._parseMdxListingDocument(
            'https://example.com/dictionaries/',
            links.map((href) => `<a href="${href}">file</a>`).join(''),
            mdxFileName,
        );
    }

    test('selects a whitespace-distinct MDX without declaring an ambiguous match', () => {
        const result = listing(['Book.mdx', '%20Book.mdx', 'Book.mdd', '%20Book.mdd', '%20Book.2.mdd'], ' Book.mdx');
        expect(result?.mdxLink.fileName).toBe(' Book.mdx');
        expect(result?.mddLinks.map(({fileName}) => fileName)).toEqual([' Book.mdd', ' Book.2.mdd']);
    });

    test('does not attach a different resource after URL decoding', () => {
        const result = listing(['Book.mdx', 'Book.mdd', '%20Book.mdd'], 'Book.mdx');
        expect(result?.mddLinks.map(({fileName}) => fileName)).toEqual(['Book.mdd']);
    });

    test('does not treat trailing encoded whitespace as part of an accepted extension', () => {
        const result = listing(['Book.mdx', 'Book.mdx%20', 'Book.mdd', 'Book.mdd%20'], null);
        expect(result?.mdxLink.fileName).toBe('Book.mdx');
        expect(result?.mddLinks.map(({fileName}) => fileName)).toEqual(['Book.mdd']);
    });
});
