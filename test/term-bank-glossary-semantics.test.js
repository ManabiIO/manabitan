/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {test} from 'vitest'

for (const fixture of ['check.mjs', 'importer.mjs']) {
    test(`native glossary semantics: ${fixture}`, () => {
        const script = fileURLToPath(new URL(`fixtures/glossary-semantics/${fixture}`, import.meta.url))
        execFileSync(process.execPath, [script, process.cwd()], {stdio: 'pipe', timeout: 60000})
    }, 65000)
}
