/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {isJapanesePrefixCandidate} from '../ext/js/search/japanese-search.js';

describe('Japanese prefix completion eligibility', () => {
    test.each(['たべ', '食べ', 'ガッ', 'カー', 'あー', 'あ・い'])('accepts two Japanese characters in %s', (query) => {
        expect(isJapanesePrefixCandidate(query)).toBe(true);
    });

    test.each(['食', 'た', 'ny', 'hello', 'たbe', '猫!', '猫🐈', '猫3', 'ー?', 'ーー', '食べé', 'たべñ', 'たべＡ', 'たべÑ'])('rejects queries without two Japanese letters in %s', (query) => {
        expect(isJapanesePrefixCandidate(query)).toBe(false);
    });
});
