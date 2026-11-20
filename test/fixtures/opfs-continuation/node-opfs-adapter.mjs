/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
// Test boundary adapter only: commit-on-close OPFS semantics over real temporary files.
// Not a browser OPFS implementation or performance-equivalent storage backend.
import {mkdir, mkdtemp, readFile, writeFile, readdir, rm, stat, rename} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** @typedef {Blob|string|ArrayBuffer|ArrayBufferView} NodeOpfsWriteData */
/** @typedef {NodeOpfsWriteData|{type: 'write', position?: number, data: NodeOpfsWriteData}} NodeOpfsWriteValue */
/** @typedef {{seek: (offset: number) => Promise<void>, truncate: (size: number) => Promise<void>, write: (value: NodeOpfsWriteValue) => Promise<void>, close: () => Promise<void>, abort: () => Promise<void>}} NodeOpfsWritable */
/** @typedef {{type: 'create'|'remove'|'writable'|'truncate'|'write'|'close'|'abort', name: string, size?: number, previousSize?: number, length?: number}} NodeOpfsOperation */
/** @typedef {{beforeWrite: ((name: string, value: NodeOpfsWriteValue) => void|Promise<void>)|null, beforeGetFile: ((name: string) => void|Promise<void>)|null, beforeTruncate: ((name: string, size: number) => void|Promise<void>)|null, beforeCreateWritable: ((name: string) => void|Promise<void>)|null, afterCreateWritable: ((name: string, writable: NodeOpfsWritable) => void|Promise<void>)|null}} NodeOpfsHooks */

export async function createNodeOpfs() {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'manabitan-opfs-'))
    /** @type {NodeOpfsOperation[]} */
    const operations = []
    /** @type {NodeOpfsHooks} */
    const hooks = {
        beforeWrite: null,
        beforeGetFile: null,
        beforeTruncate: null,
        beforeCreateWritable: null,
        afterCreateWritable: null,
    }
    let serial = 0
    const missing = () => new DOMException('File not found', 'NotFoundError')

    class Directory {
        /** @param {string} location */
        constructor(location) {
            this.location = location
            this.kind = 'directory'
            this.name = path.basename(location)
        }

        /**
         * @param {string} name
         * @param {{create?: boolean}} [options]
         * @returns {Promise<Directory>}
         */
        async getDirectoryHandle(name, options = {}) {
            const location = path.join(this.location, name)
            try {
                if (!(await stat(location)).isDirectory()) {
                    throw new DOMException('Not a directory', 'TypeMismatchError')
                }
            } catch (error) {
                if ((/** @type {NodeJS.ErrnoException} */ (error)).code !== 'ENOENT') { throw error }
                if (!options.create) { throw missing() }
                await mkdir(location)
            }
            return new Directory(location)
        }

        /**
         * @param {string} name
         * @param {{create?: boolean}} [options]
         * @returns {Promise<Handle>}
         */
        async getFileHandle(name, options = {}) {
            if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || !name) {
                throw new TypeError('Invalid filename')
            }
            const location = path.join(this.location, name)
            try {
                if (!(await stat(location)).isFile()) {
                    throw new DOMException('Not a file', 'TypeMismatchError')
                }
            } catch (error) {
                if ((/** @type {NodeJS.ErrnoException} */ (error)).code !== 'ENOENT') { throw error }
                if (!options.create) { throw missing() }
                await writeFile(location, new Uint8Array())
                operations.push({type: 'create', name})
            }
            return new Handle(location)
        }

        /**
         * @param {string} name
         * @param {{recursive?: boolean}} [options]
         */
        async removeEntry(name, options = {}) {
            operations.push({type: 'remove', name})
            try {
                await rm(path.join(this.location, name), {recursive: options.recursive ?? false})
            } catch (error) {
                if ((/** @type {NodeJS.ErrnoException} */ (error)).code === 'ENOENT') { throw missing() }
                throw error
            }
        }

        /**
         * @returns {AsyncGenerator<[string, Directory|Handle]>}
         * @yields {[string, Directory|Handle]}
         */
        async *entries() {
            for (const entry of await readdir(this.location, {withFileTypes: true})) {
                if (entry.name.startsWith('.temporary-')) { continue }
                const location = path.join(this.location, entry.name)
                yield [entry.name, entry.isDirectory() ? new Directory(location) : new Handle(location)]
            }
        }
    }

    class Handle {
        /** @param {string} location */
        constructor(location) {
            this.location = location
            this.kind = 'file'
            this.name = path.basename(location)
        }

        async getFile() {
            await hooks.beforeGetFile?.(this.name)
            try {
                return new File([await readFile(this.location)], this.name)
            } catch (error) {
                if ((/** @type {NodeJS.ErrnoException} */ (error)).code === 'ENOENT') { throw missing() }
                throw error
            }
        }

        /**
         * @param {{keepExistingData?: boolean}} [options]
         * @returns {Promise<NodeOpfsWritable>}
         */
        async createWritable({keepExistingData = false} = {}) {
            await hooks.beforeCreateWritable?.(this.name)
            operations.push({type: 'writable', name: this.name})
            let bytes = keepExistingData ? new Uint8Array(await readFile(this.location)) : new Uint8Array()
            let cursor = 0
            let closed = false
            const check = () => {
                if (closed) { throw new DOMException('Closed', 'InvalidStateError') }
            }
            const name = this.name
            const location = this.location
            /** @type {NodeOpfsWritable} */
            const stream = {
                async seek(offset) {
                    check()
                    cursor = offset
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
                    if ((/** @type {{type?: string}} */ (value))?.type === 'write') {
                        const command = /** @type {{position?: number, data: NodeOpfsWriteData}} */ (value)
                        if (command.position !== undefined) { cursor = command.position }
                        value = command.data
                    }
                    /** @type {Uint8Array} */
                    let data
                    if (value instanceof Blob) {
                        data = new Uint8Array(await value.arrayBuffer())
                    } else if (typeof value === 'string') {
                        data = new TextEncoder().encode(value)
                    } else if (value instanceof ArrayBuffer) {
                        data = new Uint8Array(value)
                    } else {
                        const view = /** @type {ArrayBufferView} */ (value)
                        data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
                    }
                    const next = new Uint8Array(Math.max(bytes.length, cursor + data.length))
                    next.set(bytes)
                    next.set(data, cursor)
                    bytes = next
                    cursor += data.length
                    operations.push({type: 'write', name, length: data.length})
                },
                async close() {
                    check()
                    const temporary = path.join(path.dirname(location), `.temporary-${++serial}`)
                    await writeFile(temporary, bytes)
                    await rename(temporary, location)
                    closed = true
                    operations.push({type: 'close', name, length: bytes.length})
                },
                async abort() {
                    closed = true
                    operations.push({type: 'abort', name})
                },
            }
            await hooks.afterCreateWritable?.(name, stream)
            return stream
        }
    }

    return {
        root: new Directory(rootPath),
        rootPath,
        operations,
        hooks,
        dispose: () => rm(rootPath, {recursive: true, force: true}),
    }
}
