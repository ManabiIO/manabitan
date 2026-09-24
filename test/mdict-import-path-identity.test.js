/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DOMParser} from '../ext/lib/linkedom.js';
import {createMdictImportSources, normalizeMdictImportPath} from '../ext/js/dictionary/mdict-import-sources.js';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

/**
 * @param {string} path
 * @returns {File}
 */
function createFile(path) {
    const name = path.replaceAll('\\', '/').split('/').at(-1) ?? '';
    const file = new File(['fixture'], name);
    Object.defineProperty(file, 'webkitRelativePath', {value: path.includes('/') || path.includes('\\') ? path : ''});
    return Object.freeze(file);
}

/**
 * @param {string[]} paths
 * @returns {ReturnType<typeof createMdictImportSources>}
 */
function group(paths) {
    return createMdictImportSources(paths.map(createFile));
}

/**
 * @param {string[]} fileNames
 * @param {string|null} selectedMdx
 * @returns {ReturnType<DictionaryImportController['_parseMdxListingDocument']>}
 */
function listing(fileNames, selectedMdx) {
    const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
    const html = fileNames.map((name) => `<a href="${encodeURIComponent(name)}">file</a>`).join('');
    return controller._parseMdxListingDocument('https://example.com/dicts/', html, selectedMdx);
}

beforeEach(() => { vi.stubGlobal('DOMParser', DOMParser); });
afterEach(() => { vi.unstubAllGlobals(); });

describe.each([' ', '\t', '\u00a0', '\u3000', '\ufeff'])('MDict path identity for prefix %j', (prefix) => {
    test('does not collapse two distinct directories into a duplicate group', () => {
        const paths = [`${prefix}Books/Book.mdx`, 'Books/Book.mdx', 'Books/Book.mdd', `${prefix}Books/Book.mdd`];
        const {sources, errors} = group(paths);
        expect(errors).toEqual([]);
        expect(sources).toHaveLength(2);
        for (const source of sources) {
            expect(source.type).toBe('mdx');
            if (source.type !== 'mdx') { throw new Error('Expected MDX source'); }
            expect(source.mddFiles.map((file) => file.webkitRelativePath)).toEqual([
                source.mdxFile.webkitRelativePath.replace(/\.mdx$/u, '.mdd'),
            ]);
        }
    });

    test('does not attach resources from another directory', () => {
        const {sources, errors} = group([`${prefix}Books/Book.mdx`, 'Books/Book.mdd']);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('without a matching MDX');
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({type: 'mdx', mddFiles: []});
    });

    test('distinguishes leading basename whitespace while retaining case-insensitive matching', () => {
        const {sources, errors} = group([`${prefix}Book.mdx`, 'Book.mdx', `${prefix}BOOK.10.MDD`, 'book.mdd', `${prefix}book.mdd`]);
        expect(errors).toEqual([]);
        expect(sources).toHaveLength(2);
        expect(sources[0]).toMatchObject({
            type: 'mdx',
            mdxFile: {name: `${prefix}Book.mdx`},
            mddFiles: [
                {name: `${prefix}book.mdd`}, {name: `${prefix}BOOK.10.MDD`},
            ],
        });
        expect(sources[1]).toMatchObject({type: 'mdx', mdxFile: {name: 'Book.mdx'}, mddFiles: [{name: 'book.mdd'}]});
    });

    test('preserves names through URL decoding and directory discovery', () => {
        const names = [`${prefix}Book.mdx`, 'Book.mdx', `${prefix}Book.10.mdd`, 'Book.mdd', `${prefix}Book.mdd`];
        const result = listing(names, `${prefix}Book.mdx`);
        expect(result?.mdxLink.fileName).toBe(`${prefix}Book.mdx`);
        expect(result?.mddLinks.map(({fileName}) => fileName)).toEqual([`${prefix}Book.mdd`, `${prefix}Book.10.mdd`]);
    });
});

test.each([' ', '\u00a0', '\ufeff'])('does not trim trailing filename data %j into a supported extension', (suffix) => {
    const {sources, errors} = group([`Book.mdx${suffix}`, `Book.zip${suffix}`]);
    expect(sources).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(listing([`Book.mdx${suffix}`], null)).toBeNull();
});

test.each(['\n', '\r', '\u2028', '\u2029'])('pairs multipart resources when the original stem contains %j', (separator) => {
    const stem = `Book${separator}Name`;
    const names = [`${stem}.10.mdd`, `${stem}.mdx`, `${stem}.mdd`, `${stem}.2.mdd`];
    const {sources, errors} = group(names);
    expect(errors).toEqual([]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
        type: 'mdx',
        mddFiles: [
            {name: `${stem}.mdd`}, {name: `${stem}.2.mdd`}, {name: `${stem}.10.mdd`},
        ],
    });
    expect(listing(names, `${stem}.mdx`)?.mddLinks.map(({fileName}) => fileName))
        .toEqual([`${stem}.mdd`, `${stem}.2.mdd`, `${stem}.10.mdd`]);
});

test('normalization still folds only the basename and accepts Windows separators', () => {
    expect(normalizeMdictImportPath('Dir\\BOOK.MDX')).toBe('Dir/book.mdx');
    expect(normalizeMdictImportPath(' Dir\\BOOK.MDX')).toBe(' Dir/book.mdx');
    expect(normalizeMdictImportPath('Dir/ Book.MDX')).toBe('Dir/ book.mdx');
});
