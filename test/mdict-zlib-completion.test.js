/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {expect, test} from 'vitest'

test('MDict requires actual compressed-stream completion using the vendored codec', () => {
    const path = fileURLToPath(new URL('util/mdict-zlib-completion-cases.js', import.meta.url))
    const result = spawnSync(process.execPath, ['--test', path], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toMatch(/# fail 0\b/u)
})
