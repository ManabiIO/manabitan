/* SPDX-License-Identifier: GPL-3.0-or-later */
// NEW correctness-only adapter. It is not a browser filesystem or a benchmark.
import {
    closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync,
    openAsBlob, openSync, readSync, writeSync
} from 'node:fs'
import {
    copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat
} from 'node:fs/promises'
import {basename, isAbsolute, join, relative, resolve, sep} from 'node:path'
import {randomUUID} from 'node:crypto'
import {File} from 'node:buffer'

const contexts = new Map()
function contextFor(root, staging) {
    const previous = contexts.get(root)
    if (previous) {
        if (previous.staging !== staging) throw new Error('Conflicting adapter context')
        return previous
    }
    const context = {root, staging, locks: new Set()}
    contexts.set(root, context)
    return context
}

function error(name, message) { return new DOMException(message, name) }
function position(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Expected a nonnegative safe integer')
    return value
}
function name(value) {
    if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..' ||
        value.includes('/') || value.includes('\\') || value.includes('\0')) {
        throw new TypeError('Invalid OPFS entry name')
    }
    return value
}
function view(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError('Expected a BufferSource')
}
function translate(cause) {
    if (cause?.code === 'ENOENT') return error('NotFoundError', 'OPFS entry does not exist')
    if (cause?.code === 'ENOTDIR' || cause?.code === 'EISDIR') return error('TypeMismatchError', 'OPFS entry kind differs')
    if (cause?.code === 'ENOTEMPTY') return error('InvalidModificationError', 'OPFS directory is not empty')
    return cause
}
async function kindAt(path) {
    let value
    try { value = await lstat(path) } catch (cause) { throw translate(cause) }
    if (value.isSymbolicLink()) throw error('SecurityError', 'Symbolic links are not OPFS entries')
    if (value.isDirectory()) return 'directory'
    if (value.isFile()) return 'file'
    throw error('SecurityError', 'Unsupported filesystem entry')
}
function assertFileSync(path) {
    const value = lstatSync(path)
    if (value.isSymbolicLink() || !value.isFile()) throw error('SecurityError', 'Expected a regular OPFS file')
}
function acquire(context, path) {
    if (context.locks.has(path)) throw error('NoModificationAllowedError', 'File already has an active writer in this adapter')
    context.locks.add(path)
    return () => { context.locks.delete(path) }
}
async function writeAll(file, bytes, offset) {
    let done = 0
    while (done < bytes.byteLength) {
        const result = await file.write(bytes, done, bytes.byteLength - done, offset + done)
        if (result.bytesWritten <= 0) throw new Error('File write made no progress')
        done += result.bytesWritten
    }
}

export class FileSystemHandle {
    constructor(context, path, kind) {
        this._context = context
        this._path = path
        this.kind = kind
        this.name = path === context.root ? '' : basename(path)
    }
    async isSameEntry(other) {
        return other instanceof FileSystemHandle && this.kind === other.kind && this._path === other._path
    }
    async queryPermission() { return 'granted' }
    async requestPermission() { return 'granted' }
}

export class FileSystemDirectoryHandle extends FileSystemHandle {
    constructor(context, path) { super(context, path, 'directory') }
    async getDirectoryHandle(child, {create = false} = {}) {
        const path = join(this._path, name(child))
        if (create) {
            try { await mkdir(path) } catch (cause) { if (cause?.code !== 'EEXIST') throw translate(cause) }
        }
        if (await kindAt(path) !== 'directory') throw error('TypeMismatchError', 'Expected a directory')
        return new FileSystemDirectoryHandle(this._context, path)
    }
    async getFileHandle(child, {create = false} = {}) {
        const path = join(this._path, name(child))
        if (create) {
            try { const file = await open(path, 'wx'); await file.close() }
            catch (cause) { if (cause?.code !== 'EEXIST') throw translate(cause) }
        }
        if (await kindAt(path) !== 'file') throw error('TypeMismatchError', 'Expected a file')
        return new FileSystemFileHandle(this._context, path)
    }
    async removeEntry(child, {recursive = false} = {}) {
        const path = join(this._path, name(child))
        const kind = await kindAt(path)
        if ([...this._context.locks].some((locked) => locked === path || locked.startsWith(path + sep))) {
            throw error('NoModificationAllowedError', 'Entry contains an active writer')
        }
        try {
            if (kind === 'directory' && !recursive) await rmdir(path)
            else await rm(path, {recursive: kind === 'directory', force: false})
        } catch (cause) { throw translate(cause) }
    }
    async *entries() {
        const children = await readdir(this._path)
        children.sort()
        for (const child of children) {
            const path = join(this._path, name(child))
            const kind = await kindAt(path)
            yield [child, kind === 'directory' ?
                new FileSystemDirectoryHandle(this._context, path) :
                new FileSystemFileHandle(this._context, path)]
        }
    }
    async *keys() { for await (const [key] of this.entries()) yield key }
    async *values() { for await (const [, value] of this.entries()) yield value }
    [Symbol.asyncIterator]() { return this.entries() }
    async resolve(other) {
        if (!(other instanceof FileSystemHandle) || other._context.root !== this._context.root) return null
        const path = relative(this._path, other._path)
        if (path === '') return []
        if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) return null
        return path.split(sep)
    }
}

export class FileSystemFileHandle extends FileSystemHandle {
    constructor(context, path) { super(context, path, 'file') }
    async getFile() {
        if (await kindAt(this._path) !== 'file') throw error('TypeMismatchError', 'Expected a file')
        const details = await stat(this._path)
        const blob = await openAsBlob(this._path)
        // Node Blob composition retains the file-backed Blob without arrayBuffer().
        return new File([blob], this.name, {lastModified: details.mtimeMs})
    }
    async createWritable({keepExistingData = false} = {}) {
        if (await kindAt(this._path) !== 'file') throw error('TypeMismatchError', 'Expected a file')
        const release = acquire(this._context, this._path)
        const temporary = join(this._context.staging, randomUUID())
        let file
        try {
            if (keepExistingData) await copyFile(this._path, temporary, constants.COPYFILE_EXCL)
            file = await open(temporary, keepExistingData ? 'r+' : 'wx+')
        } catch (cause) {
            await rm(temporary, {force: true}).catch(() => {})
            release()
            throw cause
        }
        const thisPath = this._path
        let cursor = 0
        let state = 'open'
        let tail = Promise.resolve()
        const operation = (callback) => {
            if (state !== 'open') return Promise.reject(error('InvalidStateError', 'Writable is closed'))
            const next = tail.then(callback)
            tail = next
            return next
        }
        const writeBytes = async (bytes) => {
            await writeAll(file, bytes, cursor)
            cursor += bytes.byteLength
        }
        const write = (value) => {
            let command = null
            let data = value
            if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value) &&
                !(value instanceof ArrayBuffer) && !(value instanceof Blob)) {
                const type = value.type
                command = type === 'seek' ? {type, position: value.position} :
                    type === 'truncate' ? {type, size: value.size} :
                    type === 'write' ? {type, position: value.position} : {type}
                data = type === 'write' ? value.data : undefined
            }
            let copied = null
            if (command === null || command.type === 'write') {
                if (typeof data === 'string') copied = new TextEncoder().encode(data)
                else if (!(data instanceof Blob)) copied = Uint8Array.from(view(data))
            }
            return operation(async () => {
                if (command?.type === 'seek') { cursor = position(command.position); return }
                if (command?.type === 'truncate') {
                    const size = position(command.size)
                    await file.truncate(size)
                    cursor = Math.min(cursor, size)
                    return
                }
                if (command !== null && command.type !== 'write') throw new TypeError('Unknown write command')
                if (typeof command?.position !== 'undefined') cursor = position(command.position)
                if (copied !== null) await writeBytes(copied)
                else for await (const chunk of data.stream()) await writeBytes(chunk)
            })
        }
        return {
            write,
            seek(offset) { return write({type: 'seek', position: offset}) },
            truncate(size) { return write({type: 'truncate', size}) },
            async close() {
                if (state !== 'open') throw error('InvalidStateError', 'Writable is closed')
                state = 'closing'
                try {
                    await tail
                    await file.sync()
                    await file.close()
                    file = null
                    await rename(temporary, thisPath)
                    state = 'closed'
                } catch (cause) {
                    state = 'failed'
                    if (file !== null) await file.close().catch(() => {})
                    await rm(temporary, {force: true}).catch(() => {})
                    throw cause
                } finally { release() }
            },
            async abort() {
                if (state === 'aborted' || state === 'closed' || state === 'failed') return
                if (state !== 'open') throw error('InvalidStateError', 'Writable is closing')
                state = 'aborted'
                try {
                    await tail.catch(() => {})
                    await file.close()
                    file = null
                    await rm(temporary, {force: true})
                } finally { release() }
            }
        }
    }
    async createSyncAccessHandle() {
        assertFileSync(this._path)
        const release = acquire(this._context, this._path)
        let descriptor
        try { descriptor = openSync(this._path, 'r+') } catch (cause) { release(); throw cause }
        let closed = false
        let cursor = 0
        const check = () => { if (closed) throw error('InvalidStateError', 'Sync handle is closed') }
        return {
            read(value, options = {}) {
                check()
                const bytes = view(value)
                const offset = typeof options.at === 'undefined' ? cursor : position(options.at)
                const count = readSync(descriptor, bytes, 0, bytes.byteLength, offset)
                cursor = offset + count
                return count
            },
            write(value, options = {}) {
                check()
                const bytes = view(value)
                const offset = typeof options.at === 'undefined' ? cursor : position(options.at)
                const count = writeSync(descriptor, bytes, 0, bytes.byteLength, offset)
                cursor = offset + count
                return count
            },
            getSize() { check(); return fstatSync(descriptor).size },
            truncate(size) { check(); ftruncateSync(descriptor, position(size)); cursor = Math.min(cursor, size) },
            flush() { check(); fsyncSync(descriptor) },
            close() {
                if (closed) return
                closed = true
                try { closeSync(descriptor) } finally { release() }
            }
        }
    }
}

export async function createDiskOpfs(directory, {existing = false} = {}) {
    const state = resolve(directory)
    if (!existing) await mkdir(state, {recursive: false})
    else if (await kindAt(state) !== 'directory') throw new Error('Adapter state is not a directory')
    const canonical = await realpath(state)
    if (canonical !== state) throw new Error('Adapter state must use its canonical absolute path')
    const root = join(state, 'root')
    const staging = join(state, 'staging')
    await mkdir(root, {recursive: existing})
    await mkdir(staging, {recursive: existing})
    if (await kindAt(root) !== 'directory' || await kindAt(staging) !== 'directory') throw new Error('Invalid adapter layout')
    const context = contextFor(root, staging)
    return {root: new FileSystemDirectoryHandle(context, root), context, state}
}

export function installDiskOpfs(adapter, {hardwareConcurrency = 4, deviceMemory = 8} = {}) {
    for (const [key, value] of Object.entries({FileSystemHandle, FileSystemDirectoryHandle, FileSystemFileHandle})) {
        Object.defineProperty(globalThis, key, {value, configurable: true, writable: true})
    }
    const navigator = {
        hardwareConcurrency, deviceMemory, userAgent: 'Manabitan correctness-only Node adapter',
        storage: {getDirectory: async () => adapter.root, persisted: async () => true}
    }
    Object.defineProperty(globalThis, 'navigator', {value: navigator, configurable: true})
}

export function exportFileHandle(handle) {
    if (!(handle instanceof FileSystemFileHandle)) throw new TypeError('Expected a disk file handle')
    return {kind: 'manabitan-correctness-file', root: handle._context.root,
        staging: handle._context.staging, relativePath: relative(handle._context.root, handle._path)}
}

export function importFileHandle(token, allowedState) {
    if (token?.kind !== 'manabitan-correctness-file' ||
        token.root !== join(resolve(allowedState), 'root') || token.staging !== join(resolve(allowedState), 'staging')) {
        throw new TypeError('Unexpected file handle token')
    }
    const parts = token.relativePath.split(sep)
    if (parts.length === 0) throw new TypeError('Missing file path')
    for (const part of parts) name(part)
    const path = join(token.root, ...parts)
    let current = token.root
    for (const part of parts) {
        current = join(current, part)
        const details = lstatSync(current)
        if (details.isSymbolicLink()) throw new TypeError('Symbolic link in file token')
    }
    assertFileSync(path)
    return new FileSystemFileHandle(contextFor(token.root, token.staging), path)
}
