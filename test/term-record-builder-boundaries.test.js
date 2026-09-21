/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('preinterned record builder rejects invalid IDs before narrowing', () => {
    execFileSync(process.execPath, [
        '--test',
        fileURLToPath(new URL('util/term-record-builder-boundary-cases.js', import.meta.url)),
    ], {encoding: 'utf8', timeout: 30_000})
})
