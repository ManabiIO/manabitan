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

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {describe, expect, test} from 'vitest';
import {formatRulesJson, generateRules, getTargets} from '../dev/generate-css-json.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

describe('css-json', () => {
    test.each(getTargets())('css-json-test-%#', ({cssFilePath, overridesCssFilePath, outputPath}) => {
        const actual = fs.readFileSync(outputPath, {encoding: 'utf8'});
        const expected = formatRulesJson(generateRules(cssFilePath, overridesCssFilePath));
        expect(actual).toStrictEqual(expected);
    });

    test('preserves declaration priority while applying selector and removal overrides', () => {
        const cssFilePath = path.join(dirname, 'fixtures/css-json/important.css');
        const overridesCssFilePath = path.join(dirname, 'fixtures/css-json/important-overrides.css');
        expect(generateRules(cssFilePath, overridesCssFilePath)).toStrictEqual([
            {
                selectors: ['.parent', '.child:is(.x, .y)'],
                styles: [['border-color', '#008000 !important'], ['color', '#ffa500 !important']],
            },
        ]);
    });
});
