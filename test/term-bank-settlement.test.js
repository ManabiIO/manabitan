/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {mkdtempSync, realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'vitest'

test.each([false, true])('native parser stops storage admission after failure or cancellation (reference=%s)', (reference) => {
    const output = join(realpathSync(mkdtempSync(join(tmpdir(), 'parser-settlement-'))), 'report.json')
    try {
        execFileSync(process.execPath, [fileURLToPath(new URL('fixtures/parser-settlement/check.mjs', import.meta.url)), output], {
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024,
            stdio: 'pipe',
            env: {...process.env, MANABITAN_SETTLEMENT_REFERENCE: reference ? '1' : '0'},
        })
    } catch (error) {
        throw new Error(`${String(error)}; fixture report: ${output}`, {cause: error})
    }
}, 65_000)
