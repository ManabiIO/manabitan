/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {expect, test} from 'vitest'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

test('native score admission matches JSON number grammar on all raw parser routes', async () => {
    const {stdout} = await run(process.execPath, ['test/fixtures/fused-score/grammar.mjs'], {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 2_000_000,
    })
    const report = JSON.parse(stdout)
    expect(report.failed).toBe(0)
    expect(report.total).toBe(80176)
}, 65_000)
