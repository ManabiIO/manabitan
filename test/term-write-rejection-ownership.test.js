/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';

const run = promisify(execFile);
const probe = fileURLToPath(new URL('fixtures/term-write-rejection-probe.js', import.meta.url));

describe('queued OPFS write rejection ownership', () => {
    test.each(['content', 'record'])('owns %s failures before finalization without suppressing them', async (kind) => {
        const {stdout} = await run(process.execPath, [probe, kind], {timeout: 10000});
        expect(JSON.parse(stdout)).toEqual({unhandled: 0, propagated: true});
    });
});
