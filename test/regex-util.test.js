/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {describe, expect, test} from 'vitest';
import {applyMatchReplacement, applyTextReplacement} from '../ext/js/general/regex-util.js';

const replacementCases = [
    {name: 'literal dollar', text: 'abc', pattern: /b/, replacement: '$$'},
    {name: 'whole match', text: 'abc', pattern: /b/, replacement: '[$&]'},
    {name: 'original prefix', text: 'abc', pattern: /b/, replacement: "$`"},
    {name: 'original suffix', text: 'abcd', pattern: /bc/, replacement: "$'"},
    {name: 'participating capture', text: 'abc', pattern: /(b)/, replacement: '$1'},
    {name: 'unmatched capture', text: 'a', pattern: /(a)(b)?/, replacement: '$2'},
    {name: 'out-of-range capture', text: 'a', pattern: /(a)/, replacement: '$2'},
    {name: 'no captures', text: 'a', pattern: /a/, replacement: '$1'},
    {name: 'two-digit fallback', text: 'a', pattern: /(a)/, replacement: '$12'},
    {name: 'two-digit unmatched fallback', text: 'a', pattern: /(a)(b)?/, replacement: '$23'},
    {name: 'leading-zero capture', text: 'a', pattern: /(a)/, replacement: '$01'},
    {name: 'zero is literal', text: 'a', pattern: /(a)/, replacement: '$0/$00'},
    {name: 'unknown two-digit capture', text: 'a', pattern: /(a)/, replacement: '$99'},
    {name: 'tenth capture', text: 'abcdefghij', pattern: /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/, replacement: '$10/$11'},
    {name: 'named capture', text: 'a', pattern: /(?<first>a)/, replacement: '$<first>'},
    {name: 'unmatched named capture', text: 'a', pattern: /(?<first>a)(?<second>b)?/, replacement: '$<second>'},
    {name: 'missing named capture', text: 'a', pattern: /(?<first>a)/, replacement: '$<missing>'},
    {name: 'inherited name is not a capture', text: 'a', pattern: /(?<first>a)/, replacement: '$<toString>'},
    {name: 'named syntax without groups stays literal', text: 'a', pattern: /(a)/, replacement: '$<first>'},
    {name: 'capture dollars are not recursively expanded', text: '$&', pattern: /(\$&)/, replacement: '$1'},
    {name: 'escaped replacement token', text: 'abc', pattern: /b/, replacement: '$$&'},
    {name: 'multiple replacement tokens', text: 'abc', pattern: /(b)/, replacement: "$$|$&|$`|$'|$1|$2"},
];

describe('regular expression replacement tokens', () => {
    test.each(replacementCases)('applyTextReplacement: $name', ({text, pattern, replacement}) => {
        const expected = text.replace(new RegExp(pattern), replacement);
        expect(applyTextReplacement(text, new RegExp(pattern), replacement)).toBe(expected);
    });

    test.each(replacementCases)('applyMatchReplacement: $name', ({text, pattern, replacement}) => {
        const match = pattern.exec(text);
        if (match === null) { throw new Error('Invalid replacement test fixture'); }
        const result = `${text.slice(0, match.index)}${applyMatchReplacement(replacement, match)}${text.slice(match.index + match[0].length)}`;
        expect(result).toBe(text.replace(pattern, replacement));
    });
});

describe('whole-text replacement semantics', () => {
    test.each([
        {name: 'lookbehind sees the original input', text: 'aaa', pattern: /(?<=a)a/g, replacement: 'x'},
        {name: 'insertions cannot create later matches', text: 'ba', pattern: /b|(?<=x)a/g, replacement: 'x'},
        {name: 'prefix tokens use original input for every match', text: 'aba', pattern: /a/g, replacement: "$`"},
        {name: 'suffix tokens use original input for every match', text: 'aba', pattern: /a/g, replacement: "$'"},
        {name: 'empty ASCII matches', text: 'ab', pattern: /(?:)/g, replacement: '-'},
        {name: 'no match', text: 'abc', pattern: /z/g, replacement: '$&'},
    ])('$name', ({text, pattern, replacement}) => {
        expect(applyTextReplacement(text, pattern, replacement)).toBe(text.replace(new RegExp(pattern), replacement));
    });

    test('empty Unicode matches advance over a complete surrogate pair', () => {
        const pattern = /(?:)/gu;
        const originalExec = pattern.exec.bind(pattern);
        let calls = 0;
        pattern.exec = (text) => {
            if (++calls > 16) { throw new Error('Replacement failed to advance past a surrogate pair'); }
            return originalExec(text);
        };
        expect(applyTextReplacement('😀あ', pattern, '-')).toBe('-😀-あ-');
    });

    test('sticky lastIndex follows the original match, not the replacement length', () => {
        const pattern = /b/y;
        pattern.lastIndex = 1;
        expect(applyTextReplacement('abc', pattern, 'long')).toBe('alongc');
        expect(pattern.lastIndex).toBe(2);
    });

    test('global replacement ignores and resets a previous lastIndex', () => {
        const pattern = /a/g;
        pattern.lastIndex = 2;
        expect(applyTextReplacement('aaa', pattern, 'x')).toBe('xxx');
        expect(pattern.lastIndex).toBe(0);
    });
});
