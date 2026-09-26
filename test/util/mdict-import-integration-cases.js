/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {DOMParser} from '../../ext/lib/linkedom.js';
import {Mdx} from '../../ext/js/comm/mdx.js';
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {DictionaryImportController} from '../../ext/js/pages/settings/dictionary-import-controller.js';
import {appendMdictConversionWarnings, getMdictConversionWarnings} from '../../ext/js/pages/settings/mdict-import-feedback.js';
import {makeFixturePng, makeMdictFixture} from './mdict-binary-fixture.js';

const originalParser = globalThis.DOMParser;
const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;
const originalConvert = Mdx.prototype.convertDictionary;
const controller = Object.create(DictionaryImportController.prototype);

afterEach(() => {
    globalThis.DOMParser = originalParser;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    Mdx.prototype.convertDictionary = originalConvert;
});

/**
 * @param {string[]} links
 * @param {string|null} [mdx]
 * @returns {{mdxLink: {url: string, fileName: string}, mddLinks: Array<{url: string, fileName: string}>}|null}
 */
function listing(links, mdx = null) {
    globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
        /** @type {unknown} */ (DOMParser)
    );
    return controller._parseMdxListingDocument(
        'https://example.com/dicts/',
        links.map((href) => `<a href="${href}">file</a>`).join(''),
        mdx,
    );
}

/**
 * @param {{mddLinks?: Array<{fileName: string}>}|null} result
 * @returns {string[]|undefined}
 */
function names(result) {
    return result?.mddLinks?.map(({fileName}) => fileName);
}

test('URL parser pairs numeric stems before sorting their split resources', () => {
    assert.deepEqual(
        names(listing(['Book.2024.10.mdd', 'Book.2024.mdx', 'Book.2024.mdd', 'Book.2024.2.mdd'])),
        ['Book.2024.mdd', 'Book.2024.2.mdd', 'Book.2024.10.mdd'],
    );
});

test('download stage preserves validated MDD volume order instead of sorting by the last suffix', async () => {
    const c = Object.create(DictionaryImportController.prototype);
    c._downloadDictionaryFileViaXhr = async () => new File(['x'], 'server-download');
    const paths = [
        'Book.2024.mdd',
        'Book.2024.0.mdd',
        'Book.2024.1.mdd',
        'Book.2024.9007199254740992.mdd',
        'Book.2024.9007199254740993.mdd',
    ];
    const listingFiles = paths.map((fileName) => ({
        fileName,
        url: `https://example.com/${fileName}`,
    }));
    const files = /** @type {File[]} */ (await c._downloadListingFiles(
        listingFiles,
        100,
        () => {},
        new AbortController().signal,
    ));
    assert.deepEqual(files.map(({name}) => name), paths);
});

test('duplicate links to the same URL do not make a single MDX ambiguous', () => {
    assert.deepEqual(
        names(listing(['Book.mdx', 'Book.mdx#download', 'Book.mdd', 'Book.mdd'])),
        ['Book.mdd'],
    );
});

test('same-name MDDs in other directories or origins cannot join the selected set', () => {
    assert.deepEqual(
        names(listing([
            'Book.mdx',
            'Book.mdd',
            '../other/Book.1.mdd',
            'https://other.example/dicts/Book.2.mdd',
            'file:///Book.3.mdd',
        ])),
        ['Book.mdd'],
    );
});

test('a foreign MDX link does not make the local dictionary ambiguous', () => {
    assert.deepEqual(
        names(listing(['Book.mdx', 'https://other.example/Other.mdx', 'Book.mdd'])),
        ['Book.mdd'],
    );
});

test('multiple local MDX files require an explicit choice and keep exact numeric ownership', () => {
    assert.equal(listing(['Book.mdx', 'Book.1.mdx', 'Book.1.mdd']), null);
    assert.deepEqual(
        names(listing(['Book.mdx', 'Book.1.mdx', 'Book.1.mdd', 'Book.mdd'], 'Book.mdx')),
        ['Book.mdd'],
    );
});

test('distinct URLs for the same selected MDD path are rejected, not arbitrarily ordered', () => {
    assert.throws(
        () => listing(['Book.mdx', 'Book.mdd?version=1', 'Book.mdd?version=2']),
        /Ambiguous MDD/u,
    );
});

test('direct URL companion discovery surfaces detected ambiguity instead of silently losing media', async () => {
    globalThis.DOMParser = /** @type {typeof globalThis.DOMParser} */ (
        /** @type {unknown} */ (DOMParser)
    );
    globalThis.fetch = async () => new Response(
        '<a href="Book.mdx">x</a><a href="Book.mdd?v=1">a</a><a href="Book.mdd?v=2">b</a>',
        {headers: {'content-type': 'text/html'}},
    );
    await assert.rejects(
        controller._getMdxListingForUrl(
            'https://example.com/dicts/Book.mdx',
            'Book.mdx',
            new AbortController().signal,
        ),
        /Ambiguous MDD/u,
    );
});

test('abort during companion discovery is not turned into MDX-only success', async () => {
    const abort = new AbortController();
    const reason = new Error('cancelled by test');
    globalThis.fetch = async () => {
        abort.abort(reason);
        throw reason;
    };
    await assert.rejects(
        controller._getMdxListingForUrl(
            'https://example.com/Book.mdx',
            'Book.mdx',
            abort.signal,
        ),
        reason,
    );
});

test('unavailable optional listing still permits MDX-only fallback', async () => {
    globalThis.fetch = async () => {
        throw new Error('offline');
    };
    assert.equal(
        await controller._getMdxListingForUrl(
            'https://example.com/Book.mdx',
            'Book.mdx',
            new AbortController().signal,
        ),
        null,
    );
});

/**
 * @param {Awaited<ReturnType<typeof createMdxImportData>>} data
 * @returns {Record<string, string|number|boolean|null>}
 */
function stats(data) {
    return data.phaseTimings.find(
        ({phase}) => phase === 'prepare-mdx:materialize-assets',
    )?.details ?? {};
}

/**
 * @param {Parameters<typeof makeMdictFixture>[0]} entries
 * @param {Parameters<typeof createMdxImportData>[3]} [mdd]
 * @param {Parameters<typeof createMdxImportData>[1]} [options]
 * @returns {ReturnType<typeof createMdxImportData>}
 */
async function convert(entries, mdd = [], options = {}) {
    const mdx = makeMdictFixture(entries, {recordBlockSize: 7});
    return await createMdxImportData('Book.mdx', options, mdx.bytes, mdd);
}

test('native MDX with no resource references emits no missing-MDD warning', async () => {
    const data = await convert([{key: 'cat', value: '<p>A cat</p>'}]);
    assert.deepEqual(getMdictConversionWarnings(data.phaseTimings), []);
});

test('native repeated missing references are counted once per asset, not once per entry', async () => {
    const data = await convert([
        {key: 'a', value: '<img src="missing.png"><img src="missing.png">'},
        {key: 'b', value: '<img src="missing.png">'},
    ]);
    assert.equal(stats(data).missingReferencedAssetCount, 1);
    assert.match(getMdictConversionWarnings(data.phaseTimings)[0], /1 referenced resource/u);
});

test('native split-record MDD media and case-fallback references materialize without a missing count', async () => {
    const png = makeFixturePng([12, 34, 56, 255]);
    const mdd = makeMdictFixture(
        [{key: '\\Image.PNG', value: png}],
        {mdd: true, recordBlockSize: 7},
    );
    const data = await convert(
        [{key: 'cat', value: '<img src="image.png">'}],
        [{name: 'Book.MDD', bytes: mdd.bytes}],
    );
    assert.deepEqual(data.files.get('mdict-media/image.png'), png);
    assert.equal(stats(data).missingReferencedAssetCount ?? 0, 0);
    assert.deepEqual(getMdictConversionWarnings(data.phaseTimings), []);
});

test('native MDD exact lookup still wins when case-insensitive fallback is ambiguous', async () => {
    const exactPng = makeFixturePng([10, 20, 30, 255]);
    const variantPng = makeFixturePng([40, 50, 60, 255]);
    const mdd = makeMdictFixture(
        [
            {key: '\\Image.PNG', value: exactPng},
            {key: '\\image.png', value: variantPng},
        ],
        {mdd: true, recordBlockSize: 7},
    );
    const data = await convert(
        [{key: 'cat', value: '<img src="Image.PNG">'}],
        [{name: 'Book.MDD', bytes: mdd.bytes}],
    );
    assert.deepEqual(data.files.get('mdict-media/Image.PNG'), exactPng);
    assert.equal(stats(data).missingReferencedAssetCount ?? 0, 0);
});

test('native MDD ambiguous case-insensitive fallback remains unresolved', async () => {
    const firstPng = makeFixturePng([10, 20, 30, 255]);
    const secondPng = makeFixturePng([40, 50, 60, 255]);
    const mdd = makeMdictFixture(
        [
            {key: '\\Image.PNG', value: firstPng},
            {key: '\\image.png', value: secondPng},
        ],
        {mdd: true, recordBlockSize: 7},
    );
    const data = await convert(
        [{key: 'cat', value: '<img src="IMAGE.PNG">'}],
        [{name: 'Book.MDD', bytes: mdd.bytes}],
    );
    assert.equal(data.files.has('mdict-media/IMAGE.PNG'), false);
    assert.equal(stats(data).missingReferencedAssetCount, 1);
});

test('native embedded image is not misreported as missing external media', async () => {
    const png = Buffer.from(makeFixturePng([12, 34, 56, 255])).toString('base64');
    const data = await convert([
        {key: 'cat', value: `<img src="data:image/png;base64,${png}">`},
    ]);
    assert.equal(stats(data).missingReferencedAssetCount ?? 0, 0);
});

test('native CSS dependencies contribute to missing resources', async () => {
    const mdd = makeMdictFixture(
        [{key: 'styles/main.css', value: '.word {background: url(images/missing.png)}'}],
        {mdd: true, recordBlockSize: 7},
    );
    const data = await convert(
        [{key: 'cat', value: '<div class="word">A cat</div>'}],
        [{name: 'Book.mdd', bytes: mdd.bytes}],
    );
    assert.equal(stats(data).missingReferencedAssetCount, 1);
});

test('explicit media opt-out does not tell the user their resource set is incomplete', async () => {
    const data = await convert(
        [{key: 'cat', value: '<img src="missing.png">'}],
        [],
        {includeAssets: false},
    );
    assert.deepEqual(getMdictConversionWarnings(data.phaseTimings), []);
});

test('native partial record failure remains a skipped-definition warning, not a missing-resource count', async () => {
    const mdx = makeMdictFixture(
        [{key: 'a', value: 'bad'}, {key: 'b', value: 'good'}],
        {compression: 'raw', recordBlockSize: 4},
    );
    mdx.bytes[mdx.recordDataOffset] = 3;
    const data = await createMdxImportData('Book.mdx', {}, mdx.bytes, []);
    const warnings = getMdictConversionWarnings(data.phaseTimings);
    assert.match(warnings[0], /1 definition record was skipped/u);
    assert.equal(stats(data).missingReferencedAssetCount ?? 0, 0);
});

test('native unresolved alias surfaces without misclassifying the target dictionary as a storage failure', async () => {
    const data = await convert([
        {key: 'a', value: '@@@LINK=absent'},
        {key: 'b', value: 'A valid definition'},
    ]);
    assert.match(getMdictConversionWarnings(data.phaseTimings)[0], /1 redirect alias/u);
});

test('real DOM note rendering treats a filename as text and keeps notices separate from errors', () => {
    const document = new DOMParser().parseFromString(
        '<html><body><div id="notes" hidden></div><div id="dictionary-error" hidden></div></body></html>',
        'text/html',
    );
    const notes = /** @type {HTMLElement} */ (document.querySelector('#notes'));
    appendMdictConversionWarnings(
        notes,
        'Book <b>name</b>.mdx',
        [{phase: 'prepare-mdx:convert-entries', details: {skippedEntryErrorCount: 1}}],
    );
    assert.match(notes.textContent ?? '', /Book <b>name<\/b>\.mdx/u);
    assert.equal(notes.querySelector('b'), null);
    assert.equal(
        /** @type {HTMLElement} */ (document.querySelector('#dictionary-error')).hidden,
        true,
    );
});

/**
 * @param {boolean} stale
 * @returns {{c: DictionaryImportController, calls: number}}
 */
function importHarness(stale) {
    const c = Object.create(DictionaryImportController.prototype);
    globalThis.document = new DOMParser().parseFromString(
        '<html><body><div class="mdict-import-warnings" hidden></div></body></html>',
        'text/html',
    );
    let calls = 0;
    c._activeMdx = null;
    c._activeImportRunGeneration = 1;
    c._isImportRunCurrent = () => !stale;
    c._recordImportLocalPhase = () => {};
    c._tryImportDictionaryOffscreen = async () => {
        ++calls;
        return {result: {title: 'Book'}, errors: []};
    };
    c._finalizeImportedDictionaryResult = async () => ({
        errors: [],
        importedTitle: 'Book',
    });
    Mdx.prototype.convertDictionary = async () => ({
        archiveContent: new ArrayBuffer(1),
        archiveFileName: 'Book.zip',
        phaseTimings: [{
            phase: 'prepare-mdx:convert-entries',
            elapsedMs: 0,
            details: {skippedEntryErrorCount: 1},
        }],
    });
    return {
        c,
        get calls() {
            return calls;
        },
    };
}

test('controller fences stale conversion before publishing notices or invoking storage', async () => {
    const h = importHarness(true);
    await assert.rejects(
        h.c._importDictionaryFromMdx(
            {type: 'mdx', mdxFile: new File(['x'], 'Book.mdx'), mddFiles: []},
            null,
            {},
            false,
            true,
            1,
            () => {},
        ),
        /stale MDX/u,
    );
    assert.equal(h.calls, 0);
    assert.equal(document.querySelector('.mdict-import-warnings')?.textContent, '');
    assert.equal(h.c._activeMdx, null);
});

test('controller publishes a conversion note without turning successful installation into an error', async () => {
    const h = importHarness(false);
    const result = await h.c._importDictionaryFromMdx(
        {type: 'mdx', mdxFile: new File(['x'], 'Book.mdx'), mddFiles: []},
        null,
        {},
        false,
        true,
        1,
        () => {},
    );
    assert.equal(h.calls, 1);
    assert.deepEqual(result, {errors: [], importedTitle: 'Book'});
    assert.match(
        document.querySelector('.mdict-import-warnings')?.textContent ?? '',
        /Installation status is shown separately/u,
    );
    assert.equal(h.c._activeMdx, null);
});

test('direct MDX download preserves its URL filename for companion discovery', async () => {
    const c = Object.create(DictionaryImportController.prototype);
    c._downloadDictionaryFileViaXhr = async () => new File(['mdx'], 'download.bin');
    c._getMdxListingForUrl = async (
        /** @type {string} */ url,
        /** @type {string} */ filename,
    ) => {
        assert.equal(filename, 'Book.2024.mdx');
        return {
            mdxLink: {url, fileName: filename},
            mddLinks: [{
                url: url.replace('.mdx', '.mdd'),
                fileName: 'Book.2024.mdd',
            }],
        };
    };
    c._downloadListingFiles = async () => [new File(['mdd'], 'Book.2024.mdd')];
    const source = await c._downloadMdxImportSourceFromUrl(
        'https://example.com/Book.2024.mdx',
        100,
        () => {},
        new AbortController().signal,
        'Book.2024.mdx',
    );
    assert.equal(source.mdxFile.name, 'Book.2024.mdx');
    assert.equal(await source.mdxFile.text(), 'mdx');
    assert.equal(source.mddFiles.length, 1);
});

test('directory-listing MDX download keeps the validated filename and original bytes', async () => {
    const c = Object.create(DictionaryImportController.prototype);
    c._downloadDictionaryFileViaXhr = async () => new File(['mdx'], 'download.bin');
    c._downloadListingFiles = async () => [];
    const source = await c._downloadMdxImportSourceFromListing(
        {
            mdxLink: {
                url: 'https://example.com/Book.mdx',
                fileName: 'Book.mdx',
            },
            mddLinks: [],
        },
        100,
        () => {},
        new AbortController().signal,
    );
    assert.equal(source.mdxFile.name, 'Book.mdx');
    assert.equal(await source.mdxFile.text(), 'mdx');
});
