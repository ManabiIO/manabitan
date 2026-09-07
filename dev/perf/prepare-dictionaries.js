#!/usr/bin/env node
/*
 * Copyright (C) 2026  Manabitan authors
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

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensurePinnedDictionaryCache} from './dictionary-fixtures.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const cacheDir = path.join(root, 'builds', 'e2e-dictionary-cache');
const result = await ensurePinnedDictionaryCache(cacheDir);
for (const [id, fixture] of Object.entries(result.fixtures)) {
    console.log(`${id}: ${path.join(cacheDir, fixture.cacheFile)} sha256=${fixture.sha256}`);
}
