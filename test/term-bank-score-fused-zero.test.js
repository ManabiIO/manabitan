/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('preserves signed-zero scores through the actual fused parser and fallback', () => {
    execFileSync(process.execPath, [fileURLToPath(new URL('fixtures/fused-score/check.mjs', import.meta.url))], {
        stdio: 'pipe',
        timeout: 120000,
    })
}, 125000)
