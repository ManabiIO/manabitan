/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {build} from 'esbuild'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {describe, expect, test} from 'vitest'
import {zipChunkStreamPlugin} from '../dev/zip-chunk-stream-plugin.js'

describe('ZIP splitter build integration', () => {
    test.each(['zip.js', 'z-worker.js'])('patches only the pinned codec in %s', async (entry) => {
        const result = await build({
            entryPoints: [`dev/lib/${entry}`], bundle: true, format: 'esm', write: false,
            plugins: [zipChunkStreamPlugin],
        })
        expect(result.outputFiles[0].text).toContain('ZIP chunk size must be a positive safe integer')
        expect(result.outputFiles[0].text).toContain('Redistribution and use in source and binary forms')
        expect(result.outputFiles[0].text).not.toContain('transform(chunk.slice(chunkSize), controller)')
    })

    test('fails closed on a changed dependency source', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'manabitan-zip-'))
        try {
            const fixture = path.join(temporary, '@zip.js/zip.js/lib/core/streams/codec-stream.js')
            await mkdir(path.dirname(fixture), {recursive: true})
            const original = await readFile('node_modules/@zip.js/zip.js/lib/core/streams/codec-stream.js', 'utf8')
            await writeFile(fixture, `${original}\n`)
            await expect(build({entryPoints: [fixture], bundle: true, write: false, logLevel: 'silent', plugins: [zipChunkStreamPlugin]}))
                .rejects.toThrow('zip.js codec-stream source changed')
        } finally {
            await rm(temporary, {recursive: true, force: true})
        }
    })
})
