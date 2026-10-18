/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('shared glossary references reject unsafe number ranges', () => {
    execFileSync(process.execPath, [
        '--test',
        fileURLToPath(new URL('util/raw-term-content-shared-glossary-cases.js', import.meta.url)),
    ], {encoding: 'utf8', timeout: 30_000})
})
