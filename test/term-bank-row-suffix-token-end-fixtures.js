/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** @typedef {{score?: string, sequence?: string, glossary?: string, definitionTags?: string}} Fields */
/** @typedef {{name: string, banks: string[], expectedFallbacks: number, expectedGlossaryReuses: number, negativeZeroScoreIndex?: number}} Fixture */

const plainGlossary = '["meaning"]';
const compactGlossary = JSON.stringify([{
    content: {
        content: {content: 'definition', tag: 'li'},
        data: {content: 'glossary'},
        lang: 'en',
        style: {listStyleType: 'circle'},
        tag: 'ul',
    },
    type: 'structured-content',
}]);

/**
 * @param {string} expression
 * @param {Fields} [fields]
 * @param {string} [reading]
 * @returns {string}
 */
function row(expression, {score = '-5', sequence = '17', glossary = plainGlossary, definitionTags = '"noun"'} = {}, reading = '') {
    return `[${JSON.stringify(expression)},${JSON.stringify(reading)},${definitionTags},"",${score},${glossary},${sequence},"common"]`;
}

/**
 * @param {Fields} [first]
 * @param {Fields} [current]
 * @returns {string[]}
 */
function banks(first = {}, current = first) {
    return [
        `[${row('a', first)},${row('second-key', first)}]`,
        `[${row('much-longer-current-辞書-key', current, 'current reading')}]`,
    ];
}

/** @type {Fixture[]} */
export const tokenEndFixtures = [
    {name: 'changed keys keep integer score and sequence on the native suffix route', banks: banks(), expectedFallbacks: 0, expectedGlossaryReuses: 1},
    {name: 'null sequence keeps its sentinel on the native suffix route', banks: banks({sequence: 'null', definitionTags: 'null'}), expectedFallbacks: 0, expectedGlossaryReuses: 1},
    {name: 'int32 boundary tokens and trailing whitespace supply exact token ends', banks: banks({score: '-2147483648 \t', sequence: '2147483647 \r\n'}), expectedFallbacks: 0, expectedGlossaryReuses: 1},
    {name: 'compact structured glossary suffix retains the merged native list route', banks: banks({score: '7', sequence: '29', glossary: compactGlossary}), expectedFallbacks: 0, expectedGlossaryReuses: 1},
    {name: 'null-to-integer raw suffix mismatch parses fresh numeric boundaries', banks: banks({sequence: 'null'}, {sequence: '-1'}), expectedFallbacks: 0, expectedGlossaryReuses: 0},
    {name: 'negative zero after a valid prior pair uses the number-preserving fallback', banks: banks({score: '0'}, {score: '-0'}), expectedFallbacks: 1, expectedGlossaryReuses: 0, negativeZeroScoreIndex: 2},
    {name: 'fraction after a valid prior pair uses the existing fallback', banks: banks({}, {score: '0.5'}), expectedFallbacks: 1, expectedGlossaryReuses: 0},
    {name: 'sequence exponent after a valid prior pair uses the existing fallback', banks: banks({}, {sequence: '1e1'}), expectedFallbacks: 1, expectedGlossaryReuses: 0},
];

export const malformedAfterSuffix = [
    `[${row('a')},${row('second-key')}]`,
    `[${row('successful-suffix')},${row('malformed-number', {score: '1e'})}]`,
];
