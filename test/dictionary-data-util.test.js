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
        ['9007199254740992.999', '9007199254740993.0', true],
        ['9007199254740993.0', '9007199254740992.999', false],
        ['01.0002', '1.2', false],
        ['000.000', '0.0', false],
        ['9'.repeat(400), '1' + '0'.repeat(400), true],
        ['1' + '0'.repeat(400), '9'.repeat(400), false],
        ['9'.repeat(400) + '.2', '8'.repeat(400) + '.3', false],
        ['1.9', '1.10', true],
        ['1.10', '1.9', false],
        ['1', '1.0', true],
        ['2', '10.0', false],
        ['1.0.0-alpha', '1.0.0-beta', true],
        ['0001\n', '2', true],
    ];

    test.each(data)('compare revisions %s -> %s', (current, latest, hasUpdate) => {
        expect(compareRevisions(current, latest)).toStrictEqual(hasUpdate);
    });
});
