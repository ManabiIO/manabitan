/*
 * Copyright (C) 2023-2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const codecSourceSha256 = '1c0d9de91141bf89f49dc1e239dd22d75a3e46d38dd153aca1a6d48c231d4d85'
const replacementPath = fileURLToPath(new URL('zip-chunk-stream.js', import.meta.url))

/**
 * Replace only the pinned splitter, in both ZIP host and worker bundles.
 * Keep the dependency's codecs and license intact; fail closed on any source
 * change so dependency upgrades require an explicit backport review/removal.
 * @type {import('esbuild').Plugin}
 */
export const zipChunkStreamPlugin = {
    name: 'zip-chunk-stream-backport',
    setup(build) {
        build.onLoad({filter: /[/\\]@zip\.js[/\\]zip\.js[/\\]lib[/\\]core[/\\]streams[/\\]codec-stream\.js$/}, async ({path: sourcePath}) => {
            const source = await readFile(sourcePath, 'utf8')
            if (createHash('sha256').update(source).digest('hex') !== codecSourceSha256) {
                throw new Error('zip.js codec-stream source changed: review/remove the ChunkStream backport before rebuilding')
            }
            const start = source.indexOf('\nclass ChunkStream extends TransformStream {')
            if (start < 0) { throw new Error('zip.js ChunkStream backport anchor missing') }
            return {
                contents: `${source.slice(0, start).replace(/^\/\*/, '/*!')}\nimport {ChunkStream} from ${JSON.stringify(replacementPath)};\n`,
                loader: 'js',
                resolveDir: path.dirname(sourcePath),
                watchFiles: [sourcePath, replacementPath],
            }
        })
    },
}
