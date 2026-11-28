// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic gate arithmetic only. These are not corpus observations.
import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateAliasRows} from './raw-alias-analysis.mjs';

const cases = [
    {name: 'clear positive', rows: Array.from({length: 12}, () => ({A: 100, B: 85, C: 100})), advance: true},
    {name: 'exact ten ms and percent boundaries', rows: Array.from({length: 12}, () => ({A: 100, B: 90, C: 100})), advance: true},
    {name: 'below prospective minimum', rows: Array.from({length: 12}, () => ({A: 100, B: 91, C: 100})), advance: false},
    {name: 'control drift dominates candidate signal', rows: Array.from({length: 12}, () => ({A: 100, B: 80, C: 140})), advance: false},
    {name: 'regression has positive absolute drift limit but cannot advance', rows: Array.from({length: 12}, () => ({A: 100, B: 110, C: 100})), advance: false},
    {name: 'eight faster pairs is insufficient', rows: Array.from({length: 12}, (_, index) => ({A: 100, B: index < 8 ? 70 : 110, C: 100})), advance: false},
];
for (const item of cases) {
    await test(item.name, () => {
        const result = evaluateAliasRows(item.rows);
        assert.equal(result.advance, item.advance);
        assert.equal(result.bootstrap.samples, 20000);
        assert.equal(result.bootstrap.seedHex, '0x000da6c4');
        if (item.name === 'clear positive') {
            for (const name of ['B/A', 'B/C']) {
                assert.equal(result.comparisons[name].pairedMedianSavingMs, 15);
                assert.equal(result.comparisons[name].pairedMedianSavingPercent, 15);
                assert.deepEqual(result.comparisons[name].pairedMedianDifferenceMs95, [-15, -15]);
                assert.deepEqual(result.comparisons[name].pairedMedianDifferencePercent95, [-15, -15]);
            }
        }
    });
}
await test('incomplete or invalid arithmetic input cannot be analyzed', () => {
    assert.throws(() => evaluateAliasRows(cases[0].rows.slice(1)));
    assert.throws(() => evaluateAliasRows(cases[0].rows.map((row, index) => index ? row : {...row, B: NaN})));
    assert.throws(() => evaluateAliasRows(cases[0].rows.map((row, index) => index ? row : {...row, C: 0})));
});
