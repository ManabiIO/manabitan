/* Prospective synthetic inputs. This module has no executable side effects. */
import assert from 'node:assert/strict';

export const rowsPerBank = 10000;
export const rowsPerCase = 20000;
export const caseNames = [
    'unique-short-keys-inactive',
    'same-key-short-full-misses-inactive',
    'alternating-older-long-full-misses-inactive',
    'active-streak-short-XXY',
    'active-streak-older-long-LSSL-prime',
    'active-streak-first-prefix-QHSSQ',
];

function marker(index) {
    const result = String(index).padStart(6, '0');
    assert.equal(result.length, 6);
    return result;
}

export function legacyGlossary(length, index) {
    const mutationStart = length - 24;
    const result = '["' + 'x'.repeat(mutationStart - 2) + marker(index) + 'x'.repeat(16) + '"]';
    assert.equal(result.length, length);
    return result;
}

export function activeGlossary(length, block, changed = false) {
    const payload = marker(block) + 'x'.repeat(length - 10);
    let result = '["' + payload + '"]';
    assert.equal(result.length, length);
    const mutation = length - 27;
    if (changed) { result = result.slice(0, mutation) + 'y' + result.slice(mutation + 1); }
    assert.equal(result.slice(2, 8), marker(block));
    assert.equal(result[mutation], changed ? 'y' : 'x');
    return result;
}

export function shortSeparatorGlossary(block) {
    const result = JSON.stringify([`${marker(block)} small B`]);
    assert.equal(result.length, 18);
    return result;
}

export function rowSpec(caseId, index) {
    assert(Number.isInteger(index) && index >= 0 && index < rowsPerCase);
    assert(Number.isInteger(caseId) && caseId >= 1 && caseId <= 6);
    let expression;
    let definitionTags;
    let rules;
    let score;
    let glossary;
    let sequence;
    let termTags;
    let block;
    let phase;
    if (caseId <= 3) {
        expression = caseId === 1 ? `k${marker(index)}` : 'shared';
        const long = caseId === 3 && index % 2 === 1;
        definitionTags = caseId === 3 ? (long ? 'bb' : 'aa') : 'aa';
        rules = '';
        score = 0;
        glossary = legacyGlossary(long ? 4096 : 240, index);
        sequence = 1;
        termTags = '';
        block = index;
        phase = long ? 'long' : 'short';
    } else {
        expression = 'same';
        score = -5;
        sequence = 17;
        termTags = 'common';
        const period = caseId === 4 ? 3 : caseId === 5 ? 4 : 5;
        block = Math.floor(index / period);
        const position = index % period;
        if (caseId === 4) {
            definitionTags = 'noun';
            rules = '';
            phase = position === 2 ? 'Y' : 'X';
            glossary = activeGlossary(242, block, position === 2);
        } else {
            const short = caseId === 5 ? position === 1 || position === 2 : position === 2 || position === 3;
            definitionTags = short ? 'other' : 'alpha';
            rules = short ? 'v1' : 'v5a';
            phase = caseId === 5 ? ['L', 'S', 'S', 'L-prime'][position] : ['Q', 'H', 'S', 'S', 'Q'][position];
            glossary = short ? shortSeparatorGlossary(block) : activeGlossary(caseId === 5 ? 4096 : 242, block,
                caseId === 5 ? position === 3 : position === 1);
        }
    }
    const tokens = [JSON.stringify(expression), '""', JSON.stringify(definitionTags), JSON.stringify(rules),
        String(score), glossary, String(sequence), JSON.stringify(termTags)];
    const text = '[' + tokens.join(',') + ']';
    const glossaryOffset = 1 + tokens.slice(0, 5).reduce((sum, value) => sum + value.length + 1, 0);
    assert.equal(text.slice(glossaryOffset, glossaryOffset + glossary.length), glossary);
    return {index, bank: Math.floor(index / rowsPerBank), block, phase, text, tokens, glossary, glossaryOffset};
}

function samples(length) {
    const middle = Math.floor((length - 8) / 2);
    return {tailSample: {start: length - 8, endExclusive: length}, middleSample: {start: middle, endExclusive: middle + 8}};
}

export const fixtureGeometry = {
    byteMeaning: 'All offsets and lengths are raw ASCII UTF-8 bytes, including JSON delimiters; ends are exclusive',
    legacy: {
        short: {serializedGlossaryBytes: 240, marker: {start: 216, endExclusive: 222}, ...samples(240)},
        long: {serializedGlossaryBytes: 4096, marker: {start: 4072, endExclusive: 4078}, ...samples(4096)},
        identity: 'Global row index, six digits, never reset at bank boundary',
    },
    active: {
        short: {serializedGlossaryBytes: 242, blockMarker: {start: 2, endExclusive: 8}, mutation: {start: 215, endExclusive: 216}, ...samples(242)},
        long: {serializedGlossaryBytes: 4096, blockMarker: {start: 2, endExclusive: 8}, mutation: {start: 4069, endExclusive: 4070}, ...samples(4096)},
        separator: {serializedGlossaryBytes: 18, shape: '["000000 small B"]', blockMarker: {start: 2, endExclusive: 8}},
        identity: 'Global block index, six digits, never reset at bank boundary; late x/y mutation distinguishes selected unequal bodies within a block',
        headers: {A: {definitionTags: '"alpha"', rules: '"v5a"'}, B: {definitionTags: '"other"', rules: '"v1"'}},
        headerRejection: 'A/B definition token lengths are both7; rules lengths5 and4 reject before prefix signatures',
    },
};

export function validateGeometry() {
    for (const length of [242, 4096]) {
        const first = activeGlossary(length, 123);
        const second = activeGlossary(length, 123, true);
        const next = activeGlossary(length, 124);
        const {tailSample, middleSample} = samples(length);
        for (const other of [second, next]) {
            assert.notEqual(first, other);
            for (const sample of [tailSample, middleSample]) {
                assert.equal(first.slice(sample.start, sample.endExclusive), other.slice(sample.start, sample.endExclusive));
            }
        }
        assert.equal(first.slice(0, length - 27), second.slice(0, length - 27));
        assert.equal(JSON.parse(first)[0].length, length - 4);
    }
    for (let caseId = 1; caseId <= 6; ++caseId) {
        for (const index of [0, 1, 2, 3, 4, 5, 9998, 9999, 10000, 10001, 19998, 19999]) {
            const spec = rowSpec(caseId, index);
            const decoded = JSON.parse(spec.text);
            assert.equal(decoded.length, 8);
            assert.equal(decoded[1], '');
            assert.equal(JSON.stringify(decoded[5]), spec.glossary);
            assert.equal(Buffer.byteLength(spec.text), spec.text.length);
            assert(spec.tokens[0].length <= 34);
        }
    }
}
