/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */
/** @typedef {{score?: string, sequence?: string, definitionTags?: string, rules?: string, termTags?: string, glossary?: string}} Fields */
/** @typedef {{name: string, banks: string[], experiments?: Experiments, expectedFallbacks: number, expectedGlossaryReuses: number, expectedGlobalHits: number, expectedProofs: number, expectedNumericCopies: number, expectedSequenceCopies: number, expectedOrdinaryComparisons: number}} ProofFixture */

/**
 * @param {string} expression
 * @param {Fields} [fields]
 * @returns {string}
 */
function row(expression, {score = '-5', sequence = '17', definitionTags = '"noun"', rules = '""', termTags = '"common"', glossary = '["shared"]'} = {}) {
    return `[${JSON.stringify(expression)},"",${definitionTags},${rules},${score},${glossary},${sequence},${termTags}]`;
}

/**
 * @param {...string} rows
 * @returns {string}
 */
function bank(...rows) { return `[${rows.join(',')}]`; }

const longGlossary = JSON.stringify(['x'.repeat(600)]);
const twoLongRows = bank(row('long-first', {glossary: longGlossary}), row('long-second', {glossary: longGlossary}));
const provenPrefix = bank(row('first'), row('second'), row('third'));
const ringRows = Array.from({length: 15}, (_, index) => row(`ring-${index}`, {sequence: 'null'}));
const ringBanks = [bank(...ringRows.slice(0, 4)), '[]', bank(...ringRows.slice(4, 9)), bank(...ringRows.slice(9))];

/** @type {Array<{name: string, fields: Fields}>} */
const glossaryOnly = [
    {name: 'different numeric values', fields: {score: '-4', sequence: '18'}},
    {name: 'different rules', fields: {rules: '"v5"'}},
    {name: 'different definition tags', fields: {definitionTags: '"verb"'}},
    {name: 'different term tags', fields: {termTags: '"public"'}},
];

/** @type {Array<{name: string, fields: Fields}>} */
const unsupportedAfterProof = [
    {name: 'negative-zero score', fields: {score: '-0'}},
    {name: 'overflowing score', fields: {score: '2147483648'}},
    {name: 'fractional score', fields: {score: '0.5'}},
    {name: 'exponent score', fields: {score: '1e0'}},
    {name: 'overflowing sequence', fields: {sequence: '2147483648'}},
    {name: 'exponent sequence', fields: {sequence: '1e0'}},
];

/** @type {ProofFixture[]} */
export const proofConsumerFixtures = [
    ...glossaryOnly.map(({name, fields}) => ({
        name: `a glossary-only witness with ${name} is not a full-suffix proof`,
        banks: [twoLongRows, bank(row('current', {glossary: longGlossary, ...fields}))],
        expectedFallbacks: 0,
        expectedGlossaryReuses: 2,
        expectedGlobalHits: 0,
        expectedProofs: 0,
        expectedNumericCopies: 0,
        expectedSequenceCopies: 0,
        expectedOrdinaryComparisons: 0,
    })),
    {
        name: 'a prior suffix success does not copy later unequal numeric values',
        banks: [provenPrefix, bank(row('current', {score: '7', sequence: '19'}))],
        expectedFallbacks: 0,
        expectedGlossaryReuses: 2,
        expectedGlobalHits: 0,
        expectedProofs: 1,
        expectedNumericCopies: 1,
        expectedSequenceCopies: 1,
        expectedOrdinaryComparisons: 1,
    },
    ...unsupportedAfterProof.map(({name, fields}) => ({
        name: `${name} after a completed suffix still takes numeric fallback`,
        banks: [provenPrefix, bank(row('current', fields))],
        expectedFallbacks: 1,
        expectedGlossaryReuses: 2,
        expectedGlobalHits: 0,
        expectedProofs: 1,
        expectedNumericCopies: 1,
        expectedSequenceCopies: 1,
        expectedOrdinaryComparisons: 1,
    })),
    {
        name: 'cross-bank ring wrap retains latest content and null sequence',
        banks: ringBanks,
        expectedFallbacks: 0,
        expectedGlossaryReuses: 13,
        expectedGlobalHits: 0,
        expectedProofs: 13,
        expectedNumericCopies: 13,
        expectedSequenceCopies: 0,
        expectedOrdinaryComparisons: 13,
    },
    {
        name: 'global exact-content mode retains its existing hash and match path',
        banks: ringBanks,
        experiments: {experimentalGlobalExactContentReuse: true},
        expectedFallbacks: 0,
        expectedGlossaryReuses: 13,
        expectedGlobalHits: 14,
        expectedProofs: 13,
        expectedNumericCopies: 13,
        expectedSequenceCopies: 0,
        expectedOrdinaryComparisons: 0,
    },
    {
        name: 'disabled reuse does not return full-suffix status across ring wrap',
        banks: ringBanks,
        experiments: {experimentalValidatedGlossaryReuse: false},
        expectedFallbacks: 0,
        expectedGlossaryReuses: 0,
        expectedGlobalHits: 0,
        expectedProofs: 0,
        expectedNumericCopies: 0,
        expectedSequenceCopies: 0,
        expectedOrdinaryComparisons: 0,
    },
    {
        name: 'a current key fallback occurs before copied numeric columns',
        banks: [provenPrefix, bank(row('escaped').replace('"escaped"', '"\\u0061"'))],
        experiments: {experimentalNativeEscapedKeys: false},
        expectedFallbacks: 1,
        expectedGlossaryReuses: 2,
        expectedGlobalHits: 0,
        expectedProofs: 2,
        expectedNumericCopies: 1,
        expectedSequenceCopies: 1,
        expectedOrdinaryComparisons: 1,
    },
];
