/* SPDX-License-Identifier: GPL-3.0-or-later */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

test('serialized web-client deadline regressions', () => {
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('../web/client-deadline-check.mjs', import.meta.url))], {
        encoding: 'utf8',
        timeout: 10000,
    });
    expect(output).toContain('11 cases; 0 failures');
});
