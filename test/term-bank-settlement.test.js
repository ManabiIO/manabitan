/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('native parallel parser stops storage admission after failure or cancellation', () => {
    execFileSync(process.execPath, [fileURLToPath(new URL('fixtures/parser-settlement/check.mjs', import.meta.url))], {
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: 'pipe',
    })
}, 65_000)
