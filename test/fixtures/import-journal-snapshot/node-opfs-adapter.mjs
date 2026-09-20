/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
// Test boundary adapter only: commit-on-close OPFS semantics over real temporary files.
// Not a browser OPFS implementation or performance-equivalent storage backend.
import {mkdir, mkdtemp, readFile, writeFile, readdir, rm, stat, rename} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export async function createNodeOpfs({terminalWriteErrors = false, invalidateSnapshots = false} = {}) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'manabitan-opfs-'))
    const operations = []
    const hooks = {
        beforeGetFileHandle: null,
        beforeRemove: null,
        beforeGetDirectory: null,
        beforeAbort: null,
        beforeClose: null,
        beforeSeek: null,
        beforeWrite: null,
        beforeGetFile: null,
        beforeTruncate: null,
        beforeCreateWritable: null,
        afterCreateWritable: null,
    }
    let serial = 0
    const versions = new Map()
    const changed = (location) => versions.set(location, (versions.get(location) ?? 0) + 1)
    const snapshot = (bytes, name, location) => {
        const file = new File([bytes], name)
        if (!invalidateSnapshots) {
            return file
        }
        const version = versions.get(location) ?? 0
        const check = () => {
            if ((versions.get(location) ?? 0) !== version) {
                throw new DOMException('The file snapshot changed or was removed', 'NotReadableError')
            }
        }
        const read = file.arrayBuffer.bind(file)
        const slice = file.slice.bind(file)
        Object.defineProperty(file, 'arrayBuffer', {
            value: async () => {
                check()
                return read()
            },
        })
        Object.defineProperty(file, 'slice', {
            value: (...args) => {
                const blob = slice(...args)
                const readBlob = blob.arrayBuffer.bind(blob)
                Object.defineProperty(blob, 'arrayBuffer', {
                    value: async () => {
                        check()
                        return readBlob()
                    },
                })
                return blob
            },
        })
        return file
    }
    const missing = () => new DOMException('File not found', 'NotFoundError')
    class Directory {
        constructor(location) {
            this.location = location
            this.kind = 'directory'
            this.name = path.basename(location)
        }

        async getDirectoryHandle(name, options = {}) {
            await hooks.beforeGetDirectory?.(name)
            const location = path.join(this.location, name)
            try {
                if (!(await stat(location)).isDirectory()) {
                    throw new DOMException('Not a directory', 'TypeMismatchError')
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error
                }
                if (!options.create) {
                    throw missing()
                }
                await mkdir(location)
            }
            return new Directory(location)
        }

        async getFileHandle(name, options = {}) {
            await hooks.beforeGetFileHandle?.(name, options)
            if (typeof name !== 'string' || /[/\\]/.test(name) || !name) {
                throw new TypeError('Invalid filename')
            }
            const location = path.join(this.location, name)
            try {
                if (!(await stat(location)).isFile()) {
                    throw new DOMException('Not a file', 'TypeMismatchError')
                }
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error
                }
                if (!options.create) {
                    throw missing()
                }
                await writeFile(location, new Uint8Array())
                changed(location)
                operations.push({type: 'create', name})
            }
            return new Handle(location)
        }

        async removeEntry(name, options = {}) {
            await hooks.beforeRemove?.(name)
            operations.push({type: 'remove', name})
            try {
                await rm(path.join(this.location, name), {recursive: options.recursive ?? false})
                changed(path.join(this.location, name))
            } catch (error) {
                if (error.code === 'ENOENT') {
                    throw missing()
                }
                throw error
            }
        }

        async *entries() {
            for (const entry of await readdir(this.location, {withFileTypes: true})) {
                if (entry.name.startsWith('.temporary-')) {
                    continue
                }
                yield [entry.name, entry.isDirectory() ? new Directory(path.join(this.location, entry.name)) : new Handle(path.join(this.location, entry.name))]
            }
        }
    }
    class Handle {
        constructor(location) {
            this.location = location
            this.kind = 'file'
            this.name = path.basename(location)
        }

        async getFile() {
            await hooks.beforeGetFile?.(this.name)
            try {
                return snapshot(await readFile(this.location), this.name, this.location)
            } catch (error) {
                if (error.code === 'ENOENT') {
                    throw missing()
                }
                throw error
            }
        }

        async createWritable({keepExistingData = false} = {}) {
            await hooks.beforeCreateWritable?.(this.name)
            operations.push({type: 'writable', name: this.name})
            let bytes = keepExistingData ? new Uint8Array(await readFile(this.location)) : new Uint8Array()
            let cursor = 0
            let closed = false
            const check = () => {
                if (closed) {
                    throw new DOMException('Closed', 'InvalidStateError')
                }
            }
            const name = this.name
            const location = this.location
            const stream = {
                async seek(offset) {
                    check()
                    await hooks.beforeSeek?.(name, offset)
                    cursor = offset
                    operations.push({type: 'seek', name, offset})
                },
                async truncate(size) {
                    check()
                    await hooks.beforeTruncate?.(name, size)
                    operations.push({type: 'truncate', name, size, previousSize: bytes.length})
                    const next = new Uint8Array(size)
                    next.set(bytes.subarray(0, size))
                    bytes = next
                    cursor = Math.min(cursor, size)
                },
                async write(value) {
                    check()
                    await hooks.beforeWrite?.(name, value)
                    if (value?.type === 'write') {
                        if (value.position !== undefined) {
                            cursor = value.position
                        }
                        value = value.data
                    }
                    if (value instanceof Blob) {
                        value = new Uint8Array(await value.arrayBuffer())
                    } else if (typeof value === 'string') {
                        value = new TextEncoder().encode(value)
                    } else if (value instanceof ArrayBuffer) {
                        value = new Uint8Array(value)
                    } else {
                        value = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                    }
                    const next = new Uint8Array(Math.max(bytes.length, cursor + value.length))
                    next.set(bytes)
                    next.set(value, cursor)
                    bytes = next
                    cursor += value.length
                    operations.push({type: 'write', name, length: value.length})
                },
                async close() {
                    check()
                    await hooks.beforeClose?.(name)
                    const temporary = path.join(path.dirname(location), `.temporary-${++serial}`)
                    await writeFile(temporary, bytes)
                    await rename(temporary, location)
                    changed(location)
                    closed = true
                    operations.push({type: 'close', name, length: bytes.length})
                },
                async abort() {
                    await hooks.beforeAbort?.(name)
                    closed = true
                    operations.push({type: 'abort', name})
                },
            }
            if (terminalWriteErrors) {
                // Model the stream retaining its first write/seek/truncate/close
                // rejection. This still is not a native WritableStream queue.
                let terminalError = null
                for (const action of ['write', 'seek', 'truncate', 'close']) {
                    const original = stream[action]
                    stream[action] = async (...args) => {
                        if (terminalError !== null) {
                            throw terminalError
                        }
                        try {
                            return await original(...args)
                        } catch (error) {
                            terminalError = error
                            throw error
                        }
                    }
                }
            }
            await hooks.afterCreateWritable?.(name, stream)
            return stream
        }
    }
    return {root: new Directory(rootPath), rootPath, operations, hooks, dispose: () => rm(rootPath, {recursive: true, force: true})}
}
