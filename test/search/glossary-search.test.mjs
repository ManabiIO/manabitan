/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
    createGlossarySearchQuery,
    glossaryPrefixUpperBound,
    glossarySearchText,
    glossarySearchTokens,
    scoreGlossarySearchMatch,
} from '../../ext/js/search/glossary-search.js';

test('glossary text includes user-facing structured content but excludes structural metadata', () => {
    const glossary = [
        'domestic cat',
        {
            type: 'structured-content',
            content: {
                tag: 'span',
                data: {href: 'https://example.invalid/not-searchable'},
                content: [
                    {tag: 'b', content: 'household animal'},
                    {type: 'image', path: 'cat.png', title: 'cat diagram', description: 'feline body'},
                ],
            },
        },
    ];
    const text = glossarySearchText(glossary);
    assert.match(text, /domestic cat/);
    assert.match(text, /household animal/);
    assert.match(text, /cat diagram/);
    assert.match(text, /feline body/);
    assert.doesNotMatch(text, /example\.invalid|cat\.png|span/);
});

test('glossary traversal is bounded even when structured content contains little text', () => {
    const content = Array.from({length: 5000}, (_, index) => ({
        tag: 'span',
        content: index === 4999 ? 'unreachable sentinel' : [],
    }));
    const text = glossarySearchText({type: 'structured-content', content});
    assert.doesNotMatch(text, /unreachable sentinel/);
});

test('untrusted glossary strings are limited by code points, including surrogate pairs', () => {
    const text = glossarySearchText(['🐈'.repeat(200000), 'unreachable sentinel']);
    assert.equal(text, '🐈'.repeat(16384));
    assert.equal([...text].length, 16384);
});

test('tokenization normalizes width case apostrophes and bounds duplicate tokens', () => {
    assert.deepEqual(
        glossarySearchTokens(['ＣＡＴ cat', 'Owner’s companion', "owner's companion"]),
        ['cat', "owner's", 'companion'],
    );
});

test('English query admission rejects Japanese and one-character noise', () => {
    assert.deepEqual(createGlossarySearchQuery('House Cat'), {
        folded: 'house cat',
        phrase: 'house cat',
        tokens: ['house', 'cat'],
        prefix: 'cat',
    });
    assert.equal(createGlossarySearchQuery('猫 cat'), null);
    assert.equal(createGlossarySearchQuery('a'), null);
    assert.equal(createGlossarySearchQuery(''), null);
});

test('the final typed word owns completion even if it repeats an earlier word', () => {
    const repeated = createGlossarySearchQuery('cat dog cat');
    assert.deepEqual(repeated, {
        folded: 'cat dog cat',
        phrase: 'cat dog cat',
        tokens: ['dog', 'cat'],
        prefix: 'cat',
    });
    assert.equal(scoreGlossarySearchMatch(['a dog and a cat'], repeated)?.tier, 1);
    assert.equal(scoreGlossarySearchMatch(['the doghouse has caterpillars'], repeated), null);

    assert.deepEqual(createGlossarySearchQuery('a cat')?.tokens, ['cat']);
    assert.equal(createGlossarySearchQuery('cat a'), null);
    assert.equal(createGlossarySearchQuery(`cat ${'x'.repeat(65)}`), null);
    assert.equal(createGlossarySearchQuery(`${'x'.repeat(65)} cat`), null);
    assert.equal(createGlossarySearchQuery('one two three four five six seven eight nine'), null);
});

test('prefix upper bounds cover the prefix and exclude its lexical successor', () => {
    const upper = glossaryPrefixUpperBound('cat');
    if (upper === null) { assert.fail('Expected a finite prefix upper bound'); }
    assert.equal(upper, 'cau');
    assert.ok(upper > 'cat');
    assert.ok(upper > 'caterpillar');
    assert.ok(upper <= 'cau');
});

test('match scoring prefers phrases then exact final tokens then live prefixes', () => {
    const exact = createGlossarySearchQuery('house cat');
    assert.ok(exact);
    assert.deepEqual(scoreGlossarySearchMatch(['a small house cat kept as a pet'], exact), {
        tier: 0,
        phraseIndex: 8,
    });

    const separated = createGlossarySearchQuery('house cat');
    assert.ok(separated);
    assert.deepEqual(scoreGlossarySearchMatch(['cat commonly kept in the house'], separated), {
        tier: 1,
        phraseIndex: Number.MAX_SAFE_INTEGER,
    });

    const prefix = createGlossarySearchQuery('house ca');
    assert.ok(prefix);
    assert.deepEqual(scoreGlossarySearchMatch(['a household house catlike expression'], prefix), {
        tier: 2,
        phraseIndex: Number.MAX_SAFE_INTEGER,
    });

    assert.equal(scoreGlossarySearchMatch(['unrelated dog'], exact), null);
});


test('phrase ranking respects token edges in single and multiword searches', () => {
    const single = createGlossarySearchQuery('cat');
    assert.ok(single);
    assert.equal(scoreGlossarySearchMatch(['catlike'], single)?.tier, 2);
    assert.equal(scoreGlossarySearchMatch(['copycat'], single), null);
    assert.deepEqual(scoreGlossarySearchMatch(['cat'], single), {tier: 0, phraseIndex: 0});
    const phrase = createGlossarySearchQuery('house cat');
    assert.ok(phrase);
    assert.equal(scoreGlossarySearchMatch(['house catlike'], phrase)?.tier, 2);
    assert.equal(scoreGlossarySearchMatch(['household cat'], phrase), null);
});
