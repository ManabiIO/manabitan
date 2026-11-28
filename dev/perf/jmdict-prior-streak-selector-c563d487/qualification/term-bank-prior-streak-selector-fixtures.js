/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** @typedef {{score?: string, sequence?: string, definitionTags?: string, rules?: string, termTags?: string, gloss?: string}} Fields */
/** @typedef {{equals?: number[], diagnostics?: Record<string, number>}} Extras */
/** @typedef {{name: string, banks: string[], baselineReuses: number, selectorReuses: number, equals?: number[], diagnostics?: Record<string, number>}} ValidCase */
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
export function rawRow(expression, fields = {}, reading = '""') { return `[${expression},${reading},${body(fields)}]`; }

/**
 * @param {string} expression
 * @param {Fields} [fields]
 * @param {string} [reading]
 * @returns {string}
 */
export function row(expression, fields = {}, reading = '""') { return rawRow(JSON.stringify(expression), fields, reading); }

/**
 * @param {...string} rows
 * @returns {string}
 */
export function bank(...rows) { return `[${rows.join(',')}]`; }

/**
 * @param {string} previous
 * @param {string} current
 * @returns {string[]}
 */
export function active(previous, current) { return [bank(previous, previous), bank(current)]; }

/**
 * @param {number} length
 * @returns {string}
 */
function glossaryOfLength(length) { return JSON.stringify(['x'.repeat(length - 4)]); }

/**
 * The changed ASCII byte is outside the existing eight-byte middle/tail samples.
 * @param {string} glossary
 * @returns {string}
 */
function lateMismatch(glossary) {
    const offset = glossary.length - 27;
    return `${glossary.slice(0, offset)}y${glossary.slice(offset + 1)}`;
}

/**
 * @param {string} name
 * @param {string[]} banks
 * @param {number} baselineReuses
 * @param {number} selectorReuses
 * @param {Extras} [extras]
 * @returns {ValidCase}
 */
function fixture(name, banks, baselineReuses, selectorReuses, extras = {}) {
    return {name, banks, baselineReuses, selectorReuses, ...extras};
}

const headerA = {definitionTags: '"alpha"', rules: '"v5a"'};
const headerB = {definitionTags: '"other"', rules: '"v1"'};
const shortX = glossaryOfLength(242);
const shortY = lateMismatch(shortX);
const longL = glossaryOfLength(4096);
const longMismatch = lateMismatch(longL);
const smallA = '["small A"]';
const smallB = '["small B"]';
const longRow = row('same', {...headerA, gloss: longL});
const smallRow = row('same', {...headerB, gloss: smallB});
const olderPrelude = bank(longRow, smallRow, smallRow);
const longMedia = JSON.stringify([{type: 'text', text: 'x'.repeat(4000)}, {type: 'image', path: 'large.png'}]);
const oldFourRowPolicy = [
    ...Array.from({length: 6}, (_, i) => row(`initial-${i}`, {gloss: smallA})),
    ...Array.from({length: 4}, (_, i) => row(`miss-${i}`, {gloss: JSON.stringify([`miss-${i}`])})),
    ...Array.from({length: 6}, (_, i) => row(`late-${i}`, {gloss: smallB})),
];

/** @type {ValidCase[]} */
export const validCases = [
    fixture(
        'inactive unique short keys and glossaries',
        [bank(...Array.from({length: 12}, (_, i) => row(`key-${i}`, {gloss: JSON.stringify([`definition-${i}`])})))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 0, admissions: 0, selected: 0}},
    ),
    fixture(
        'inactive common-prefix unique keys and glossaries',
        [bank(...Array.from({length: 12}, (_, i) => row(`common-key-${i}`, {gloss: JSON.stringify([`${'x'.repeat(200)}-${i}`])})))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 0, admissions: 0, selected: 0}},
    ),
    fixture(
        'inactive same short key with all-distinct glossary content',
        [bank(...Array.from({length: 8}, (_, i) => row('same', {gloss: JSON.stringify([`${i}${'x'.repeat(237)}`])})))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 0, admissions: 0, selected: 0}},
    ),
    fixture(
        'the first duplicate cannot use a streak established by its own row',
        [bank(row('same'), row('same'))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 0, admissions: 0, recentContentHits: 1}},
    ),
    fixture(
        'active exact short glossary preserves all hints and current numerics',
        active(row('same'), row('same', {score: '42', sequence: '99'})),
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 1, expressionMatches: 1, hitDistance1: 1}},
    ),
    fixture(
        'an active isolated proof cannot seed the old probe budget',
        [bank(row('same'), row('same'), row('same', {termTags: '"different"'}), row('other', {termTags: '"third"'}))],
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 1, budgetPositiveRows: 0, recentContentHits: 1}},
    ),
    fixture(
        'the fourth full-content match still admits the original probe policy',
        [bank(...['same', 'same', 'same', 'fourth', 'fifth', 'sixth'].map((key) => row(key)))],
        1,
        1,
        {diagnostics: {keyPredicateRows: 3, admissions: 1, selected: 1, budgetPositiveRows: 1, recentContentHits: 5, budgetRefreshByRecentStreak: 2}},
    ),
    fixture(
        'active short X X Y rejects one late unsampled full comparison',
        active(row('same', {gloss: shortX}), row('same', {gloss: shortY})),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 1, selectedDistance1: 1, tailRejected: 0, middleRejected: 0, fullRejected: 1, failedFullBytesOffered: 242, recentContentHits: 1}},
    ),
    fixture(
        'active older 4096-byte candidate rejects a late unsampled mismatch',
        [olderPrelude, bank(row('same', {...headerA, gloss: longMismatch}))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 1, selectedDistance3: 1, selectedAtLeast512: 1, tailRejected: 0, middleRejected: 0, fullRejected: 1, failedFullBytesOffered: 4096, originalLookbackPositiveRows: 1, recentContentHits: 1}},
    ),
    fixture(
        'active older 4096-byte candidate succeeds without a new cap',
        [olderPrelude, bank(row('same', {...headerA, gloss: longL, score: '42', sequence: '99', termTags: '"different"'}))],
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 1, selectedDistance3: 1, selectedAtLeast512: 1, hitDistance3: 1, hitBytes: 4096, originalLookbackPositiveRows: 1}},
    ),
    fixture(
        'active older long candidate preserves media and normalization hints',
        [bank(row('same', {...headerA, gloss: longMedia}), smallRow, smallRow), bank(row('same', {...headerA, gloss: longMedia}))],
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 1, selectedDistance3: 1, selectedAtLeast512: 1, hitDistance3: 1}},
    ),
    fixture(
        'active selected extent stops at the current bank despite readable next-bank bytes',
        [olderPrelude, bank(row('same', {...headerA, gloss: smallA})), bank(row('following', {...headerB, gloss: longL}))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 1, selectedDistance3: 1, boundsRejected: 1, fullBytesOffered: 0}},
    ),
    fixture(
        'active first prefix failure cannot retry an older exact glossary',
        [bank(row('same', {...headerA, gloss: shortX}), row('same', {...headerA, gloss: shortY}), smallRow, smallRow), bank(row('same', {...headerA, gloss: shortX}))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, candidateRecordsInspected: 3, selected: 1, selectedDistance3: 1, tailRejected: 0, middleRejected: 0, fullRejected: 1, failedFullBytesOffered: 242, recentContentHits: 2, budgetPositiveRows: 0}},
    ),
    fixture(
        'active first prefix bounds failure cannot retry an older short exact glossary',
        [bank(row('same', {...headerA, gloss: smallA}), longRow, smallRow, smallRow), bank(row('same', {...headerA, gloss: smallA}))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, candidateRecordsInspected: 3, selected: 1, selectedDistance3: 1, boundsRejected: 1, fullBytesOffered: 0, recentContentHits: 2}},
    ),
    fixture(
        'active definition-tag prefix collision retains complete tag equality',
        active(row('same', {definitionTags: '"abcX"'}), row('same', {definitionTags: '"abcY"'})),
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, selected: 1, hits: 1, recentContentHits: 1}},
    ),
    fixture(
        'active rule prefix collision retains complete rule equality',
        active(row('same', {rules: '"abcX"'}), row('same', {rules: '"abcY"'})),
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, selected: 1, hits: 1, recentContentHits: 1}},
    ),
    fixture(
        'active glossary proof retains complete term-tag equality',
        active(row('same', {termTags: '"abcX"'}), row('same', {termTags: '"abcY"'})),
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, selected: 1, hits: 1, recentContentHits: 1}},
    ),
    fixture(
        'active colliding header prefix cannot authorize unequal glossary bytes',
        active(row('same', {definitionTags: '"abcX"', gloss: shortX}), row('same', {definitionTags: '"abcY"', gloss: shortY})),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, selected: 1, fullRejected: 1, failedFullBytesOffered: 242}},
    ),
    fixture(
        'active colliding witness still finds the older complete-content match',
        [bank(row('same', {definitionTags: '"abcX"'}), row('same', {definitionTags: '"abcY"'}), row('same', {definitionTags: '"abcY"'}), row('same', {definitionTags: '"abcX"'}))],
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, selected: 1, hits: 1, recentContentHits: 2}},
    ),
    fixture(
        'active different tag lengths reject both prior prefixes',
        active(row('same', {definitionTags: '"abcd"'}), row('same', {definitionTags: '"abcde"'})),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 0, noPrefixCandidate: 1, definitionLengthRejected: 2}},
    ),
    fixture(
        'active different rule lengths reject both prior prefixes',
        active(row('same', {rules: '"abcd"'}), row('same', {rules: '"abcde"'})),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 0, noPrefixCandidate: 1, rulesLengthRejected: 2}},
    ),
    fixture(
        'active different rule signatures reject equally long rules',
        active(row('same', {rules: '"abc"'}), row('same', {rules: '"def"'})),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 0, noPrefixCandidate: 1, rulesSignatureRejected: 2}},
    ),
    fixture('active nullable tags preserve raw prefixes and the current sequence', active(row('same', {definitionTags: 'null', sequence: 'null'}), row('same', {definitionTags: 'null', sequence: '5'})), 0, 1),
    fixture(
        'active null and equally long string tags remain different prefixes',
        active(row('same', {definitionTags: 'null'}), row('same', {definitionTags: '"xx"'})),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 0, noPrefixCandidate: 1, definitionSignatureRejected: 2}},
    ),
    fixture('active short tag and rule bodies use bounded raw signatures', active(row('same', {definitionTags: '"a"', rules: '"b"'}), row('same', {definitionTags: '"a"', rules: '"b"'})), 0, 1),
    fixture(
        'active raw-equal reading cannot provide reading-only admission',
        active(row('other', {}, '"same"'), row('same', {}, '"same"')),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 0, readingAliasRejected: 1, selected: 0}},
    ),
    fixture(
        'active empty reading cannot provide reading-only admission',
        active(row('other'), row('same')),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 0, readingIneligibleRows: 1, selected: 0}},
    ),
    fixture(
        'active non-alias reading identity admits independently',
        active(row('older', {}, '"reading"'), row('later', {}, '"reading"')),
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, expressionMatches: 0, readingMatches: 1}},
    ),
    fixture(
        'active expression identity admits despite current reading alias',
        active(row('same', {}, '"other"'), row('same', {}, '"same"')),
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, expressionMatches: 1, readingMatches: 0, readingAliasRejected: 0}},
    ),
    fixture(
        'active expression identity admits despite current empty reading',
        active(row('same', {}, '"other"'), row('same')),
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, expressionMatches: 1, readingIneligibleRows: 0}},
    ),
    fixture(
        'active literal and escaped expressions cannot manufacture raw identity',
        active(rawRow('"a"'), rawRow('"\\u0061"')),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 0, selected: 0}},
    ),
    fixture(
        'active literal reading and escaped expression keep raw inequality',
        active(row('other', {}, '"a"'), rawRow('"\\u0061"', {}, '"a"')),
        0,
        1,
        {equals: [0, 0, 0], diagnostics: {keyPredicateRows: 1, admissions: 1, expressionMatches: 0, readingMatches: 1, readingAliasRejected: 0}},
    ),
    fixture(
        'active escaped reading and literal expression keep raw inequality',
        active(row('other', {}, '"\\u0061"'), rawRow('"a"', {}, '"\\u0061"')),
        0,
        1,
        {equals: [0, 0, 0], diagnostics: {keyPredicateRows: 1, admissions: 1, expressionMatches: 0, readingMatches: 1, readingAliasRejected: 0}},
    ),
    fixture(
        'active identical escaped keys retain baseline interning and raw flags',
        active(rawRow('"\\u0061"', {}, '"a"'), rawRow('"\\u0061"', {}, '"a"')),
        0,
        1,
        {equals: [0, 0, 0]},
    ),
    fixture(
        'active lone-surrogate escapes retain replacement bytes and raw flags',
        active(rawRow('"\\ud800"', {}, '"�"'), rawRow('"\\ud800"', {}, '"�"')),
        0,
        1,
        {equals: [0, 0, 0]},
    ),
    fixture(
        'active paired-surrogate escapes retain raw reading equality',
        active(rawRow('"\\ud83d\\ude00"', {}, '"😀"'), rawRow('"\\ud83d\\ude00"', {}, '"\\ud83d\\ude00"')),
        0,
        1,
        {equals: [0, 0, 1]},
    ),
    fixture(
        'active long raw reading alias adds no unbounded equality scan',
        active(row('x'.repeat(100), {}, JSON.stringify('x'.repeat(100))), row('x'.repeat(100), {}, JSON.stringify('x'.repeat(100)))),
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 0, selected: 0, keyComparisonCalls: 0, keyComparisonBytesOffered: 0}},
    ),
    fixture(
        'active worst-case key predicate offers three bounded 32-byte comparisons',
        active(row('a'.repeat(32), {}, JSON.stringify('b'.repeat(32))), row('c'.repeat(32), {}, JSON.stringify('b'.repeat(32)))),
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, expressionMatches: 0, readingMatches: 1, keyComparisonCalls: 3, keyComparisonBytesOffered: 96}},
    ),
    ...[31, 32, 33].flatMap((length) => {
        const tokens = [
            ['ASCII', JSON.stringify('x'.repeat(length))],
            ['UTF8', JSON.stringify(`${'あ'.repeat(10)}${'a'.repeat(length - 30)}`)],
            ['escaped', `"\\u0061${'b'.repeat(length - 6)}"`],
        ];
        return tokens.flatMap(([kind, token]) => [
            fixture(
                `active ${kind} expression raw body length ${length}`,
                active(rawRow(token), rawRow(token)),
                0,
length <= 32 ? 1 : 0,
{diagnostics: {keyPredicateRows: 1, admissions: length <= 32 ? 1 : 0, selected: length <= 32 ? 1 : 0}},
            ),
            fixture(
                `active ${kind} reading raw body length ${length}`,
                active(row('first', {}, token), row('other', {}, token)),
                0,
length <= 32 ? 1 : 0,
{diagnostics: {keyPredicateRows: 1, admissions: length <= 32 ? 1 : 0, selected: length <= 32 ? 1 : 0}},
            ),
        ]);
    }),
    fixture(
        'active prefix search includes its fourth prior record',
        [bank(row('same', {...headerA, gloss: shortX}), row('same', {definitionTags: '"third"', gloss: '["other"]'}), smallRow, smallRow), bank(row('same', {...headerA, gloss: shortX}))],
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, candidateRecordsInspected: 4, selected: 1, selectedDistance4: 1, hitDistance4: 1}},
    ),
    fixture(
        'active prefix search excludes a fifth prior record',
        [bank(row('same', {...headerA, gloss: shortX}), row('same', {definitionTags: '"third"', gloss: '["other"]'}), row('same', {definitionTags: '"fourth"', gloss: '["another"]'}), smallRow, smallRow), bank(row('same', {...headerA, gloss: shortX}))],
        0,
        0,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, candidateRecordsInspected: 4, selected: 0, noPrefixCandidate: 1}},
    ),
    fixture(
        'original lookback one cannot turn into a prior-streak prefix search',
        [bank(longRow, row('same', {...headerB, gloss: longMismatch}), longRow)],
        0,
        0,
        {diagnostics: {keyPredicateRows: 0, admissions: 0, selected: 0, originalLookbackPositiveRows: 2, budgetPositiveRows: 0}},
    ),
    fixture(
        'original long-adjacent proof retains its four-row budget refill',
        [bank(row('first', {...headerA, gloss: longL}), row('second', {...headerB, gloss: longL}), row('third', {gloss: smallA}), row('fourth', {gloss: longL}))],
        2,
        0,
        {diagnostics: {keyPredicateRows: 0, admissions: 0, selected: 0, originalLookbackPositiveRows: 3, budgetPositiveRows: 2}},
    ),
    fixture(
        'original four misses expire and four later content hits readmit',
        [bank(...oldFourRowPolicy)],
        2,
        0,
        {diagnostics: {keyPredicateRows: 6, admissions: 0, selected: 0, originalLookbackPositiveRows: 6, budgetPositiveRows: 6, recentContentHits: 10, budgetRefreshByRecentStreak: 4}},
    ),
    ...[511, 512].flatMap((length) => [
        fixture(`original no-streak previous-glossary threshold at ${length} bytes`, [bank(row('first', {gloss: glossaryOfLength(length)}), row('other', {gloss: glossaryOfLength(length)}))], length >= 512 ? 1 : 0, 0),
        fixture(`active previous-glossary threshold at ${length} bytes`, active(row('same', {gloss: glossaryOfLength(length)}), row('same', {gloss: glossaryOfLength(length)})), length >= 512 ? 2 : 0, length < 512 ? 1 : 0),
    ]),
    fixture(
        'empty banks preserve an existing cross-bank content streak',
        ['[]', bank(row('same')), '[]', bank(row('same')), '[]', bank(row('same')), '[]'],
        0,
        1,
        {diagnostics: {keyPredicateRows: 1, admissions: 1, selected: 1, hitDistance1: 1}},
    ),
    fixture('all banks empty', ['[]', '[]'], 0, 0, {diagnostics: {keyPredicateRows: 0, admissions: 0, selected: 0}}),
];

const activePrefix = bank(row('same'), row('same'));
const currentLong = bank(longRow);
const split = currentLong.indexOf(longL) + 27;

/** @type {MalformedCase[]} */
export const malformedCases = [
    {name: 'active truncated long glossary cannot consume a following bank', banks: [olderPrelude, currentLong.slice(0, split), currentLong.slice(split)]},
    {name: 'active malformed expression is rejected before the helper', banks: [activePrefix, `[["bad\\x","",${body()}]]`]},
    {name: 'active malformed reading is rejected before the helper', banks: [activePrefix, `[["same","bad\\x",${body()}]]`]},
    {name: 'active invalid definition tags are rejected before the helper', banks: [activePrefix, bank(row('same', {definitionTags: '{}'}))]},
    {name: 'active invalid rules are rejected before the helper', banks: [activePrefix, bank(row('same', {rules: 'null'}))]},
    {name: 'active invalid score is rejected before the helper', banks: [activePrefix, bank(row('same', {score: 'false'}))]},
    {name: 'active invalid numeric prefix is rejected before the helper', banks: [activePrefix, bank(row('same', {score: '00'}))]},
    {name: 'active non-array glossary is rejected before the helper', banks: [activePrefix, bank(row('same', {gloss: 'true'}))]},
    {name: 'active unsupported top-level glossary object is still rejected', banks: [activePrefix, bank(row('same', {gloss: '[{"type":"unknown","text":"x"}]'}))]},
    {name: 'active malformed glossary escape is still rejected', banks: [activePrefix, bank(row('same', {gloss: '["bad\\x"]'}))]},
    {name: 'invalid sequence remains rejected after an active glossary proof', banks: [activePrefix, bank(row('same', {sequence: '17e'}))]},
    {name: 'fractional sequence rejects through the existing fallback', banks: [activePrefix, bank(row('same', {sequence: '0.5'}))]},
    {name: 'invalid term tags remain rejected after an active glossary proof', banks: [activePrefix, bank(row('same', {termTags: 'null'}))]},
    {name: 'extra row field remains rejected after an active glossary proof', banks: [activePrefix, `[["same","",${body()},true]]`]},
    {name: 'post-row token remains rejected after an active glossary proof', banks: [activePrefix, `[${row('same')} null]`]},
    {name: 'unterminated row remains rejected after an active glossary proof', banks: [activePrefix, `[["same","",${body()}`]},
];

/** @type {Array<{name: string, banks: string[], equals?: number[]}>} */
export const fallbackCases = [
    {name: 'active fractional score retains the ordinary number path', banks: active(row('same'), row('same', {score: '0.5'}))},
    {name: 'active exponent score retains the ordinary number path', banks: active(row('same'), row('same', {score: '1e1'}))},
    {name: 'active negative zero retains the ordinary number path', banks: active(row('same'), row('same', {score: '-0'}))},
];

/** @type {Record<string, Record<string, number>>} */
export const selectorDiagnostics = Object.fromEntries(validCases.filter(({diagnostics}) => typeof diagnostics !== 'undefined')
    .map(({name, diagnostics}) => [name, diagnostics ?? {}]));
