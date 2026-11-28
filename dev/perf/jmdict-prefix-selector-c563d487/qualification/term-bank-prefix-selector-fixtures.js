/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** @typedef {{score?: string, sequence?: string, definitionTags?: string, rules?: string, termTags?: string, gloss?: string}} Fields */
/** @typedef {{name: string, banks: string[], baselineReuses: number, selectorReuses: number, equals?: number[]}} ValidCase */
/** @typedef {{name: string, banks: string[]}} MalformedCase */

export const sharedGlossary = '[{"type":"text","text":"  shared text  "},{"type":"image","path":"image.png"}]';

/**
 * @param {Fields} [fields]
 * @returns {string}
 */
export function body({score = '-5', sequence = '17', definitionTags = '"noun"', rules = '""', termTags = '"common"', gloss = sharedGlossary} = {}) {
    return `${definitionTags},${rules},${score},${gloss},${sequence},${termTags}`;
}

/**
 * @param {string} expression
 * @param {Fields} [fields]
 * @param {string} [reading]
 * @returns {string}
 */
export function rawRow(expression, fields = {}, reading = '""') {
    return `[${expression},${reading},${body(fields)}]`;
}

/**
 * @param {string} expression
 * @param {Fields} [fields]
 * @param {string} [reading]
 * @returns {string}
 */
export function row(expression, fields = {}, reading = '""') {
    return rawRow(JSON.stringify(expression), fields, reading);
}

/**
 * @param {...string} rows
 * @returns {string}
 */
export function bank(...rows) { return `[${rows.join(',')}]`; }

/**
 * Raw JSON glossary of exactly length ASCII bytes.
 * @param {number} length
 * @returns {string}
 */
function glossaryOfLength(length) { return JSON.stringify(['x'.repeat(length - 4)]); }

/**
 * @param {string} text
 * @param {number} offset
 * @returns {string}
 */
function changedAt(text, offset) { return `${text.slice(0, offset)}y${text.slice(offset + 1)}`; }

const longGlossary = glossaryOfLength(1200);
const unsampledLateGlossary = changedAt(longGlossary, 1171);
const longMediaGlossary = JSON.stringify([{type: 'text', text: ' '.repeat(12) + 'x'.repeat(1100)}, {type: 'image', path: 'large.png'}]);
const smallA = '["small A"]';
const smallB = '["small B"]';
const smallC = '["small C"]';
const prefixP = {definitionTags: '"alpha"', rules: '"v5a"'};
const prefixQ = {definitionTags: '"other"', rules: '"v1"'};
const longOlder = row('older', {...prefixP, gloss: longGlossary});
const shortMiddle = row('same', {...prefixQ, gloss: smallB});
const oldFourRowPolicy = [
    ...Array.from({length: 6}, (_, i) => row(`initial-${i}`, {gloss: smallA})),
    ...Array.from({length: 4}, (_, i) => row(`miss-${i}`, {gloss: JSON.stringify([`miss-${i}`])})),
    ...Array.from({length: 6}, (_, i) => row(`late-${i}`, {gloss: smallB})),
];

/** @type {ValidCase[]} */
export const validCases = [
    {
        name: 'unique short keys and glossaries',
        banks: [bank(...Array.from({length: 12}, (_, i) => row(`key-${i}`, {gloss: JSON.stringify([`definition-${i}`])})))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'common-prefix unique keys and glossaries',
        banks: [bank(...Array.from({length: 12}, (_, i) => row(`common-prefix-key-${i}`, {gloss: JSON.stringify([`${'x'.repeat(200)}-${i}`])})))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'same short key with distinct unsampled glossary bytes',
        banks: [bank(...Array.from({length: 8}, (_, i) => row('same', {gloss: JSON.stringify([`${'x'.repeat(17)}${i}${'x'.repeat(220)}`])})))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'isolated exact short glossary preserves every hint',
        banks: [bank(row('same'), row('same', {score: '3', sequence: '-1'}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'isolated proof does not seed the old probe budget',
        banks: [bank(row('same', {termTags: '"first"'}), row('same', {termTags: '"second"'}), row('other', {termTags: '"third"'}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'four full-content hits still admit the original probe policy',
        banks: [bank(...['same', 'same', 'third', 'fourth', 'fifth', 'sixth'].map((key) => row(key)))],
        baselineReuses: 1, selectorReuses: 1,
    },
    {
        name: 'first prefix candidate fails even when an older candidate would succeed',
        banks: [bank(row('older', {gloss: smallA}), row('same', {gloss: smallB}), row('same', {gloss: smallA}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'older selected glossary can exceed the immediate 511-byte bound',
        banks: [bank(longOlder, shortMiddle), bank(row('same', {...prefixP, gloss: longGlossary, score: '42', sequence: '99', termTags: '"different"'}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'older long glossary rejects a late unsampled mismatch',
        banks: [bank(longOlder, shortMiddle), bank(row('same', {...prefixP, gloss: unsampledLateGlossary}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'older long glossary carries media and normalization hints',
        banks: [bank(row('older', {...prefixP, gloss: longMediaGlossary}), shortMiddle), bank(row('same', {...prefixP, gloss: longMediaGlossary}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'selected extent beyond current bank falls back to its short glossary',
        banks: [bank(longOlder, shortMiddle), bank(row('same', {...prefixP, gloss: smallA}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'selected bounds failure cannot retry an older exact candidate',
        banks: [bank(row('first', {...prefixP, gloss: smallA}), row('second', {...prefixP, gloss: longGlossary}), row('same', {...prefixQ, gloss: smallC})),
            bank(row('same', {...prefixP, gloss: smallA})), bank(row('following', {...prefixQ, gloss: longGlossary}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'definition-tag prefix collision still requires complete content equality',
        banks: [bank(row('same', {definitionTags: '"abcX"'}), row('same', {definitionTags: '"abcY"'}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'rule prefix collision still requires complete content equality',
        banks: [bank(row('same', {rules: '"abcX"'}), row('same', {rules: '"abcY"'}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'equal glossary still requires complete term tags',
        banks: [bank(row('same', {termTags: '"abcX"'}), row('same', {termTags: '"abcY"'}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'prefix collision does not authorize unequal glossary bytes',
        banks: [bank(row('same', {definitionTags: '"abcX"', gloss: smallA}), row('same', {definitionTags: '"abcY"', gloss: smallB}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'different tag lengths reject a prefix candidate',
        banks: [bank(row('same', {definitionTags: '"abcd"'}), row('same', {definitionTags: '"abcde"'}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'different rule lengths reject a prefix candidate',
        banks: [bank(row('same', {rules: '"abcd"'}), row('same', {rules: '"abcde"'}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'nullable definition tags use their raw prefix',
        banks: [bank(row('same', {definitionTags: 'null', sequence: 'null'}), row('same', {definitionTags: 'null', sequence: '5'}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'null and equally long string tags are different prefixes',
        banks: [bank(row('same', {definitionTags: 'null'}), row('same', {definitionTags: '"xx"'}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'one-byte tag body uses the bounded raw signature',
        banks: [bank(row('same', {definitionTags: '"a"', rules: '"b"'}), row('same', {definitionTags: '"a"', rules: '"b"'}))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'raw reading equal to current expression cannot provide a skipped comparison',
        banks: [bank(row('other', {}, '"same"'), row('same', {}, '"same"'))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'empty current reading cannot provide a skipped comparison',
        banks: [bank(row('other'), row('same'))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'eligible non-alias reading identity admits the selector',
        banks: [bank(row('older', {}, '"reading"'), row('later', {}, '"reading"'))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'expression identity admits despite a different explicit reading',
        banks: [bank(row('same', {}, '"first"'), row('same', {}, '"other"'))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'literal and escaped expressions cannot manufacture raw identity',
        banks: [bank(rawRow('"a"'), rawRow('"\\u0061"'))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'escaped and literal readings keep their original raw equality flags',
        banks: [bank(rawRow('"\\u0061"', {}, '"a"'), rawRow('"a"', {}, '"a"'), rawRow('"a"', {}, '"\\u0061"'))],
        equals: [0, 1, 0], baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'identical escaped keys can reuse validated adjacent interned keys',
        banks: [bank(rawRow('"\\u0061"', {}, '"a"'), rawRow('"\\u0061"', {}, '"a"'))],
        equals: [0, 0], baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'repeated lone-surrogate escapes retain replacement bytes and raw reading flags',
        banks: [bank(rawRow('"\\ud800"', {}, '"�"'), rawRow('"\\ud800"', {}, '"�"'))],
        equals: [0, 0], baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'paired surrogate escapes retain raw reading equality and decoded key bytes',
        banks: [bank(rawRow('"\\ud83d\\ude00"', {}, '"😀"'), rawRow('"\\ud83d\\ude00"', {}, '"\\ud83d\\ude00"'))],
        equals: [0, 1], baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'utf8 key boundary counts raw bytes',
        banks: [bank(row(`${'あ'.repeat(10)}ab`), row(`${'あ'.repeat(10)}ab`))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'utf8 key above the raw byte bound cannot admit',
        banks: [bank(row('あ'.repeat(11)), row('あ'.repeat(11)))],
        baselineReuses: 0, selectorReuses: 0,
    },
    ...[31, 32, 33].flatMap((length) => [
        {
            name: `literal expression raw body length ${length}`,
            banks: [bank(row('x'.repeat(length)), row('x'.repeat(length)))],
            baselineReuses: 0, selectorReuses: length <= 32 ? 1 : 0,
        },
        {
            name: `explicit reading raw body length ${length}`,
            banks: [bank(row('first', {}, JSON.stringify('x'.repeat(length))), row('other', {}, JSON.stringify('x'.repeat(length))))],
            baselineReuses: 0, selectorReuses: length <= 32 ? 1 : 0,
        },
        {
            name: `escaped expression raw body length ${length}`,
            banks: [bank(rawRow(`"\\u0061${'b'.repeat(length - 6)}"`), rawRow(`"\\u0061${'b'.repeat(length - 6)}"`))],
            baselineReuses: 0, selectorReuses: length <= 32 ? 1 : 0,
        },
    ]),
    {
        name: 'four-row prefix search includes its oldest record',
        banks: [bank(...['a-kind', 'b-kind', 'c-kind', 'd-kind', 'a-kind'].map((tag, index) => row('same', {definitionTags: JSON.stringify(tag), gloss: index === 0 || index === 4 ? smallA : JSON.stringify([`value-${index}`])})))],
        baselineReuses: 0, selectorReuses: 1,
    },
    {
        name: 'four-row prefix search excludes an older fifth record',
        banks: [bank(...['a-kind', 'b-kind', 'c-kind', 'd-kind', 'e-kind', 'a-kind'].map((tag, index) => row('same', {definitionTags: JSON.stringify(tag), gloss: index === 0 || index === 5 ? smallA : JSON.stringify([`value-${index}`])})))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'original lookback one cannot become a prefix search',
        banks: [bank(longOlder, row('same', {...prefixQ, gloss: unsampledLateGlossary}), row('same', {...prefixP, gloss: longGlossary}))],
        baselineReuses: 0, selectorReuses: 0,
    },
    {
        name: 'original long-adjacent proof retains its four-row refill',
        banks: [bank(row('first', {...prefixP, gloss: longGlossary}), row('second', {...prefixQ, gloss: longGlossary}), row('third', {gloss: smallA}), row('fourth', {gloss: longGlossary}))],
        baselineReuses: 2, selectorReuses: 0,
    },
    {
        name: 'original probe budget expires after four misses and readmits after four content hits',
        banks: [bank(...oldFourRowPolicy)],
        baselineReuses: 2, selectorReuses: 0,
    },
    ...[511, 512].map((length) => ({
        name: `original previous-glossary threshold at ${length} bytes`,
        banks: [bank(row('first', {gloss: glossaryOfLength(length)}), row('other', {gloss: glossaryOfLength(length)}))],
        baselineReuses: length >= 512 ? 1 : 0, selectorReuses: 0,
    })),
    {
        name: 'empty banks preserve cross-bank history without adding a row',
        banks: ['[]', bank(row('same')), '[]', bank(row('same')), '[]'],
        baselineReuses: 0, selectorReuses: 1,
    },
    {name: 'all banks empty', banks: ['[]', '[]'], baselineReuses: 0, selectorReuses: 0},
];

const validPrefix = bank(row('same'));
const currentLong = bank(row('same', {...prefixP, gloss: longGlossary}));
const split = currentLong.indexOf(longGlossary) + 27;

/** @type {MalformedCase[]} */
export const malformedCases = [
    {name: 'truncated selected glossary cannot consume the following bank', banks: [bank(longOlder, shortMiddle), currentLong.slice(0, split), currentLong.slice(split)]},
    {name: 'malformed expression escape before a potential proof', banks: [validPrefix, `[["bad\\x","",${body()}]]`]},
    {name: 'malformed reading escape before a potential proof', banks: [validPrefix, `[["same","bad\\x",${body()}]]`]},
    {name: 'invalid definition tags before glossary selection', banks: [validPrefix, bank(row('same', {definitionTags: '{}'}))]},
    {name: 'invalid rules before glossary selection', banks: [validPrefix, bank(row('same', {rules: 'null'}))]},
    {name: 'invalid score before glossary selection', banks: [validPrefix, bank(row('same', {score: 'false'}))]},
    {name: 'invalid numeric prefix before glossary selection', banks: [validPrefix, bank(row('same', {score: '00'}))]},
    {name: 'non-array glossary after a key and prefix match', banks: [validPrefix, bank(row('same', {gloss: 'true'}))]},
    {name: 'unsupported top-level glossary object after a key and prefix match', banks: [validPrefix, bank(row('same', {gloss: '[{"type":"unknown","text":"x"}]'}))]},
    {name: 'malformed glossary escape after a key and prefix match', banks: [validPrefix, bank(row('same', {gloss: '["bad\\x"]'}))]},
    {name: 'invalid sequence after a successful glossary proof', banks: [validPrefix, bank(row('same', {sequence: '17e'}))]},
    {name: 'fractional sequence rejects through the existing fallback', banks: [validPrefix, bank(row('same', {sequence: '0.5'}))]},
    {name: 'invalid term tags after a successful glossary proof', banks: [validPrefix, bank(row('same', {termTags: 'null'}))]},
    {name: 'extra row field after a successful glossary proof', banks: [validPrefix, `[["same","",${body()},true]]`]},
    {name: 'post-row token after a successful glossary proof', banks: [validPrefix, `[${row('same')} null]`]},
    {name: 'unterminated current row after a successful glossary proof', banks: [validPrefix, `[["same","",${body()}`]},
];

/** @type {Array<{name: string, banks: string[], equals?: number[]}>} */
export const fallbackCases = [
    {name: 'fractional score keeps the ordinary number path', banks: [bank(row('same'), row('same', {score: '0.5'}))]},
    {name: 'exponent score keeps the ordinary number path', banks: [bank(row('same'), row('same', {score: '1e1'}))]},
    {name: 'negative zero keeps the ordinary number path', banks: [bank(row('same'), row('same', {score: '-0'}))]},
];

/** Expected isolated-path stages for cases whose rejection mechanism matters.
 * The independent production suite also asserts total public proof counts.
 * @type {Record<string, Record<string, number>>}
 */
export const selectorDiagnostics = {
    'unique short keys and glossaries': {admissions: 0, selected: 0},
    'common-prefix unique keys and glossaries': {admissions: 0, selected: 0},
    'same short key with distinct unsampled glossary bytes': {admissions: 7, selected: 7, fullRejected: 7, failedFullBytesOffered: 1694},
    'isolated proof does not seed the old probe budget': {admissions: 1, selected: 1, budgetPositiveRows: 0, recentContentHits: 0},
    'four full-content hits still admit the original probe policy': {admissions: 1, selected: 1, budgetPositiveRows: 1, recentContentHits: 5, budgetRefreshByRecentStreak: 2},
    'first prefix candidate fails even when an older candidate would succeed': {admissions: 1, candidateRecordsInspected: 1, selected: 1, selectedDistance1: 1, tailRejected: 1},
    'older selected glossary can exceed the immediate 511-byte bound': {admissions: 1, selected: 1, selectedDistance2: 1, selectedAtLeast512: 1, hitDistance2: 1, hitBytes: 1200},
    'older long glossary rejects a late unsampled mismatch': {admissions: 1, selected: 1, selectedDistance2: 1, selectedAtLeast512: 1, tailRejected: 0, middleRejected: 0, fullRejected: 1, failedFullBytesOffered: 1200},
    'older long glossary carries media and normalization hints': {admissions: 1, selected: 1, selectedDistance2: 1, selectedAtLeast512: 1, hitDistance2: 1},
    'selected extent beyond current bank falls back to its short glossary': {selected: 1, selectedDistance2: 1, boundsRejected: 1, fullBytesOffered: 0},
    'selected bounds failure cannot retry an older exact candidate': {admissions: 1, candidateRecordsInspected: 2, selected: 1, selectedDistance2: 1, boundsRejected: 1, fullBytesOffered: 0},
    'definition-tag prefix collision still requires complete content equality': {selected: 1, hits: 1, recentContentHits: 0},
    'rule prefix collision still requires complete content equality': {selected: 1, hits: 1, recentContentHits: 0},
    'equal glossary still requires complete term tags': {selected: 1, hits: 1, recentContentHits: 0},
    'different tag lengths reject a prefix candidate': {admissions: 1, selected: 0, noPrefixCandidate: 1, definitionLengthRejected: 1},
    'different rule lengths reject a prefix candidate': {admissions: 1, selected: 0, noPrefixCandidate: 1, rulesLengthRejected: 1},
    'null and equally long string tags are different prefixes': {admissions: 1, selected: 0, noPrefixCandidate: 1, definitionSignatureRejected: 1},
    'raw reading equal to current expression cannot provide a skipped comparison': {keyIdentityRows: 1, admissions: 0, selected: 0},
    'empty current reading cannot provide a skipped comparison': {keyIdentityRows: 1, admissions: 0, selected: 0},
    'literal and escaped expressions cannot manufacture raw identity': {keyIdentityRows: 1, admissions: 0, selected: 0},
    'utf8 key above the raw byte bound cannot admit': {keyIdentityRows: 1, admissions: 0, selected: 0},
    'literal expression raw body length 33': {keyIdentityRows: 1, admissions: 0, selected: 0},
    'explicit reading raw body length 33': {keyIdentityRows: 1, admissions: 0, selected: 0},
    'escaped expression raw body length 33': {keyIdentityRows: 1, admissions: 0, selected: 0},
    'four-row prefix search includes its oldest record': {admissions: 4, candidateRecordsInspected: 10, noPrefixCandidate: 3, selected: 1, selectedDistance4: 1, hitDistance4: 1},
    'four-row prefix search excludes an older fifth record': {admissions: 5, candidateRecordsInspected: 14, noPrefixCandidate: 5, selected: 0},
    'original lookback one cannot become a prefix search': {keyIdentityRows: 0, admissions: 0, selected: 0, originalLookbackPositiveRows: 2, budgetPositiveRows: 0},
    'original long-adjacent proof retains its four-row refill': {keyIdentityRows: 0, admissions: 0, selected: 0, originalLookbackPositiveRows: 3, budgetPositiveRows: 2},
    'original probe budget expires after four misses and readmits after four content hits': {admissions: 0, selected: 0, originalLookbackPositiveRows: 6, budgetPositiveRows: 6, recentContentHits: 10, budgetRefreshByRecentStreak: 4},
};
