/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

test('native MDict key BOM identity regressions', () => {
    const file = fileURLToPath(new URL('util/mdict-key-bom-cases.js', import.meta.url));
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# fail 0\b/u);
}, 35000);
