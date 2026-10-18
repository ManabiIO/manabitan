/* SPDX-License-Identifier: GPL-3.0-or-later */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

for (const model of ['terminal', 'injection-only']) {
    test(`journal snapshot with ${model} errors`, () => {
        const fixture = fileURLToPath(new URL('fixtures/import-journal-snapshot/check.mjs', import.meta.url));
        expect(() => execFileSync(process.execPath, [fixture, process.cwd(), '', model], {
            timeout: 60000,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
        })).not.toThrow();
    }, 90000);
}
