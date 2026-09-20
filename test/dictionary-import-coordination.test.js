/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFile} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {expect, test} from 'vitest'

const execFileAsync = promisify(execFile)

test('journal ordering and session callback ownership', async () => {
    const {stdout} = await execFileAsync(process.execPath, [
        '--test',
        '--test-reporter=tap',
        fileURLToPath(new URL('fixtures/import-coordination/reentry.mjs', import.meta.url)),
    ], {timeout: 30000, maxBuffer: 1024 * 1024})
    expect(stdout).toContain('# pass 17')
    expect(stdout).toContain('# fail 0')
}, 60000)
