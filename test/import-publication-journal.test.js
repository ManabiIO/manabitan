/* SPDX-License-Identifier: GPL-3.0-or-later */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

for (const [name, script, model] of [
    ['publication acknowledgement', 'import-publication', ''],
    ['journal snapshot with terminal errors', 'import-journal-snapshot', 'terminal'],
    ['journal snapshot with operation errors', 'import-journal-snapshot', 'injection-only'],
]) {
    test(name, () => {
        const fixture = fileURLToPath(new URL(`fixtures/${script}/check.mjs`, import.meta.url));
        expect(() => execFileSync(process.execPath, [fixture, process.cwd(), '', model].filter((_, index) => index < 3 || model !== ''), {
            timeout: 60000,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
        })).not.toThrow();
    }, 90000);
}
