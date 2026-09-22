/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('native parser and importer preserve row fields and media identities', () => {
    execFileSync(process.execPath, [fileURLToPath(new URL('fixtures/term-row-materialization/check.mjs', import.meta.url))], {
        stdio: 'pipe',
        timeout: 120000,
    })
}, 125000)
