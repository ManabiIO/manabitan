/* SPDX-License-Identifier: GPL-3.0-or-later */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

test('maximum-length lookup keys remain encodable and repairable', () => {
    const script = fileURLToPath(new URL('fixtures/opfs-continuation/lookup-long-key.mjs', import.meta.url));
    expect(() => execFileSync(process.execPath, [script, process.cwd()], {
        timeout: 60000,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
    })).not.toThrow();
}, 90000);
