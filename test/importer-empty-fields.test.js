/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

test('empty-field JSON fast path preserves quoting and bounded-cache behavior', () => {
    execFileSync(process.execPath, [
        '--test',
        fileURLToPath(new URL('./util/importer-empty-fields-cases.js', import.meta.url)),
    ], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {...process.env, MANABITAN_IMPORTER_SOURCE: fileURLToPath(new URL('../ext/js/dictionary/dictionary-importer.js', import.meta.url))},
    })
})
