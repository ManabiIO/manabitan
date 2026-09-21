/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('resolved media reaches serialized native-import row content', () => {
    execFileSync(process.execPath, [fileURLToPath(new URL('fixtures/media-row-publication/check.mjs', import.meta.url))], {
        stdio: 'pipe',
        timeout: 120000,
    })
}, 125000)
