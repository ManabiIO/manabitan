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

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {MDX} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdx.js';
import {MDD} from '../../ext/js/dictionary/mdx/vendor/js-mdict/mdd.js';
import {FileScanner} from '../../ext/js/dictionary/mdx/vendor/js-mdict/scanner.js';
import mdictCommon from '../../ext/js/dictionary/mdx/vendor/js-mdict/utils.js';
import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeFixturePng, makeMdictFixture} from './mdict-binary-fixture.js';
import {makeInlineStyleScopeFixture} from './mdict-inline-style-fixture.js';

/**
 * @param {Map<string, Uint8Array>} files
 * @returns {any[][]}
 */
function readRows(files) {
    return [...files.entries()]
        .filter(([path]) => /^term_bank_\d+\.json$/u.test(path))
        .sort(([a], [b]) => Number(a.match(/\d+/u)?.[0]) - Number(b.match(/\d+/u)?.[0]))
        .flatMap(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)));
}

/**
 * @param {unknown} value
 * @param {string} tag
 * @returns {Array<Record<string, any>>}
 */
function nodes(value, tag) {
    /** @type {Array<Record<string, any>>} */
    const found = [];
    const pending = [value];
    while (pending.length > 0) {
        const next = pending.pop();
        if (Array.isArray(next)) {
            pending.push(...next);
        } else if (typeof next === 'object' && next !== null) {
            const record = /** @type {Record<string, any>} */ (next);
            if (record.tag === tag) { found.push(record); }
            pending.push(...Object.values(record));
        }
    }
    return found;
}

// No parser, codec or HTML mocks. These exercise native bytes through conversion,
// but are not OPFS persistence or popup-rendering qualification.
describe('MDict v2 binary records', () => {
    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        for (const encoding of /** @type {const} */ (['utf8', 'utf16le'])) {
            for (const recordBlockSize of [1, 7, 64]) {
                test(`${compression}/${encoding}/${recordBlockSize}-byte blocks preserve whole records`, () => {
                    const entries = [
                        {key: 'apple', value: '<p>an intentionally longer definition</p>'},
                        {key: 'zebra', value: '<div>猫と犬 🐈 é\nsecond line</div>'},
                        {key: '猫', value: '<b>ねこ</b>'},
                    ];
                    const fixture = makeMdictFixture(entries, {compression, encoding, recordBlockSize, keysPerBlock: 1});
                    for (const recordBlockCacheBytes of [0, 1024]) {
                        const mdx = new MDX('records.MDX', fixture.bytes, {recordBlockCacheBytes});
                        try {
                            for (let i = 0; i < entries.length; i += 1) {
                                const item = mdx.keywordList.find(({keyText}) => keyText === entries[i].key);
                                assert.ok(item);
                                assert.deepEqual(mdx.lookupRecordByKeyBlock(item), fixture.records[i]);
                                assert.equal(mdx.fetch_definition(item).definition, `${entries[i].value}\0`);
                            }
                        } finally {
                            mdx.close();
                        }
                    }
                });
            }
        }
    }

    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        test(`${compression} uppercase MDD uses UTF-16 keys and preserves binary records`, () => {
            const entries = [
                {key: '\\images\\猫.png', value: makeFixturePng([200, 10, 30, 255])},
                {key: '\\audio\\read.mp3', value: Uint8Array.from({length: 260}, (_, i) => i & 255)},
            ];
            const fixture = makeMdictFixture(entries, {mdd: true, compression, recordBlockSize: 11, keysPerBlock: 1});
            const mdd = new MDD('assets.MDD', fixture.bytes);
            try {
                for (const {key, value} of entries) {
                    const item = mdd.keywordList.find(({keyText}) => keyText === key);
                    assert.ok(item);
                    assert.deepEqual(mdd.lookupRecordByKeyBlock(item), value);
                }
            } finally {
                mdd.close();
            }
        });
    }

    test('a valid empty dictionary has no keyword or lookup result', () => {
        const fixture = makeMdictFixture([]);
        const mdx = new MDX('empty.mdx', fixture.bytes);
        try {
            assert.deepEqual(mdx.keywordList, []);
            assert.equal(mdx.lookup('absent').definition, null);
        } finally {
            mdx.close();
        }
    });

    test('a truncated final block is rejected rather than silently shortened', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'nonempty final record'}], {compression: 'raw'});
        const mdx = new MDX('truncated.mdx', fixture.bytes.slice(0, -1));
        try {
            assert.throws(() => mdx.fetch_definition(mdx.keywordList[0]));
        } finally {
            mdx.close();
        }
    });

    test('an unsupported record codec is rejected', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'record'}], {compression: 'raw'});
        fixture.bytes[fixture.recordDataOffset] = 3;
        const mdx = new MDX('codec.mdx', fixture.bytes);
        try {
            assert.throws(() => mdx.fetch_definition(mdx.keywordList[0]), /compression/u);
        } finally {
            mdx.close();
        }
    });
});

describe('MDict redirect key matching', () => {
    test('case-insensitive dictionaries resolve redirect targets across case differences', async () => {
        const fixture = makeMdictFixture([
            {key: 'Alias', value: '@@@LINK=target'},
            {key: 'Target', value: '<div>definition</div>'},
        ], {keyCaseSensitive: 'No'});
        const result = await createMdxImportData('redirect-case.mdx', {}, fixture.bytes, []);
        const rows = readRows(result.files);
        assert.deepEqual(rows.map(([term]) => term).sort(), ['Alias', 'Target']);
        assert.equal(result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details?.unresolvedRedirectCount, 0);
    });

    test('case-insensitive redirects preserve a distinct alias spelling that differs only by case', async () => {
        const fixture = makeMdictFixture([
            {key: 'Read', value: '<div>definition</div>'},
            {key: 'read', value: '@@@LINK=Read'},
        ], {keyCaseSensitive: 'No'});
        const result = await createMdxImportData('redirect-alias-case.mdx', {}, fixture.bytes, []);
        const rows = readRows(result.files);
        assert.deepEqual(rows.map(([term]) => term), ['Read', 'read']);
        assert.equal(result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details?.unresolvedRedirectCount, 0);
    });

    test('case-sensitive dictionaries keep case-mismatched redirect targets unresolved', async () => {
        const fixture = makeMdictFixture([
            {key: 'Alias', value: '@@@LINK=target'},
            {key: 'Target', value: '<div>definition</div>'},
        ], {keyCaseSensitive: 'Yes'});
        const result = await createMdxImportData('redirect-case-sensitive.mdx', {}, fixture.bytes, []);
        const rows = readRows(result.files);
        assert.deepEqual(rows.map(([term]) => term), ['Target']);
        assert.equal(result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details?.unresolvedRedirectCount, 1);
    });

    test('case-insensitive multi-hop redirect chains preserve every original alias spelling', async () => {
        const fixture = makeMdictFixture([
            {key: 'AliasOne', value: '@@@LINK=ALIAStwo'},
            {key: 'AliasTwo', value: '@@@LINK=tArGeT'},
            {key: 'Target', value: '<div>definition</div>'},
        ], {keyCaseSensitive: 'No'});
        const result = await createMdxImportData('redirect-chain-case.mdx', {}, fixture.bytes, []);
        const rows = readRows(result.files);
        assert.deepEqual(rows.map(([term]) => term).sort(), ['AliasOne', 'AliasTwo', 'Target']);
        assert.equal(result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details?.unresolvedRedirectCount, 0);
    });
});

describe('MDict inline stylesheet isolation', () => {
    test('entry-local style blocks cannot style a different definition with the same source class', async () => {
        const fixture = makeMdictFixture([
            {key: 'Alpha', value: '<style>.shared { color: rgb(1, 2, 3); }</style><div class="shared">alpha</div>'},
            {key: 'Beta', value: '<div class="shared">beta</div>'},
        ]);
        const result = await createMdxImportData('inline-style-scope.mdx', {}, fixture.bytes, []);
        const rows = readRows(result.files);
        const alphaRoot = rows.find(([term]) => term === 'Alpha')?.[5]?.[0]?.content;
        const betaRoot = rows.find(([term]) => term === 'Beta')?.[5]?.[0]?.content;
        const styles = new TextDecoder().decode(result.files.get('styles.css'));

        assert.match(alphaRoot?.data?.class ?? '', /mdict-yomitan-entry-0/u);
        assert.doesNotMatch(betaRoot?.data?.class ?? '', /mdict-yomitan-entry-/u);
        assert.ok(styles.includes('[data-sc-class~="shared"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *)'));
        assert.doesNotMatch(styles, /(?:^|[,{])\s*\[data-sc-class~="shared"\]\s*\{/u);
    });

    test('separate inline styles with identical selectors receive distinct entry scopes', async () => {
        const fixture = makeMdictFixture([
            {key: 'Alpha', value: '<style>.shared { color: red; }</style><div class="shared">alpha</div>'},
            {key: 'Beta', value: '<style>.shared { color: blue; }</style><div class="shared">beta</div>'},
        ]);
        const result = await createMdxImportData('inline-style-distinct.mdx', {}, fixture.bytes, []);
        const rows = readRows(result.files);
        const styles = new TextDecoder().decode(result.files.get('styles.css'));
        const rootClasses = rows.map((row) => row[5][0].content.data.class);

        assert.match(rootClasses[0], /mdict-yomitan-entry-0/u);
        assert.match(rootClasses[1], /mdict-yomitan-entry-1/u);
        assert.ok(styles.includes('[data-sc-class~="shared"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){ color: red; }'));
        assert.ok(styles.includes('[data-sc-class~="shared"]:where([data-sc-class~="mdict-yomitan-entry-1"], [data-sc-class~="mdict-yomitan-entry-1"] *){ color: blue; }'));
    });

    test('nested inline rules and root selectors remain inside the entry scope', async () => {
        const fixture = makeMdictFixture([
            {key: 'Alpha', value: '<style>@media screen { .shared { color: red; } } :root > .shared { display: block; }</style><div class="shared">alpha</div>'},
        ]);
        const result = await createMdxImportData('inline-style-nested.mdx', {}, fixture.bytes, []);
        const styles = new TextDecoder().decode(result.files.get('styles.css'));

        assert.ok(styles.includes('@media screen { [data-sc-class~="shared"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *)'));
        assert.match(styles, /\[data-sc-class~="mdict-yomitan-entry-0"\] > \[data-sc-class~="shared"\]/u);
        assert.doesNotMatch(styles, /\[data-sc-class~="mdict-yomitan-entry-0"\] \[data-sc-class~="mdict-yomitan-entry-0"\]/u);
    });

    test('stylesheet source comments cannot be terminated by an entry name', async () => {
        const fixture = makeMdictFixture([
            {key: 'Alpha*/ .injected{display:block} /*', value: '<style>.safe { color: red; }</style><div class="safe">alpha</div>'},
        ]);
        const result = await createMdxImportData('inline-style-comment.mdx', {}, fixture.bytes, []);
        const styles = new TextDecoder().decode(result.files.get('styles.css'));

        assert.equal(styles.split('\n', 1)[0], '/* Source: Alpha* / .injected{display:block} /* /inline/1.css */');
        assert.equal(styles.match(/\*\//gu)?.length, 1);
        assert.ok(styles.includes('[data-sc-class~="safe"]:where([data-sc-class~="mdict-yomitan-entry-0"], [data-sc-class~="mdict-yomitan-entry-0"] *){ color: red; }'));
    });

    test('external MDD styles remain dictionary-wide rather than entry-local', async () => {
        const mdx = makeMdictFixture([
            {key: 'Alpha', value: '<div class="shared">alpha</div>'},
            {key: 'Beta', value: '<div class="shared">beta</div>'},
        ]);
        const mdd = makeMdictFixture([
            {key: 'styles.css', value: new TextEncoder().encode('.shared { color: green; }')},
        ], {mdd: true});
        const result = await createMdxImportData('external-style-global.mdx', {}, mdx.bytes, [{name: 'external-style-global.mdd', bytes: mdd.bytes}]);
        const styles = new TextDecoder().decode(result.files.get('styles.css'));

        assert.match(styles, /\[data-sc-class~="shared"\]\{ color: green; \}/u);
        assert.doesNotMatch(styles, /mdict-yomitan-entry-/u);
    });
});

describe('MDict inline scope selector semantics', () => {
    test('entry scope guards the subject without changing selector specificity or losing functional roots', async () => {
        const fixture = makeInlineStyleScopeFixture();
        const result = await createMdxImportData('inline-semantic-scope.mdx', {}, fixture.bytes, []);
        const styles = new TextDecoder().decode(result.files.get('styles.css'));
        const root = '[data-sc-class~="mdict-yomitan-entry-0"]';
        const guard = `:where(${root}, ${root} *)`;
        assert.ok(styles.includes(`:is(${root}) > [data-sc-class~="functional"]${guard}`));
        assert.ok(styles.includes(`:where(${root}, ${root}) > [data-sc-class~="where-root"]${guard}`));
        assert.ok(styles.includes(`${root} [data-sc-class~="cascade"]${guard}`));
        assert.ok(styles.includes(`}[data-sc-class~="cascade"]${guard}`));
        assert.ok(styles.includes(`${root} + *${guard}`));
    });

    test('the containment guard precedes modern and legacy pseudo-elements inside conditional rules', async () => {
        const fixture = makeInlineStyleScopeFixture();
        const result = await createMdxImportData('inline-pseudo-scope.mdx', {}, fixture.bytes, []);
        const styles = new TextDecoder().decode(result.files.get('styles.css'));
        const root = '[data-sc-class~="mdict-yomitan-entry-0"]';
        const guard = `:where(${root}, ${root} *)`;
        assert.ok(styles.includes(`[data-sc-class~="shared"]${guard}::before`));
        assert.ok(styles.includes(`[data-sc-class~="shared"]${guard}:after`));
        assert.ok(styles.includes(`@media screen { [data-sc-class~="nested"]${guard}`));
    });
});

test('MDict inline scope ignores colon-like tokens inside attributes, escaped names and pseudo-class arguments', async () => {
    const rules = [
        String.raw`.literal\:before { color: red; }`,
        '.shared:is(.a, .b)::before { content: "x"; }',
        '.shared[data-label=":after"]::first-letter { color: red; }',
        '.shared:BEFORE { content: "y"; }',
    ];
    const fixture = makeMdictFixture([
        {key: 'Alpha', value: `<style>${rules.join('\n')}</style><div class="shared a literal:before">alpha</div>`},
    ]);
    const result = await createMdxImportData('inline-scope-tokens.mdx', {}, fixture.bytes, []);
    const styles = new TextDecoder().decode(result.files.get('styles.css'));
    const root = '[data-sc-class~="mdict-yomitan-entry-0"]';
    const guard = `:where(${root}, ${root} *)`;
    for (const selector of [
        `[data-sc-class~="literal:before"]${guard}`,
        `[data-sc-class~="shared"]:is([data-sc-class~="a"], [data-sc-class~="b"])${guard}::before`,
        `[data-sc-class~="shared"][data-label=":after"]${guard}::first-letter`,
        `[data-sc-class~="shared"]${guard}:BEFORE`,
    ]) {
        assert.ok(styles.includes(selector), selector);
    }
});

describe('MDict direct lookup key normalization', () => {
    test('lookup follows KeyCaseSensitive=No by default', () => {
        const fixture = makeMdictFixture([
            {key: 'Target', value: 'definition'},
        ], {keyCaseSensitive: 'No'});
        const mdx = new MDX('lookup-case.mdx', fixture.bytes);
        try {
            assert.equal(mdx.lookup('target').definition?.replace(/\0+$/u, ''), 'definition');
            assert.equal(mdx.strip('Target'), 'target');
        } finally {
            mdx.close();
        }
    });

    test('lookup follows KeyCaseSensitive=Yes by default', () => {
        const fixture = makeMdictFixture([
            {key: 'Target', value: 'definition'},
        ], {keyCaseSensitive: 'Yes'});
        const mdx = new MDX('lookup-case-sensitive.mdx', fixture.bytes);
        try {
            assert.equal(mdx.lookup('target').definition, null);
            assert.equal(mdx.lookup('Target').definition?.replace(/\0+$/u, ''), 'definition');
            assert.equal(mdx.strip('Target'), 'Target');
        } finally {
            mdx.close();
        }
    });

    test('explicit case-sensitivity options override the dictionary header', () => {
        const insensitiveFixture = makeMdictFixture([
            {key: 'Target', value: 'definition'},
        ], {keyCaseSensitive: 'No'});
        const forcedSensitive = new MDX('lookup-forced-sensitive.mdx', insensitiveFixture.bytes, {isCaseSensitive: true});
        try {
            assert.equal(forcedSensitive.lookup('target').definition, null);
            assert.equal(forcedSensitive.lookup('Target').definition?.replace(/\0+$/u, ''), 'definition');
        } finally {
            forcedSensitive.close();
        }

        const sensitiveFixture = makeMdictFixture([
            {key: 'Target', value: 'definition'},
        ], {keyCaseSensitive: 'Yes'});
        const forcedInsensitive = new MDX('lookup-forced-insensitive.mdx', sensitiveFixture.bytes, {isCaseSensitive: false});
        try {
            assert.equal(forcedInsensitive.lookup('target').definition?.replace(/\0+$/u, ''), 'definition');
        } finally {
            forcedInsensitive.close();
        }
    });

    test('StripKey controls punctuation normalization and can be overridden', () => {
        const fixture = makeMdictFixture([
            {key: 'foo-bar', value: 'definition'},
        ], {stripKey: 'Yes', keyCaseSensitive: 'No'});
        const mdx = new MDX('lookup-strip.mdx', fixture.bytes);
        try {
            assert.equal(mdx.lookup('foobar').definition?.replace(/\0+$/u, ''), 'definition');
        } finally {
            mdx.close();
        }

        const noStrip = new MDX('lookup-strip-override.mdx', fixture.bytes, {isStripKey: false});
        try {
            assert.equal(noStrip.lookup('foobar').definition, null);
            assert.equal(noStrip.lookup('foo-bar').definition?.replace(/\0+$/u, ''), 'definition');
        } finally {
            noStrip.close();
        }
    });

    test('case-insensitive prefix lookup uses normalized keys', () => {
        const fixture = makeMdictFixture([
            {key: 'Target', value: 'definition'},
        ], {keyCaseSensitive: 'No'});
        const mdx = new MDX('prefix-case.mdx', fixture.bytes);
        try {
            assert.deepEqual(mdx.prefix('ta').map(({keyText}) => keyText), ['Target']);
        } finally {
            mdx.close();
        }
    });
});

describe('MDict direct lookup range and lifetime regressions', () => {
    for (const keysPerBlock of [1, 2, 3]) {
        test(`prefix returns the complete normalized range with ${keysPerBlock} keys per block`, () => {
            const fixture = makeMdictFixture([
                {key: 'Target', value: 'target'},
                {key: 'Task', value: 'task'},
                {key: 'Taxi', value: 'taxi'},
                {key: 'Zoo', value: 'zoo'},
            ], {keysPerBlock, keyCaseSensitive: 'No'});
            const mdx = new MDX('prefix-range.mdx', fixture.bytes);
            try {
                assert.deepEqual(mdx.prefix('TA').map(({keyText}) => keyText), ['Target', 'Task', 'Taxi']);
                assert.deepEqual(mdx.prefix('TAX').map(({keyText}) => keyText), ['Taxi']);
                assert.deepEqual(mdx.prefix('missing'), []);
                assert.deepEqual(mdx.prefix('zzzz'), []);
                assert.deepEqual(mdx.prefix('').map(({keyText}) => keyText), ['Target', 'Task', 'Taxi', 'Zoo']);
            } finally {
                mdx.close();
            }
        });
    }

    test('exact spelling wins over a case-equivalent redirect record', () => {
        const fixture = makeMdictFixture([
            {key: 'Read', value: 'definition'},
            {key: 'read', value: '@@@LINK=Read'},
        ], {keyCaseSensitive: 'No', keysPerBlock: 1});
        const mdx = new MDX('exact-case-spelling.mdx', fixture.bytes);
        try {
            assert.equal(mdx.lookup('Read').definition, 'definition\0');
            assert.equal(mdx.lookup('read').definition, '@@@LINK=Read\0');
            assert.equal(mdx.lookup('READ').definition, 'definition\0');
            assert.deepEqual(mdx.prefix('read').map(({keyText}) => keyText), ['Read', 'read']);
        } finally {
            mdx.close();
        }
    });

    test('exact punctuation spelling wins in a StripKey-equivalent range', () => {
        const fixture = makeMdictFixture([
            {key: 'a-b', value: 'hyphen'},
            {key: 'ab', value: 'plain'},
        ], {stripKey: 'Yes', keysPerBlock: 1});
        const mdx = new MDX('exact-strip-spelling.mdx', fixture.bytes);
        try {
            assert.equal(mdx.lookup('a-b').definition, 'hyphen\0');
            assert.equal(mdx.lookup('ab').definition, 'plain\0');
            assert.deepEqual(mdx.prefix('a-').map(({keyText}) => keyText), ['a-b', 'ab']);
        } finally {
            mdx.close();
        }
    });

    test('case-sensitive matching does not use locale collation as key equality', () => {
        const fixture = makeMdictFixture([
            {key: '\u00e9', value: 'composed'},
        ], {keyCaseSensitive: 'Yes', stripKey: 'No'});
        const mdx = new MDX('exact-unicode-spelling.mdx', fixture.bytes);
        try {
            assert.equal(mdx.lookup('e\u0301').definition, null);
            assert.equal(mdx.lookup('\u00e9').definition, 'composed\0');
        } finally {
            mdx.close();
        }
    });

    test('prefix does not skip a composed-key match across a collation-equivalent key', () => {
        const fixture = makeMdictFixture([
            {key: '\u00e9', value: 'composed'},
            {key: 'e\u0301', value: 'decomposed'},
            {key: '\u00e9clair', value: 'longer'},
        ], {keyCaseSensitive: 'Yes', stripKey: 'No', keysPerBlock: 1});
        const mdx = new MDX('unicode-prefix-range.mdx', fixture.bytes);
        try {
            assert.deepEqual(mdx.prefix('\u00e9').map(({keyText}) => keyText), ['\u00e9', '\u00e9clair']);
            assert.deepEqual(mdx.prefix('e\u0301').map(({keyText}) => keyText), ['e\u0301']);
        } finally {
            mdx.close();
        }
    });

    test('the lookup-only index is lazy during record iteration and released by close', () => {
        const fixture = makeMdictFixture([{key: 'Target', value: 'definition'}]);
        const mdx = new MDX('lookup-index-lifetime.mdx', fixture.bytes);
        const getLookupIndex = () => mdx._lookupKeywordList;
        try {
            assert.equal(getLookupIndex(), null);
            for (const item of mdx.keywordList) {
                assert.equal(mdx.fetch_definition(item).definition, 'definition\0');
            }
            assert.equal(getLookupIndex(), null);
            assert.equal(mdx.lookup('Target').definition, 'definition\0');
            assert.equal(getLookupIndex()?.length, 1);
        } finally {
            mdx.close();
        }
        assert.equal(getLookupIndex(), null);
        assert.equal(mdx.lookupKeyBlockByWord('Target'), undefined);
        assert.equal(mdx.lookup('Target').definition, null);
        assert.deepEqual(mdx.prefix(''), []);
        mdx.close();
        assert.equal(getLookupIndex(), null);
    });

    test('MDD direct resource lookup prefers the exact case spelling', () => {
        const fixture = makeMdictFixture([
            {key: '\\Image.png', value: Uint8Array.of(1)},
            {key: '\\image.png', value: Uint8Array.of(2)},
        ], {mdd: true, keyCaseSensitive: 'No', keysPerBlock: 1});
        const mdd = new MDD('resource-exact-case.mdd', fixture.bytes);
        try {
            assert.equal(mdd.locate('\\Image.png').definition, 'AQ==');
            assert.equal(mdd.locate('\\image.png').definition, 'Ag==');
        } finally {
            mdd.close();
        }
    });
});

describe('MDict redirect StripKey matching', () => {
    for (const stripKey of /** @type {const} */ (['Yes', 'No'])) {
        test(`converter redirects honor StripKey=${stripKey}`, async () => {
            const fixture = makeMdictFixture([
                {key: 'Alias', value: '@@@LINK=foobar'},
                {key: 'foo-bar', value: 'definition'},
            ], {stripKey, keyCaseSensitive: 'No'});
            const result = await createMdxImportData('redirect-strip.mdx', {}, fixture.bytes, []);
            const terms = readRows(result.files).map(([term]) => term).sort();
            assert.deepEqual(terms, stripKey === 'Yes' ? ['Alias', 'foo-bar'] : ['foo-bar']);
            const details = result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details;
            assert.equal(details?.unresolvedRedirectCount, stripKey === 'Yes' ? 0 : 1);
        });
    }

    test('punctuation-normalized redirect chains retain every alias spelling', async () => {
        const fixture = makeMdictFixture([
            {key: 'Alias-One', value: '@@@LINK=mid_dle'},
            {key: 'Middle', value: '@@@LINK=FOOBAR'},
            {key: 'foo-bar', value: 'definition'},
            {key: 'foobar', value: '@@@LINK=foo-bar'},
        ], {stripKey: 'Yes', keyCaseSensitive: 'No'});
        const result = await createMdxImportData('redirect-strip-chain.mdx', {}, fixture.bytes, []);
        const terms = readRows(result.files).map(([term]) => term).sort();
        assert.deepEqual(terms, ['Alias-One', 'Middle', 'foo-bar', 'foobar']);
        const details = result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details;
        assert.equal(details?.unresolvedRedirectCount, 0);
    });

    test('StripKey does not disable case-sensitive matching or resolve disconnected cycles', async () => {
        const fixture = makeMdictFixture([
            {key: 'Alias', value: '@@@LINK=FooBar'},
            {key: 'WrongCase', value: '@@@LINK=foobar'},
            {key: 'Foo-Bar', value: 'definition'},
            {key: 'Cycle-One', value: '@@@LINK=CycleTwo'},
            {key: 'Cycle-Two', value: '@@@LINK=CycleOne'},
        ], {stripKey: 'Yes', keyCaseSensitive: 'Yes'});
        const result = await createMdxImportData('redirect-strip-sensitive.mdx', {}, fixture.bytes, []);
        assert.deepEqual(readRows(result.files).map(([term]) => term).sort(), ['Alias', 'Foo-Bar']);
        const details = result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details;
        assert.equal(details?.unresolvedRedirectCount, 3);
    });
});

describe('MDict redirects preserve exact target identity before normalization', () => {
    for (const [label, first, second, stripKey] of /** @type {const} */ ([
        ['case', 'Read', 'read', 'No'],
        ['punctuation', 'co-op', 'coop', 'Yes'],
    ])) {
        test(`${label}: exact aliases and their chains do not acquire a different definition`, async () => {
            const fixture = makeMdictFixture([
                {key: first, value: 'first meaning'},
                {key: first, value: 'second sense of first'},
                {key: second, value: 'other spelling meaning'},
                {key: 'FirstAlias', value: `@@@LINK=${first}`},
                {key: 'SecondAlias', value: `@@@LINK=${second}`},
                {key: 'FirstChain', value: '@@@LINK=FirstAlias'},
            ], {keyCaseSensitive: 'No', stripKey, keysPerBlock: 1, recordBlockSize: 7});
            const {files} = await createMdxImportData('exact-redirect.mdx', {}, fixture.bytes, []);
            const rows = readRows(files);
            for (const alias of ['FirstAlias', 'FirstChain']) {
                const definitions = rows.filter(([term]) => term === alias);
                assert.equal(definitions.length, 2, alias);
                assert.match(JSON.stringify(definitions), /first meaning/u);
                assert.match(JSON.stringify(definitions), /second sense of first/u);
                assert.doesNotMatch(JSON.stringify(definitions), /other spelling meaning/u);
            }
            const other = rows.filter(([term]) => term === 'SecondAlias');
            assert.equal(other.length, 1);
            assert.match(JSON.stringify(other), /other spelling meaning/u);
        });
    }

    test('exact case-variant alias chains do not collapse onto unrelated definitions', async () => {
        const fixture = makeMdictFixture([
            {key: 'Top', value: 'top meaning'},
            {key: 'Bottom', value: 'bottom meaning'},
            {key: 'Read', value: '@@@LINK=Top'},
            {key: 'read', value: '@@@LINK=Bottom'},
            {key: 'ViaUpper', value: '@@@LINK=Read'},
            {key: 'ViaLower', value: '@@@LINK=read'},
        ], {keyCaseSensitive: 'No', keysPerBlock: 1});
        const {files} = await createMdxImportData('exact-alias-chain.mdx', {}, fixture.bytes, []);
        const rows = readRows(files);
        for (const [alias, meaning] of [['ViaUpper', 'top meaning'], ['ViaLower', 'bottom meaning']]) {
            const definitions = rows.filter(([term]) => term === alias);
            assert.equal(definitions.length, 1, alias);
            assert.ok(JSON.stringify(definitions).includes(meaning));
        }
    });

    test('an exact cyclic target is not rescued by a different case-variant definition', async () => {
        const fixture = makeMdictFixture([
            {key: 'Read', value: 'real meaning'},
            {key: 'read', value: '@@@LINK=Loop'},
            {key: 'Loop', value: '@@@LINK=read'},
            {key: 'Alias', value: '@@@LINK=read'},
        ], {keyCaseSensitive: 'No'});
        const {files, phaseTimings} = await createMdxImportData('exact-cycle.mdx', {}, fixture.bytes, []);
        assert.deepEqual(readRows(files).map(([term]) => term), ['Read']);
        const phase = phaseTimings.find(({details}) => typeof details?.unresolvedRedirectCount === 'number');
        assert.equal(phase?.details?.unresolvedRedirectCount, 3);
    });

    test('a self redirect without a readable homograph is counted as unresolved', async () => {
        const fixture = makeMdictFixture([
            {key: 'Root', value: 'root definition'},
            {key: 'Self', value: '@@@LINK=Self'},
        ]);
        const {phaseTimings} = await createMdxImportData('self-cycle.mdx', {}, fixture.bytes, []);
        const phase = phaseTimings.find(({details}) => typeof details?.unresolvedRedirectCount === 'number');
        assert.equal(phase?.details?.unresolvedRedirectCount, 1);
    });

    test('missing exact spellings still fall back to normalized definitions and preserve all senses', async () => {
        const fixture = makeMdictFixture([
            {key: 'Read', value: 'first meaning'},
            {key: 'Read', value: 'second meaning'},
            {key: 'Fallback', value: '@@@LINK=rE-aD'},
            {key: 'Chain', value: '@@@LINK=fALLBACK'},
        ], {keyCaseSensitive: 'No', stripKey: 'Yes'});
        const {files, phaseTimings} = await createMdxImportData('fallback.mdx', {}, fixture.bytes, []);
        const rows = readRows(files);
        for (const alias of ['Fallback', 'Chain']) {
            assert.equal(rows.filter(([term]) => term === alias).length, 2);
        }
        const phase = phaseTimings.find(({details}) => typeof details?.unresolvedRedirectCount === 'number');
        assert.equal(phase?.details?.unresolvedRedirectCount, 0);
    });
});


describe('MDict redirect resolution agrees with a forward graph model', () => {
    for (const keyCaseSensitive of /** @type {const} */ (['Yes', 'No'])) {
        for (const stripKey of /** @type {const} */ (['Yes', 'No'])) {
            for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
                test(`${keyCaseSensitive}/${stripKey}/${compression}: exact names, fallback, homographs and cycles`, async () => {
                    for (let seed = 1; seed <= 16; ++seed) {
                        let state = seed;
                        const random = () => {
                            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                            return state;
                        };
                        const keys = ['Read', 'read', 'co-op', 'coop', 'Middle', 'middle', 'Leaf', '\u00e9', 'e\u0301'];
                        const targetPool = [...keys, 'READ', 'CO_OP', 'MIDDLE', 'lE-aF', 'missing'];
                        /** @type {Array<{key: string, value: string}>} */
                        const entries = [];
                        for (const [index, key] of keys.entries()) {
                            const value = index === 0 || random() % 4 === 0 ?
                                `model-sense-${entries.length}` :
                                `@@@LINK=${targetPool[random() % targetPool.length]}`;
                            entries.push({key, value});
                            if (random() % 3 === 0) {
                                entries.push({key, value: `model-sense-${entries.length}`});
                            }
                        }
                        // This independent forward traversal does not use the
                        // converter's reverse edges or its key-normalizer helper.
                        const normalize = (/** @type {string} */ key) => {
                            if (stripKey === 'Yes') { key = key.replace(/[-_]/gu, ''); }
                            return keyCaseSensitive === 'Yes' ? key : key.toLowerCase();
                        };
                        const targets = (/** @type {string} */ target) => {
                            if (keys.includes(target)) { return [target]; }
                            return keys.filter((key) => normalize(key) === normalize(target));
                        };
                        const resolve = (/** @type {string[]} */ starts) => {
                            const pending = [...starts];
                            const visited = new Set();
                            /** @type {Set<string>} */
                            const senses = new Set();
                            for (let index = 0; index < pending.length; ++index) {
                                const key = pending[index];
                                if (visited.has(key)) { continue; }
                                visited.add(key);
                                for (const entry of entries) {
                                    if (entry.key !== key) { continue; }
                                    if (entry.value.startsWith('@@@LINK=')) {
                                        for (const target of targets(entry.value.slice(8))) { pending.push(target); }
                                    } else {
                                        senses.add(entry.value);
                                    }
                                }
                            }
                            return senses;
                        };
                        const expected = keys.flatMap((key) => [...resolve([key])].map((sense) => JSON.stringify([key, sense]))).sort();
                        const unresolvedEdges = new Set(entries.filter(({value}) => value.startsWith('@@@LINK=') &&
                        resolve(targets(value.slice(8))).size === 0).map(({key, value}) => JSON.stringify([key, value])));
                        const fixture = makeMdictFixture(entries, {
                            keyCaseSensitive, stripKey, compression, keysPerBlock: seed % 3 + 1, recordBlockSize: 7,
                        });
                        const {files, phaseTimings} = await createMdxImportData('redirect-model.mdx', {}, fixture.bytes, []);
                        const actual = readRows(files).map((row) => {
                            const senses = JSON.stringify(row[5]).match(/model-sense-\d+/gu);
                            assert.equal(senses?.length, 1, `seed ${seed}: one original sense per row`);
                            return JSON.stringify([row[0], senses?.[0]]);
                        }).sort();
                        assert.deepEqual(actual, expected, `seed ${seed}: term-to-sense identity`);
                        const phase = phaseTimings.find(({details}) => typeof details?.unresolvedRedirectCount === 'number');
                        assert.equal(phase?.details?.unresolvedRedirectCount, unresolvedEdges.size, `seed ${seed}: unresolved edges`);
                    }
                });
            }
        }
    }
});


describe('actual binary MDX/MDD conversion', () => {
    test('preserves homograph senses, multi-hop aliases, bank bounds and diagnostics', async () => {
        const fixture = makeMdictFixture([
            {key: 'AliasA', value: '@@@LINK=AliasB'},
            {key: 'AliasB', value: '@@@LINK=Target'},
            {key: 'Target', value: '<div>first sense</div>'},
            {key: 'Target', value: '<div>second sense</div>'},
            {key: 'Orphan', value: '@@@LINK=Missing'},
            {key: 'CycleA', value: '@@@LINK=CycleB'},
            {key: 'CycleB', value: '@@@LINK=CycleA'},
        ], {recordBlockSize: 7, keysPerBlock: 1});
        const result = await createMdxImportData('aliases.mdx', {termBankSize: 2}, fixture.bytes, []);
        const rows = readRows(result.files);
        assert.equal(rows.length, 6);
        for (const expression of ['Target', 'AliasA', 'AliasB']) {
            const matching = rows.filter(([term]) => term === expression);
            assert.equal(matching.length, 2);
            assert.equal(new Set(matching.map((row) => JSON.stringify(row[5]))).size, 2);
        }
        for (const [path, bytes] of result.files) {
            if (/^term_bank_\d+\.json$/u.test(path)) {
                assert.ok(JSON.parse(new TextDecoder().decode(bytes)).length <= 2);
            }
        }
        assert.equal(result.phaseTimings.find(({phase}) => phase === 'prepare-mdx:encode-banks')?.details?.unresolvedRedirectCount, 3);
    });

    test('distinct embedded images in distinct entries retain their own bytes', async () => {
        const red = makeFixturePng([255, 0, 0, 255]);
        const blue = makeFixturePng([0, 0, 255, 255]);
        const fixture = makeMdictFixture([
            {key: 'Red', value: `<img src="data:image/png;base64,${Buffer.from(red).toString('base64')}" alt="red">`},
            {key: 'Blue', value: `<img src="data:image/png;base64,${Buffer.from(blue).toString('base64')}" alt="blue">`},
        ], {recordBlockSize: 13});
        const {files} = await createMdxImportData('images.mdx', {}, fixture.bytes, []);
        const rows = readRows(files);
        const redImage = nodes(rows.find(([term]) => term === 'Red')?.[5], 'img')[0];
        const blueImage = nodes(rows.find(([term]) => term === 'Blue')?.[5], 'img')[0];
        assert.ok(redImage?.path);
        assert.ok(blueImage?.path);
        assert.notEqual(redImage.path, blueImage.path);
        assert.deepEqual(files.get(redImage.path), red);
        assert.deepEqual(files.get(blueImage.path), blue);
    });

    test('bare CSS URLs resolve against the MDD stylesheet directory', async () => {
        const png = makeFixturePng([10, 200, 30, 255]);
        const mdx = makeMdictFixture([{key: 'Styled', value: '<div class="entry">styled definition</div>'}]);
        const mdd = makeMdictFixture([
            {key: '\\styles\\theme.css', value: '.entry { background-image: url(images/猫.png) }'},
            {key: '\\styles\\images\\猫.png', value: png},
        ], {mdd: true, recordBlockSize: 17});
        const {files} = await createMdxImportData('styled.mdx', {}, mdx.bytes, [{name: 'styled.MDD', bytes: mdd.bytes}]);
        assert.ok(new TextDecoder().decode(files.get('styles.css')).includes('mdict-media/styles/images/猫.png'));
        assert.deepEqual(files.get('mdict-media/styles/images/猫.png'), png);
    });

    test('URI-encoded entry links search for the decoded headword', async () => {
        const fixture = makeMdictFixture([{key: 'link', value: '<a href="entry://%E7%8C%AB%26%E7%8A%AC">animals</a>'}]);
        const {files} = await createMdxImportData('links.mdx', {}, fixture.bytes, []);
        const link = nodes(readRows(files)[0][5], 'a')[0];
        assert.equal(link?.href, '?query=%E7%8C%AB%26%E7%8A%AC');
        assert.equal(new URLSearchParams(link.href.slice(1)).get('query'), '猫&犬');
    });
});

describe('native parser controls and key metadata', () => {
    for (const compression of /** @type {const} */ (['raw', 'zlib'])) {
        test(`${compression} single-block control and owned output`, () => {
            const fixture = makeMdictFixture([{key: 'control', value: 'unchanged control definition'}], {compression, recordBlockSize: 4096});
            const mdx = new MDX('control.mdx', fixture.bytes, {recordBlockCacheBytes: 4096});
            try {
                const first = mdx.lookupRecordByKeyBlock(mdx.keywordList[0]);
                assert.deepEqual(first, fixture.records[0]);
                first.fill(0);
                assert.deepEqual(mdx.lookupRecordByKeyBlock(mdx.keywordList[0]), fixture.records[0]);
            } finally {
                mdx.close();
            }
        });
    }

    for (const version of ['1.2', '2.1']) {
        for (const encoding of /** @type {const} */ (['utf8', 'utf16le'])) {
            test(`${version}/${encoding} numeric and key-info layout`, () => {
                const fixture = makeMdictFixture([{key: '猫', value: 'versioned definition'}], {version, encoding, recordBlockSize: 5});
                const mdx = new MDX('version.mdx', fixture.bytes);
                try {
                    assert.equal(mdx.keywordList[0].keyText, '猫');
                    assert.deepEqual(mdx.lookupRecordByKeyBlock(mdx.keywordList[0]), fixture.records[0]);
                } finally {
                    mdx.close();
                }
            });
        }
    }

    test('key-block advertised decoded length must match bytes', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'definition'}], {keyBlockUnpackSizeDelta: 1});
        assert.throws(() => new MDX('key-length.mdx', fixture.bytes), /key.*size/iu);
    });

    test('key-info text must have its declared terminator', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'definition'}], {keyInfoTerminatorByte: 1});
        assert.throws(() => new MDX('key-terminator.mdx', fixture.bytes), /terminator/iu);
    });

    test('per-block entry counts are enforced even when their sum is correct', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'first'}, {key: 'b', value: 'second'}], {keysPerBlock: 1, keyBlockEntryCounts: [2, 0]});
        assert.throws(() => new MDX('key-counts.mdx', fixture.bytes), /key.*entr/iu);
    });

    test('key-info entry totals must equal the header', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'definition'}], {keyBlockEntryCounts: [2]});
        assert.throws(() => new MDX('key-total.mdx', fixture.bytes), /key.*entr/iu);
    });

    test('trailing key-info bytes are not silently discarded', () => {
        const fixture = makeMdictFixture([{key: 'a', value: 'definition'}], {keyInfoTrailer: Uint8Array.of(1, 2)});
        assert.throws(() => new MDX('key-trailer.mdx', fixture.bytes), /key.*info/iu);
    });

    test('scanner rejects invalid sources and releases its input on close', () => {
        assert.throws(() => new FileScanner(/** @type {any} */ ({})), TypeError);
        const scanner = new FileScanner(Uint8Array.of(1, 2, 3));
        assert.deepEqual(scanner.readBuffer(0, 2), Uint8Array.of(1, 2));
        scanner.close();
        assert.deepEqual(scanner.readBuffer(0, 0), new Uint8Array(0));
        assert.throws(() => scanner.readBuffer(0, 1), /available file data/iu);
        assert.throws(() => scanner.readBuffer(/** @type {any} */ ('0'), 0), /available file data/iu);
    });
});


describe('MDict header XML attribute syntax', () => {
    for (const version of ['1.2', '2.0']) {
        for (const headerQuote of /** @type {const} */ (['"', "'"])) {
            for (const spacedHeaderAttributes of [false, true]) {
                test(`${version}/${headerQuote}/${spacedHeaderAttributes} XML attribute syntax preserves imports`, async () => {
                    const title = 'Header "double" and \'single\' & XML';
                    const fixture = makeMdictFixture([{key: 'word', value: '<p>complete definition</p>'}], {
                        version, headerQuote, spacedHeaderAttributes, title,
                    });
                    const {files} = await createMdxImportData('xml-header.mdx', {}, fixture.bytes, []);
                    const index = JSON.parse(new TextDecoder().decode(files.get('index.json')));
                    assert.equal(index.title, title);
                    const rows = readRows(files);
                    assert.equal(rows.length, 1);
                    assert.equal(rows[0][0], 'word');
                    assert.ok(JSON.stringify(rows[0][5]).includes('complete definition'));
                });
            }
        }
    }

    test('header attributes retain opposite quotes and XML attribute-name boundaries', () => {
        const parsed = /** @type {Record<string, string>} */ (mdictCommon.parseHeader('<Dictionary Description=\'Literal Encoding="UTF-16"\' Encoding="UTF-8" x:Encrypted="3" data-StripKey="No"/>'));
        assert.equal(parsed.Description, 'Literal Encoding="UTF-16"');
        assert.equal(parsed.Encoding, 'UTF-8');
        assert.equal(parsed['x:Encrypted'], '3');
        assert.equal(parsed['data-StripKey'], 'No');
        assert.equal(Object.hasOwn(parsed, 'Encrypted'), false);
        assert.equal(Object.hasOwn(parsed, 'StripKey'), false);
    });

    test('large valid header attributes do not overflow the regex stack', () => {
        const description = 'definition &amp; text\n'.repeat(50000);
        const parsed = /** @type {Record<string, string>} */ (mdictCommon.parseHeader(`<Dictionary Description="${description}" Encoding="UTF-8"/>`));
        assert.equal(parsed.Description, 'definition & text\n'.repeat(50000));
        assert.equal(parsed.Encoding, 'UTF-8');
    });
});

describe('MDict header encoding and encryption metadata', () => {
    for (const version of ['1.2', '2.0']) {
        for (const encodingLabel of ['unicode', 'ucs-2', 'utf-16be', 'unicodefffe']) {
            test(`${version}/${encodingLabel} preserves two-byte keys and complete imported definitions`, async () => {
                const bigEndian = encodingLabel === 'utf-16be' || encodingLabel === 'unicodefffe';
                const entries = [
                    {key: 'apple', value: '<p>ASCII and \u732b</p>'},
                    {key: '\u732b', value: '<p>\u306d\u3053 \ud83d\ude00</p>'},
                ];
                const fixture = makeMdictFixture(entries, {
                    version,
                    encoding: 'utf16le',
                    encodingLabel,
                    textEncoder: (value) => {
                        const bytes = Buffer.from(value, 'utf16le');
                        return bigEndian ? bytes.swap16() : bytes;
                    },
                    keysPerBlock: 1,
                    recordBlockSize: 7,
                });
                const mdx = new MDX('utf16-alias.mdx', fixture.bytes);
                try {
                    for (const {key, value} of entries) {
                        assert.equal(mdx.lookup(key).definition, `${value}\0`);
                    }
                } finally {
                    mdx.close();
                }
                const {files} = await createMdxImportData('utf16-alias.mdx', {}, fixture.bytes, []);
                const rows = readRows(files);
                assert.deepEqual(rows.map((row) => row[0]).sort(), entries.map(({key}) => key).sort());
                for (const {key, value} of entries) {
                    const row = rows.find((item) => item[0] === key);
                    assert.ok(row);
                    assert.ok(JSON.stringify(row[5]).includes(value.slice(3, -4)));
                }
            });
        }
    }


    const gb18030Bytes = new Map([
        ['😀', '9439fc36'],
        ['<p>定义😀</p>', '3c703eb6a8d2e59439fc363c2f703e'],
        ['猫', 'c3a8'],
        ['<p>定义</p>', '3c703eb6a8d2e53c2f703e'],
    ]);
    /**
     * @param {string} value
     * @returns {Uint8Array}
     */
    const encodeGb18030 = (value) => {
        const hex = gb18030Bytes.get(value);
        if (typeof hex === 'undefined') { throw new Error(`Missing GB18030 test vector for ${value}`); }
        return new Uint8Array(Buffer.from(hex, 'hex'));
    };

    test('explicit GB18030 preserves four-byte keys and definitions', () => {
        const definition = '<p>定义😀</p>';
        const fixture = makeMdictFixture([{key: '😀', value: definition}], {
            encodingLabel: 'GB18030',
            textEncoder: encodeGb18030,
        });
        const mdx = new MDX('gb18030.mdx', fixture.bytes);
        try {
            assert.equal(mdx.keywordList[0]?.keyText, '😀');
            assert.equal(mdx.lookup('😀').definition, `${definition}\0`);
        } finally {
            mdx.close();
        }
    });

    for (const encodingLabel of ['gbk', 'gB2312']) {
        test(`${encodingLabel} header alias uses GB18030-compatible decoding`, () => {
            const definition = '<p>定义</p>';
            const fixture = makeMdictFixture([{key: '猫', value: definition}], {
                encodingLabel,
                textEncoder: encodeGb18030,
            });
            const mdx = new MDX('gb-alias.mdx', fixture.bytes);
            try {
                assert.equal(mdx.keywordList[0]?.keyText, '猫');
                assert.equal(mdx.lookup('猫').definition, `${definition}\0`);
            } finally {
                mdx.close();
            }
        });
    }

    test('unsupported encoding labels are rejected instead of silently decoded as UTF-8', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'definition'}], {encodingLabel: 'x-mdict-unknown'});
        assert.throws(() => new MDX('unknown-encoding.mdx', fixture.bytes), /unsupported mdict encoding/iu);
    });

    for (const encrypted of ['bogus', '4', '-1']) {
        test(`invalid encryption metadata ${encrypted} is rejected`, () => {
            const fixture = makeMdictFixture([{key: 'entry', value: 'definition'}], {encrypted});
            assert.throws(() => new MDX('invalid-encryption.mdx', fixture.bytes), /encryption flag/iu);
        });
    }

    test('encryptType zero explicitly overrides an encrypted header', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'definition'}], {encrypted: 1});
        const mdx = new MDX('override-encryption.mdx', fixture.bytes, {encryptType: 0});
        try {
            assert.equal(mdx.lookup('entry').definition, 'definition\0');
        } finally {
            mdx.close();
        }
    });

    test('invalid encryption overrides are rejected', () => {
        const fixture = makeMdictFixture([{key: 'entry', value: 'definition'}]);
        assert.throws(() => new MDX('invalid-override.mdx', fixture.bytes, {encryptType: 4}), /encryption override/iu);
    });
});


describe('MDict text format and compact styles', () => {
    test('Format=Text preserves literal markup, whitespace and line breaks', async () => {
        const definition = '  <b>literal & text</b>\nsecond  ';
        const fixture = makeMdictFixture([{key: 'plain', value: definition}], {format: 'Text'});
        const {files} = await createMdxImportData('plain.mdx', {}, fixture.bytes, []);
        const glossary = readRows(files)[0][5];
        const preformatted = nodes(glossary, 'div').find(({style}) => style?.whiteSpace === 'pre-wrap');
        assert.ok(preformatted);
        assert.deepEqual(preformatted.content, [definition]);
        assert.equal(nodes(glossary, 'span').some(({style}) => style?.fontWeight === 'bold'), false);
    });

    test('compact stylesheet markers preserve prefix and expand known styles', async () => {
        const fixture = makeMdictFixture(
            [{key: 'styled', value: 'prefix `1`bold'}],
            {format: 'Html', styleSheet: '1\r\n<strong>\r\n</strong>'},
        );
        const {files} = await createMdxImportData('compact.mdx', {}, fixture.bytes, []);
        const glossary = readRows(files)[0][5];
        assert.ok(JSON.stringify(glossary).includes('prefix '));
        const bold = nodes(glossary, 'span').find(({style}) => style?.fontWeight === 'bold');
        assert.ok(bold);
        assert.deepEqual(bold.content, ['bold']);
    });

    test('unknown compact style markers remain visible with their content', async () => {
        const fixture = makeMdictFixture(
            [{key: 'styled', value: 'prefix `99`visible'}],
            {format: 'Html', styleSheet: '1\n<strong>\n</strong>'},
        );
        const {files} = await createMdxImportData('unknown-style.mdx', {}, fixture.bytes, []);
        assert.ok(JSON.stringify(readRows(files)[0][5]).includes('`99`visible'));
    });

    test('stylesheet parser preserves empty fields and numeric XML newlines', () => {
        const parsed = /** @type {{StyleSheet?: Record<string, string[]>}} */ (mdictCommon.parseHeader(
            '<Dictionary StyleSheet="1&#13;&#10;&lt;strong&gt;&#13;&#10;&lt;/strong&gt;&#13;&#10;2&#13;&#10;&lt;em&gt;&#13;&#10;"/>',
        ));
        assert.deepEqual(parsed.StyleSheet, {
            1: ['<strong>', '</strong>'],
            2: ['<em>', ''],
        });
    });
});

// Attribute values and CSS escape terminators are not selector whitespace.
describe('MDict selector literal preservation', () => {
    const rules = [
        '[title="two  gaps"] { color: rgb(12, 34, 56); }',
        '[title="tab\tgap"] { color: rgb(23, 45, 67); }',
        String.raw`[title="line\a  break"] { color: rgb(34, 56, 78); }`,
        ':is([title="two  gaps"]) { font-weight: 700; }',
    ].join('\n');
    for (const context of ['inline', 'conditional', 'external']) {
        test(`preserves literal whitespace in ${context} selectors`, async () => {
            const css = context === 'conditional' ? `@media screen { ${rules} }` : rules;
            const external = context === 'external';
            const mdx = makeMdictFixture([{key: 'Literal', value: `${external ? '' : `<style>${css}</style>`}<span title="two  gaps">literal</span>`}]);
            const sources = external ? [{name: 'literals.mdd', bytes: makeMdictFixture([{key: '\\style.css', value: new TextEncoder().encode(css)}], {mdd: true}).bytes}] : [];
            const result = await createMdxImportData('literals.mdx', {}, mdx.bytes, sources);
            const styles = new TextDecoder().decode(result.files.get('styles.css'));
            assert.ok(styles.includes('[title="two  gaps"]'));
            assert.ok(styles.includes('[title="tab\tgap"]'));
            assert.ok(styles.includes(String.raw`[title="line\a  break"]`));
            assert.ok(styles.includes(':is([title="two  gaps"])'));
        });
    }
});
