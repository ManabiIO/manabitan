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

import JSZip from 'jszip';
import {afterEach, describe, expect, test, vi} from 'vitest';

/**
 * @typedef {{header: {Title?: string, Description?: string}, entries: Array<{keyText: string, definition: string}>}} MockMdxDictionary
 */

/**
 * @typedef {Array<{keyText: string, value: Uint8Array}>} MockMddDictionary
 */

/** @type {{mdxFactory: (fileName: string) => MockMdxDictionary, mddFactory: (fileName: string) => MockMddDictionary}} */
const mockState = {
    /**
     * @param {string} fileName
     * @returns {{
     *   header: {Title?: string, Description?: string},
     *   entries: Array<{keyText: string, definition: string}>
     * }}
     */
    mdxFactory(fileName) {
        return {
            header: {
                Title: fileName.replace(/\.mdx$/u, ''),
                Description: '',
            },
            entries: [],
        };
    },
    /**
     * @param {string} _fileName
     * @returns {Array<{keyText: string, value: Uint8Array}>}
     */
    mddFactory(_fileName) {
        return [];
    },
};

vi.mock('../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js', () => ({
    MDX: class {
        /**
         * @param {string} fileName
         */
        constructor(fileName) {
            const {header, entries} = mockState.mdxFactory(fileName);
            this.header = header;
            this.keywordList = entries.map(({keyText}) => ({keyText}));
            this._definitions = new Map(entries.map(({keyText, definition}) => [keyText, definition]));
        }

        /**
         * @param {{keyText: string}} item
         * @returns {{definition: string}}
         */
        fetch_definition(item) {
            return {definition: this._definitions.get(item.keyText) ?? ''};
        }

        close() {}
    },
}));

vi.mock('../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js', () => ({
    MDD: class {
        /**
         * @param {string} fileName
         */
        constructor(fileName) {
            const entries = mockState.mddFactory(fileName);
            this.keywordList = entries.map(({keyText}) => ({keyText}));
            this._records = new Map(entries.map(({keyText, value}) => [keyText, value]));
        }

        /**
         * @param {{keyText: string}} item
         * @returns {Uint8Array|null}
         */
        lookupRecordByKeyBlock(item) {
            return this._records.get(item.keyText) ?? null;
        }

        close() {}
    },
}));

const {convertMdxToArchive} = await import('../ext/js/dictionary/mdx/mdx-converter.js');

afterEach(() => {
    mockState.mdxFactory = /** @type {(fileName: string) => MockMdxDictionary} */ ((fileName) => ({
        header: {
            Title: fileName.replace(/\.mdx$/u, ''),
            Description: '',
        },
        entries: [],
    }));
    mockState.mddFactory = /** @type {(fileName: string) => MockMddDictionary} */ ((_fileName) => []);
});

/**
 * @param {ArrayBuffer} archiveContent
 * @returns {Promise<JSZip>}
 */
async function loadArchive(archiveContent) {
    return JSZip.loadAsync(Buffer.from(archiveContent));
}

/**
 * @param {JSZip} zip
 * @param {string} path
 * @returns {Promise<unknown>}
 * @throws {Error}
 */
async function readJson(zip, path) {
    const file = zip.file(path);
    if (file === null) {
        throw new Error(`Expected archive file ${path}`);
    }
    return JSON.parse(await file.async('text'));
}

describe('convertMdxToArchive', () => {
    test('converts redirects, metadata, structured content, and MDD assets into a Yomitan archive', async () => {
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Mock MDX',
                Description: 'Mock description',
            },
            entries: [
                {
                    keyText: 'Read',
                    definition: '<div class="entry"><style>.accent{background:url("images/read.png")}</style><span class="accent">To look at and understand written language.</span><a href="sound://audio/read.mp3">play</a><img src="images/read.png" alt="read"></div>',
                },
                {
                    keyText: 'read',
                    definition: '@@@LINK=Read',
                },
            ],
        });
        mockState.mddFactory = () => [
            {keyText: 'audio/read.mp3', value: Uint8Array.of(1, 2, 3)},
            {keyText: 'images/read.png', value: Uint8Array.of(4, 5, 6)},
            {keyText: 'styles/extra.css', value: new TextEncoder().encode('.from-mdd{background:url("../images/read.png")}')},
        ];

        const result = await convertMdxToArchive(
            'mock.mdx',
            {enableAudio: true},
            new Uint8Array([1, 2, 3]),
            [{name: 'mock.mdd', bytes: new Uint8Array([9, 9, 9])}],
        );
        const zip = await loadArchive(result.archiveContent);
        const index = /** @type {{title: string, description: string, revision: string}} */ (await readJson(zip, 'index.json'));
        const termBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(zip, 'term_bank_1.json'));
        const stylesCss = await zip.file('styles.css')?.async('text');

        expect(result.archiveFileName).toBe('Mock MDX.zip');
        expect(index).toMatchObject({
            title: 'Mock MDX',
            description: 'Mock description',
            revision: 'mdx import',
        });
        expect(termBank.map(([expression]) => expression)).toStrictEqual(['Read', 'read']);

        const glossary = /** @type {{type: string, content: {content: Array<unknown>}}} */ (termBank[0][5][0]);
        const rootEntry = /** @type {{content: Array<unknown>}} */ (glossary.content.content[0]);
        expect(glossary.type).toBe('structured-content');
        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'a',
            href: 'media:mdict-media/audio/read.mp3',
        }));
        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'img',
            path: 'mdict-media/images/read.png',
            alt: 'read',
        }));

        expect(stylesCss).toContain('/* Source: styles/extra.css */');
        expect(stylesCss).toContain('/* Source: Read/inline/1.css */');
        expect(stylesCss).toContain('url("mdict-media/images/read.png")');
        expect(await zip.file('mdict-media/audio/read.mp3')?.async('uint8array')).toStrictEqual(Uint8Array.of(1, 2, 3));
        expect(await zip.file('mdict-media/images/read.png')?.async('uint8array')).toStrictEqual(Uint8Array.of(4, 5, 6));
    });

    test('uses file-name fallback metadata and respects explicit overrides', async () => {
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Title (No HTML code allowed)',
                Description: '',
            },
            entries: [
                {
                    keyText: 'Fallback',
                    definition: '<a href="sound://audio/fallback.mp3">audio</a>',
                },
            ],
        });

        const fallbackResult = await convertMdxToArchive(
            'fallback-dictionary.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [],
        );
        const fallbackZip = await loadArchive(fallbackResult.archiveContent);
        const fallbackIndex = /** @type {{title: string, description: string}} */ (await readJson(fallbackZip, 'index.json'));
        const fallbackBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(fallbackZip, 'term_bank_1.json'));
        const fallbackGlossary = /** @type {{content: {content: Array<unknown>}}} */ (fallbackBank[0][5][0]);

        expect(fallbackResult.archiveFileName).toBe('fallback-dictionary.zip');
        expect(fallbackIndex).toMatchObject({
            title: 'fallback-dictionary',
            description: '',
        });
        expect(fallbackGlossary.content.content).toContainEqual(expect.objectContaining({
            tag: 'a',
            href: '#',
        }));

        const overrideResult = await convertMdxToArchive(
            'fallback-dictionary.mdx',
            {
                titleOverride: 'Override Title',
                descriptionOverride: 'Override Description',
                revision: '2026.03.18',
                enableAudio: false,
            },
            new Uint8Array([1]),
            [],
        );
        const overrideZip = await loadArchive(overrideResult.archiveContent);
        const overrideIndex = /** @type {{title: string, description: string, revision: string}} */ (await readJson(overrideZip, 'index.json'));

        expect(overrideResult.archiveFileName).toBe('Override Title.zip');
        expect(overrideIndex).toMatchObject({
            title: 'Override Title',
            description: 'Override Description',
            revision: '2026.03.18',
        });
    });

    test('blocks vbscript links and asset paths during conversion', async () => {
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Unsafe Links',
                Description: '',
            },
            entries: [
                {
                    keyText: 'Unsafe',
                    definition: '<div><a href="vbscript:msgbox(1)">bad link</a><img src="vbscript:msgbox(1)" alt="blocked"></div>',
                },
            ],
        });

        const result = await convertMdxToArchive(
            'unsafe-links.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [],
        );
        const zip = await loadArchive(result.archiveContent);
        const termBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(zip, 'term_bank_1.json'));
        const glossary = /** @type {{content: {content: Array<unknown>}}} */ (termBank[0][5][0]);
        const rootEntry = /** @type {{content: Array<unknown>}} */ (glossary.content.content[0]);

        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'a',
            href: '#',
        }));
        expect(rootEntry.content).not.toContainEqual(expect.objectContaining({
            tag: 'img',
            alt: 'blocked',
        }));
    });
});
