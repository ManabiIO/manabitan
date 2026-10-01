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
