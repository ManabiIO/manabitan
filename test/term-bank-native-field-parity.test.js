/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('native parser preserves string identity and uint16 byte-length boundaries', () => {
    execFileSync(process.execPath, [
        fileURLToPath(new URL('./fixtures/parser-field-parity/check.mjs', import.meta.url)),
        fileURLToPath(new URL('../', import.meta.url)),
    ], {stdio: 'pipe', timeout: 120000})
}, 130000)
