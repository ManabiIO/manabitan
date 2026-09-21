/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {expect, test} from 'vitest'
const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
test('native fused-score parity, including negative zero without another fallback trigger', async () => {
    const {stdout} = await run(process.execPath, ['test/fixtures/fused-score/check.mjs'], {cwd: root, timeout: 60_000, maxBuffer: 2_000_000})
    const report = JSON.parse(stdout)
    expect(report.failed).toBe(0)
    expect(report.passed).toBe(19)
}, 65_000)
test('native parser to file-backed stores, reopen and derived-section repair', async () => {
    const {stdout} = await run(process.execPath, ['test/fixtures/fused-score/persistence-node.mjs'], {cwd: root, timeout: 60_000, maxBuffer: 2_000_000})
    /** @type {{name: string, passed: boolean}[]} */
    const report = JSON.parse(stdout)
    expect(report).toHaveLength(4)
    expect(report.every(({passed}) => passed === true)).toBe(true)
}, 65_000)
