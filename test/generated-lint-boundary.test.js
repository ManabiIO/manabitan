/*
 * Copyright (C) 2026 Manabitan authors
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

import {ESLint} from 'eslint';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({cwd: root});

describe('generated Emscripten lint boundary', () => {
    test('excludes only the generated loader, not handwritten wrappers or declarations', async () => {
        expect(await eslint.isPathIgnored(path.join(root, 'dev/lib/zstd-simd-module.js'))).toBe(true);
        for (const name of [
            'dev/lib/zstd-wasm.js',
            'dev/lib/zstd-simd-module.d.ts',
            'dev/bin/build-zstd-wasm.js',
            'ext/js/dictionary/zstd-term-content.js',
            'ext/js/dictionary/term-content-block-store.js',
            'ext/js/dictionary/dictionary-database.js',
        ]) {
            expect(await eslint.isPathIgnored(path.join(root, name)), name).toBe(false);
        }
    }, 30_000);

    test('keeps handwritten dictionary runtime safety rules enabled', async () => {
        const config = await eslint.calculateConfigForFile(path.join(root, 'ext/js/dictionary/dictionary-database.js'));
        for (const rule of ['@typescript-eslint/no-unsafe-assignment', '@typescript-eslint/no-unsafe-argument']) {
            expect(config.rules[rule][0], rule).toBe(2);
        }
    });
});
