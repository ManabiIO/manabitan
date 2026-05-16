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

/** @type {{mdxFactory: (fileName: string) => MockMdxDictionary, mddFactory: (fileName: string) => MockMddDictionary, onFetchDefinition: (fileName: string, keyText: string) => void, onLookupRecord: (fileName: string, keyText: string) => void}} */
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
    onFetchDefinition(_fileName, _keyText) {},
    onLookupRecord(_fileName, _keyText) {},
};

vi.mock('../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js', () => ({
    MDX: class {
        /**
         * @param {string} fileName
         */
        constructor(fileName) {
            this._fileName = fileName;
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
            mockState.onFetchDefinition(this._fileName, item.keyText);
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
            this._fileName = fileName;
            const entries = mockState.mddFactory(fileName);
            this.keywordList = entries.map(({keyText}) => ({keyText}));
            this._records = new Map(entries.map(({keyText, value}) => [keyText, value]));
        }

        /**
         * @param {{keyText: string}} item
         * @returns {Uint8Array|null}
         */
        lookupRecordByKeyBlock(item) {
            mockState.onLookupRecord(this._fileName, item.keyText);
            return this._records.get(item.keyText) ?? null;
        }

        close() {}
    },
}));

const {convertMdxToArchive, createMdxImportData} = await import('../ext/js/dictionary/mdx/mdx-converter.js');

afterEach(() => {
    mockState.mdxFactory = /** @type {(fileName: string) => MockMdxDictionary} */ ((fileName) => ({
        header: {
            Title: fileName.replace(/\.mdx$/u, ''),
            Description: '',
        },
        entries: [],
    }));
    mockState.mddFactory = /** @type {(fileName: string) => MockMddDictionary} */ ((_fileName) => []);
    mockState.onFetchDefinition = () => {};
    mockState.onLookupRecord = () => {};
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
        /** @type {string[]} */
        const fetchedDefinitions = [];
        mockState.onFetchDefinition = (_fileName, keyText) => {
            fetchedDefinitions.push(keyText);
        };
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
        expect(fetchedDefinitions).toStrictEqual(['Read', 'read']);
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

    test('records direct MDX preparation subphase timings', async () => {
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Timing Fixture',
                Description: 'Timing description',
            },
            entries: [
                {
                    keyText: 'Timed',
                    definition: '<div><img src="images/timed.png"></div>',
                },
            ],
        });
        mockState.mddFactory = () => [
            {keyText: 'images/timed.png', value: Uint8Array.of(1, 2, 3)},
            {keyText: 'styles/extra.css', value: new TextEncoder().encode('.timed{background:url("../images/timed.png")}')},
        ];

        const {phaseTimings, files} = await createMdxImportData(
            'timing-fixture.mdx',
            {enableAudio: false},
            new Uint8Array([1, 2, 3]),
            [{name: 'timing-fixture.mdd', bytes: new Uint8Array([9, 9, 9])}],
        );

        expect(phaseTimings.map(({phase}) => phase)).toStrictEqual([
            'prepare-mdx:index-mdd',
            'prepare-mdx:convert-entries',
            'prepare-mdx:encode-banks',
            'prepare-mdx:materialize-assets',
        ]);
        expect(files.has('styles.css')).toBe(true);
        expect(files.has('mdict-media/images/timed.png')).toBe(true);
    });

    test('resolves aliases before and after the target and drops unresolved redirects', async () => {
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Redirect Fixture',
                Description: '',
            },
            entries: [
                {keyText: 'AliasBefore', definition: '@@@LINK=Target'},
                {keyText: 'MissingAlias', definition: '@@@LINK=MissingTarget'},
                {keyText: 'Target', definition: '<div>Resolved target</div>'},
                {keyText: 'AliasAfter', definition: '@@@LINK=Target'},
            ],
        });

        const result = await convertMdxToArchive(
            'redirect-fixture.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [],
        );
        const zip = await loadArchive(result.archiveContent);
        const termBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(zip, 'term_bank_1.json'));

        expect(termBank.map(([expression]) => expression)).toStrictEqual(['Target', 'AliasBefore', 'AliasAfter']);
        expect(termBank[0]?.[5]).toStrictEqual(termBank[1]?.[5]);
        expect(termBank[0]?.[5]).toStrictEqual(termBank[2]?.[5]);
        expect(termBank[0]?.[6]).toBe(termBank[1]?.[6]);
        expect(termBank[0]?.[6]).toBe(termBank[2]?.[6]);
        expect(termBank.some(([expression]) => expression === 'MissingAlias')).toBe(false);
    });

    test('uses the first matching MDD asset and skips unreferenced non-CSS assets', async () => {
        /** @type {string[]} */
        const lookupKeys = [];
        mockState.onLookupRecord = (_fileName, keyText) => {
            lookupKeys.push(keyText);
        };
        mockState.mdxFactory = () => ({
            header: {
                Title: 'MDD precedence',
                Description: '',
            },
            entries: [
                {keyText: 'Asset', definition: '<div><img src="images/shared.png"></div>'},
            ],
        });
        mockState.mddFactory = (fileName) => {
            if (fileName === 'first.mdd') {
                return [
                    {keyText: 'images/shared.png', value: Uint8Array.of(1, 2, 3)},
                    {keyText: 'unused/ignored.bin', value: Uint8Array.of(9, 9, 9)},
                ];
            }
            return [
                {keyText: 'images/shared.png', value: Uint8Array.of(4, 5, 6)},
            ];
        };

        const result = await convertMdxToArchive(
            'mdd-precedence.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [
                {name: 'first.mdd', bytes: new Uint8Array([1])},
                {name: 'second.mdd', bytes: new Uint8Array([2])},
            ],
        );
        const zip = await loadArchive(result.archiveContent);

        expect(await zip.file('mdict-media/images/shared.png')?.async('uint8array')).toStrictEqual(Uint8Array.of(1, 2, 3));
        expect(zip.file('mdict-media/unused/ignored.bin')).toBeNull();
        expect(lookupKeys).toStrictEqual(['images/shared.png']);
    });

    test('loads CSS url dependencies from MDD assets lazily', async () => {
        /** @type {string[]} */
        const lookupKeys = [];
        mockState.onLookupRecord = (_fileName, keyText) => {
            lookupKeys.push(keyText);
        };
        mockState.mdxFactory = () => ({
            header: {
                Title: 'CSS dependency fixture',
                Description: '',
            },
            entries: [
                {keyText: 'Styled', definition: '<div class="styled">Styled</div>'},
            ],
        });
        mockState.mddFactory = () => [
            {keyText: 'styles/extra.css', value: new TextEncoder().encode('.styled{background:url("../images/css-bg.png")}')},
            {keyText: 'images/css-bg.png', value: Uint8Array.of(7, 8, 9)},
        ];

        const result = await convertMdxToArchive(
            'css-dependency.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [{name: 'css-dependency.mdd', bytes: new Uint8Array([1])}],
        );
        const zip = await loadArchive(result.archiveContent);
        const stylesCss = await zip.file('styles.css')?.async('text');

        expect(stylesCss).toContain('url("mdict-media/images/css-bg.png")');
        expect(await zip.file('mdict-media/styles/extra.css')?.async('text')).toContain('background:url("../images/css-bg.png")');
        expect(await zip.file('mdict-media/images/css-bg.png')?.async('uint8array')).toStrictEqual(Uint8Array.of(7, 8, 9));
        expect(lookupKeys).toStrictEqual(['styles/extra.css', 'images/css-bg.png']);
    });

    test('strips URL query and hash fragments before resolving MDD assets', async () => {
        /** @type {string[]} */
        const lookupKeys = [];
        mockState.onLookupRecord = (_fileName, keyText) => {
            lookupKeys.push(keyText);
        };
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Fragmented asset fixture',
                Description: '',
            },
            entries: [
                {
                    keyText: 'Fragmented',
                    definition: '<div><style>.bg{background:url("Images/BG.PNG?cache=1")}</style><img src="Images/BG.PNG#preview"><a href="sound://Audio/Read.MP3?download=1">audio</a></div>',
                },
            ],
        });
        mockState.mddFactory = () => [
            {keyText: 'images/bg.png', value: Uint8Array.of(1, 2, 3)},
            {keyText: 'audio/read.mp3', value: Uint8Array.of(4, 5, 6)},
        ];

        const result = await convertMdxToArchive(
            'fragmented-assets.mdx',
            {enableAudio: true},
            new Uint8Array([1]),
            [{name: 'fragmented-assets.mdd', bytes: new Uint8Array([1])}],
        );
        const zip = await loadArchive(result.archiveContent);
        const termBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(zip, 'term_bank_1.json'));
        const stylesCss = await zip.file('styles.css')?.async('text');
        const glossary = /** @type {{content: {content: Array<unknown>}}} */ (termBank[0][5][0]);
        const rootEntry = /** @type {{content: Array<unknown>}} */ (glossary.content.content[0]);

        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'img',
            path: 'mdict-media/Images/BG.PNG',
        }));
        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'a',
            href: 'media:mdict-media/Audio/Read.MP3',
        }));
        expect(stylesCss).toContain('url("mdict-media/Images/BG.PNG")');
        expect(await zip.file('mdict-media/Images/BG.PNG')?.async('uint8array')).toStrictEqual(Uint8Array.of(1, 2, 3));
        expect(await zip.file('mdict-media/Audio/Read.MP3')?.async('uint8array')).toStrictEqual(Uint8Array.of(4, 5, 6));
        expect(lookupKeys).toStrictEqual(['images/bg.png', 'audio/read.mp3']);
    });

    test('decodes percent-encoded asset path segments without corrupting malformed escapes', async () => {
        /** @type {string[]} */
        const lookupKeys = [];
        mockState.onLookupRecord = (_fileName, keyText) => {
            lookupKeys.push(keyText);
        };
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Encoded asset fixture',
                Description: '',
            },
            entries: [
                {
                    keyText: 'Encoded',
                    definition: '<div><img src="images/space%20name.png"><img src="images/bad%ZZname.png"></div>',
                },
            ],
        });
        mockState.mddFactory = () => [
            {keyText: 'images/space name.png', value: Uint8Array.of(1, 2, 3)},
            {keyText: 'images/bad%ZZname.png', value: Uint8Array.of(4, 5, 6)},
        ];

        const result = await convertMdxToArchive(
            'encoded-assets.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [{name: 'encoded-assets.mdd', bytes: new Uint8Array([1])}],
        );
        const zip = await loadArchive(result.archiveContent);
        const termBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(zip, 'term_bank_1.json'));
        const glossary = /** @type {{content: {content: Array<unknown>}}} */ (termBank[0][5][0]);
        const rootEntry = /** @type {{content: Array<unknown>}} */ (glossary.content.content[0]);

        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'img',
            path: 'mdict-media/images/space name.png',
        }));
        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'img',
            path: 'mdict-media/images/bad%ZZname.png',
        }));
        expect(await zip.file('mdict-media/images/space name.png')?.async('uint8array')).toStrictEqual(Uint8Array.of(1, 2, 3));
        expect(await zip.file('mdict-media/images/bad%ZZname.png')?.async('uint8array')).toStrictEqual(Uint8Array.of(4, 5, 6));
        expect(lookupKeys).toStrictEqual(['images/space name.png', 'images/bad%ZZname.png']);
    });

    test('keeps malformed data URLs and empty dictionaries non-throwing', async () => {
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Malformed Fixture',
                Description: '',
            },
            entries: [
                {keyText: 'Malformed', definition: '<div><a href="data:image/png;base64,%%%%">bad</a><img src="data:image/png;base64,%%%%" alt="bad"></div>'},
            ],
        });

        const result = await convertMdxToArchive(
            'malformed-fixture.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [],
        );
        const zip = await loadArchive(result.archiveContent);
        const termBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(zip, 'term_bank_1.json'));
        expect(termBank.map(([expression]) => expression)).toStrictEqual(['Malformed']);

        mockState.mdxFactory = () => ({
            header: {
                Title: 'Empty Fixture',
                Description: '',
            },
            entries: [],
        });
        const emptyResult = await convertMdxToArchive(
            'empty-fixture.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [],
        );
        const emptyZip = await loadArchive(emptyResult.archiveContent);
        expect(await readJson(emptyZip, 'term_bank_1.json')).toStrictEqual([]);
    });

    test('skips corrupt MDX entries and optional MDD asset lookup failures without aborting import', async () => {
        mockState.onFetchDefinition = (_fileName, keyText) => {
            if (keyText === 'BadEntry') {
                throw new Error('corrupt definition block');
            }
        };
        mockState.onLookupRecord = (_fileName, keyText) => {
            if (keyText === 'images/broken.png') {
                throw new Error('corrupt asset block');
            }
        };
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Partial Corruption Fixture',
                Description: '',
            },
            entries: [
                {keyText: 'GoodEntry', definition: '<div><img src="images/good.png">ok</div>'},
                {keyText: 'BadEntry', definition: '<div>bad</div>'},
                {keyText: 'MissingAssetEntry', definition: '<div><img src="images/broken.png">kept</div>'},
            ],
        });
        mockState.mddFactory = () => [
            {keyText: 'images/good.png', value: Uint8Array.of(1, 2, 3)},
            {keyText: 'images/broken.png', value: Uint8Array.of(4, 5, 6)},
        ];

        const result = await convertMdxToArchive(
            'partial-corruption.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [{name: 'partial-corruption.mdd', bytes: new Uint8Array([1])}],
        );
        const zip = await loadArchive(result.archiveContent);
        const termBank = /** @type {Array<[string, string, string, string, number, Array<unknown>, number, string]>} */ (await readJson(zip, 'term_bank_1.json'));
        const convertPhase = result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:convert-entries');
        const assetPhase = result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:materialize-assets');

        expect(termBank.map(([expression]) => expression)).toStrictEqual(['GoodEntry', 'MissingAssetEntry']);
        expect(await zip.file('mdict-media/images/good.png')?.async('uint8array')).toStrictEqual(Uint8Array.of(1, 2, 3));
        expect(zip.file('mdict-media/images/broken.png')).toBeNull();
        expect(convertPhase?.details).toMatchObject({skippedEntryErrorCount: 1});
        expect(assetPhase?.details).toMatchObject({assetLookupErrorCount: 1});
    });

    test('rejects an all-corrupt non-empty MDX instead of producing an empty installed dictionary', async () => {
        mockState.onFetchDefinition = () => {
            throw new Error('corrupt definition block');
        };
        mockState.mdxFactory = () => ({
            header: {
                Title: 'All Corrupt Fixture',
                Description: '',
            },
            entries: [
                {keyText: 'BrokenOne', definition: '<div>bad</div>'},
                {keyText: 'BrokenTwo', definition: '<div>bad</div>'},
            ],
        });

        await expect(convertMdxToArchive(
            'all-corrupt.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [],
        )).rejects.toThrow('MDX import failed: all 2 non-empty entries were corrupt or unsupported');
    });

    test('rejects non-empty MDX files with no usable target entries', async () => {
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Redirect Only Fixture',
                Description: '',
            },
            entries: [
                {keyText: 'AliasOne', definition: '@@@LINK=MissingTarget'},
                {keyText: 'AliasTwo', definition: '@@@LINK=MissingTarget'},
            ],
        });

        await expect(convertMdxToArchive(
            'redirect-only.mdx',
            {enableAudio: false},
            new Uint8Array([1]),
            [],
        )).rejects.toThrow('MDX import failed: no usable non-redirect entries were found');
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

    test('encodes internal search links so terms with punctuation stay intact', async () => {
        mockState.mdxFactory = () => ({
            header: {
                Title: 'Internal link fixture',
                Description: '',
            },
            entries: [
                {
                    keyText: 'Internal',
                    definition: '<div><a href="entry://white space & 漢字">entry</a><a href="bword://rock&roll">bword</a><a href="d:かな?">d</a></div>',
                },
            ],
        });

        const result = await convertMdxToArchive(
            'internal-links.mdx',
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
            href: '?query=white%20space%20%26%20%E6%BC%A2%E5%AD%97',
        }));
        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'a',
            href: '?query=rock%26roll',
        }));
        expect(rootEntry.content).toContainEqual(expect.objectContaining({
            tag: 'a',
            href: '?query=%E3%81%8B%E3%81%AA%3F',
        }));
    });
});
