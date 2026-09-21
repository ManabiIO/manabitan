/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('preinterned compaction preserves exact bytes while coalescing adjacent spans', () => {
    execFileSync(process.execPath, [
        '--test',
        fileURLToPath(new URL('util/preinterned-copy-cases.js', import.meta.url)),
    ], {encoding: 'utf8', timeout: 30_000})
})
