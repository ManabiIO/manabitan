/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
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
import {compareRevisions} from '../ext/js/dictionary/dictionary-data-util.js';

describe('compareRevisions', () => {
    /** @type {[current: string, latest: string, hasUpdate: boolean][]} */
    const data = [
        ['1', '2', true],
        ['4.7', '4.8', true],
        ['4.8', '4.8', false],
        ['version1', 'version2', true],
        ['version2', 'version100', false],
        ['9007199254740992', '9007199254740993', true],
        ['9007199254740993', '9007199254740992', false],
        ['1.9007199254740992', '1.9007199254740993', true],
        ['1.9007199254740993', '1.9007199254740992', false],
        ['0009007199254740993', '9007199254740993', false],
        ['9007199254740993', '0009007199254740993', false],
        ['9'.repeat(310), `1${'0'.repeat(310)}`, true],
        [`1${'0'.repeat(310)}`, '9'.repeat(310), false],
        ['1.9007199254740993.9', '1.9007199254740992.10', false],
        ['1.9007199254740992.10', '1.9007199254740993.9', true],
        ['000.001.000', '0.1.0', false],
        ['0.1.0', '000.001.000', false],
        ['0.0', '0.0001', true],
        // Preserve the existing lexical policy for differently shaped revisions.
        ['2', '10.0', false],
        ['1.0', '1', false],
        ['release-2', 'release-10', false],
    ];

    test.each(data)('compare revisions %s -> %s', (current, latest, hasUpdate) => {
        expect(compareRevisions(current, latest)).toStrictEqual(hasUpdate);
    });
});
