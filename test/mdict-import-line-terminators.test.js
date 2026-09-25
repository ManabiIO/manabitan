/*
 * Copyright (C) 2026  Yomitan Authors
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

import {expect, test} from 'vitest';
import * as api from '../ext/js/dictionary/mdict-import-sources.js';
import {createLineTerminatorCases} from './fixtures/mdict-import/line-terminator-cases.js';

const assertions = {
    /**
     * @param {unknown} actual
     * @param {unknown} expected
     */
    equal(actual, expected) { expect(actual).toBe(expected); },
    /**
     * @param {unknown} actual
     * @param {unknown} expected
     */
    deepEqual(actual, expected) { expect(actual).toEqual(expected); },
};
for (const {name, run} of createLineTerminatorCases(api, assertions)) { test(name, run); }
