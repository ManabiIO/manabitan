/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {mkdtempSync, realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('projected content workers retain borrowed bytes through sink settlement', () => {
    const output = join(realpathSync(mkdtempSync(join(tmpdir(), 'borrowed-content-'))), 'report.json')
    try {
        execFileSync(process.execPath, [fileURLToPath(new URL('fixtures/parser-settlement/borrowed-content.mjs', import.meta.url)), output], {
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024,
            stdio: 'pipe',
        })
    } catch (error) {
        throw new Error(`${String(error)}; fixture report: ${output}`, {cause: error})
    }
}, 65_000)
