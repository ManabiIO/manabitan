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

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

// The vendored pako UMD bundle must execute as a native ES module, as it does
// in the extension worker. Vite's injected CommonJS bindings select a different
// UMD branch. Use a native subprocess instead of mocking or replacing the codec.
test('native MDict parser, converter and client lifecycle regressions', () => {
    const files = ['mdict-native-cases.js', 'mdict-client-cases.js']
        .map((name) => fileURLToPath(new URL(`util/${name}`, import.meta.url)));
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# fail 0\b/u);
}, 35000);
