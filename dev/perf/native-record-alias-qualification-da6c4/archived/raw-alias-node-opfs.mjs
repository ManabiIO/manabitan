// Research transport only. Real Node files, lazy File snapshots and explicit
// writer ownership for the unchanged dictionary stores. Not a browser emulator.
// Lazy File/Blob subclasses have empty native Blob backing. Only their public
// slice/arrayBuffer/text/stream methods are supported: native Blob construction
// from these views, native cloning and structured cloning of them are unsupported.
import {Blob, File} from 'node:buffer';
import {createHash, randomUUID} from 'node:crypto';
import {openSync, closeSync, readSync, writeSync, ftruncateSync, fsyncSync, fstatSync, unlinkSync, mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {open, stat, lstat, mkdir, mkdtemp, readdir, rm, rename, copyFile, rmdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const handles = new WeakMap();
const SNAPSHOT_CHUNK_BYTES = 64 * 1024;

function error(name, message) { return new DOMException(message, name); }
function position(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) { throw new RangeError(label + ' must be a nonnegative safe integer'); }
    return value;
}
function namePart(value) {
    if (typeof value !== 'string' || value === '' || value === '.' || value === '..' || /[\\/\0]/u.test(value)) {
        throw new TypeError('Invalid OPFS entry name');
    }
    return value;
}
function within(root, location) {
    const relative = path.relative(root, location);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new TypeError('File handle escapes its OPFS root');
    }
    return relative;
}
function bytes(value) {
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) { return new Uint8Array(value.buffer, value.byteOffset, value.byteLength); }
    throw new TypeError('Expected a binary buffer');
}
function integer(value) {
    const number = Number(value);
    if (Number.isNaN(number) || number === 0) { return 0; }
    return Number.isFinite(number) ? Math.trunc(number) : number;
}
function sliceBounds(size, start = 0, end = size) {
    const first = integer(start);
    const last = integer(end);
    const from = first < 0 ? Math.max(size + first, 0) : Math.min(first, size);
    const to = last < 0 ? Math.max(size + last, 0) : Math.min(last, size);
    return {from, length: Math.max(to - from, 0)};
}
function mimeType(value) {
    const text = String(value ?? '');
    return /[^\u0020-\u007e]/u.test(text) ? '' : text.toLowerCase();
}
function sameSnapshot(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
        left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function record(context, operation) { context.operations.push(operation); }
function lockPath(context, location) {
    return path.join(context.lockRoot, createHash('sha256').update(location).digest('hex') + '.lock');
}
function acquireLock(context, location) {
    const locationLock = lockPath(context, location);
    let descriptor;
    try { descriptor = openSync(locationLock, 'wx', 0o600); } catch (cause) {
        if (cause?.code === 'EEXIST') { throw error('NoModificationAllowedError', 'Exclusive OPFS writer already holds ' + location); }
        throw cause;
    }
    try {
        const identityBytes = new TextEncoder().encode(JSON.stringify({path: location, owner: randomUUID()}));
        let written = 0;
        while (written < identityBytes.byteLength) {
            const count = writeSync(descriptor, identityBytes, written, identityBytes.byteLength - written, written);
            if (count <= 0) { throw new Error('OPFS lock identity write made no progress'); }
            written += count;
        }
    } catch (cause) {
        try { closeSync(descriptor); } finally { unlinkSync(locationLock); }
        throw cause;
    }
    let released = false;
    return () => {
        if (released) { return; }
        released = true;
        const failures = [];
        try { closeSync(descriptor); } catch (cause) { failures.push(cause); }
        try { unlinkSync(locationLock); } catch (cause) { failures.push(cause); }
        if (failures.length === 1) { throw failures[0]; }
        if (failures.length > 1) { throw new AggregateError(failures, 'Failed to release OPFS writer lock'); }
    };
}
function assertNoDescendantLocks(context, location) {
    for (const entry of readdirSync(context.lockRoot)) {
        if (!entry.endsWith('.lock')) { continue; }
        let owner;
        try { owner = JSON.parse(readFileSync(path.join(context.lockRoot, entry), 'utf8')); } catch (cause) {
            if (cause?.code === 'ENOENT') { continue; }
            throw cause;
        }
        if (owner.path === location || owner.path.startsWith(location + path.sep)) {
            throw error('NoModificationAllowedError', 'An OPFS descendant writer is still open');
        }
    }
}
async function ensureKind(location, kind, create) {
    if (create) {
        if (kind === 'directory') {
            try { await mkdir(location); } catch (cause) { if (cause?.code !== 'EEXIST') { throw cause; } }
        } else {
            try { const file = await open(location, 'wx'); await file.close(); } catch (cause) {
                if (cause?.code !== 'EEXIST') { throw cause; }
            }
        }
    }
    let information;
    try { information = await lstat(location); } catch (cause) {
        if (cause?.code === 'ENOENT') { throw error('NotFoundError', 'OPFS entry does not exist: ' + location); }
        throw cause;
    }
    if (information.isSymbolicLink() || (kind === 'file' ? !information.isFile() : !information.isDirectory())) {
        throw error('TypeMismatchError', 'OPFS entry has an unexpected type');
    }
}
async function readRange(context, location, snapshot, offset, length) {
    record(context, {type: 'logical-read', path: location, offset, length});
    if (length === 0) { return new ArrayBuffer(0); }
    let file;
    try { file = await open(location, 'r'); } catch (cause) {
        if (cause?.code === 'ENOENT') { throw error('NotReadableError', 'The File snapshot no longer exists'); }
        throw cause;
    }
    record(context, {type: 'read-open', path: location});
    try {
        if (!sameSnapshot(snapshot, await file.stat({bigint: true}))) {
            throw error('NotReadableError', 'The File snapshot changed before its read');
        }
        const result = new Uint8Array(length);
        let completed = 0;
        while (completed < length) {
            const {bytesRead} = await file.read(result, completed, length - completed, offset + completed);
            record(context, {type: 'read-call', path: location, offset: offset + completed, requested: length - completed, bytes: bytesRead});
            if (bytesRead === 0) { throw error('NotReadableError', 'The File snapshot ended during its read'); }
            completed += bytesRead;
        }
        if (!sameSnapshot(snapshot, await file.stat({bigint: true}))) {
            throw error('NotReadableError', 'The File snapshot changed during its read');
        }
        return result.buffer;
    } finally {
        await file.close();
        record(context, {type: 'read-close', path: location});
    }
}
function streamOf(value) {
    let offset = 0;
    return new ReadableStream({
        async pull(controller) {
            if (offset >= value.size) { controller.close(); return; }
            const end = Math.min(value.size, offset + SNAPSHOT_CHUNK_BYTES);
            const part = new Uint8Array(await value.slice(offset, end).arrayBuffer());
            offset = end;
            controller.enqueue(part);
        },
    });
}
class LazyBlob extends Blob {
    constructor(context, location, snapshot, offset, length, type = '') {
        super([], {type});
        this._context = context;
        this._location = location;
        this._snapshot = snapshot;
        this._offset = offset;
        this._length = length;
    }
    get size() { return this._length; }
    slice(start = 0, end = this.size, type = '') {
        const range = sliceBounds(this.size, start, end);
        return new LazyBlob(this._context, this._location, this._snapshot, this._offset + range.from, range.length, mimeType(type));
    }
    async arrayBuffer() { return await readRange(this._context, this._location, this._snapshot, this._offset, this.size); }
    async bytes() { return new Uint8Array(await this.arrayBuffer()); }
    async text() { return new TextDecoder().decode(await this.arrayBuffer()); }
    stream() { return streamOf(this); }
}
class LazyFile extends File {
    constructor(context, location, snapshot) {
        super([], path.basename(location), {lastModified: Number(snapshot.mtimeNs) / 1e6});
        this._context = context;
        this._location = location;
        this._snapshot = snapshot;
        this._length = Number(snapshot.size);
        position(this._length, 'File size');
    }
    get size() { return this._length; }
    slice(start = 0, end = this.size, type = '') {
        const range = sliceBounds(this.size, start, end);
        return new LazyBlob(this._context, this._location, this._snapshot, range.from, range.length, mimeType(type));
    }
    async arrayBuffer() { return await readRange(this._context, this._location, this._snapshot, 0, this.size); }
    async bytes() { return new Uint8Array(await this.arrayBuffer()); }
    async text() { return new TextDecoder().decode(await this.arrayBuffer()); }
    stream() { return streamOf(this); }
}

async function writable(context, location, options = {}) {
    await ensureKind(location, 'file', false);
    const release = acquireLock(context, location);
    const temporary = path.join(context.stagingRoot, randomUUID() + '.write');
    let descriptor;
    try {
        if (options.keepExistingData === true) {
            const logicalBytes = (await stat(location)).size;
            await copyFile(location, temporary);
            record(context, {type: 'staging-copy', path: location, logicalBytes});
            descriptor = await open(temporary, 'r+');
        } else {
            descriptor = await open(temporary, 'wx');
        }
    } catch (cause) {
        await rm(temporary, {force: true});
        release();
        throw cause;
    }
    let cursor = 0;
    let state = 'open';
    let failure = null;
    let queue = Promise.resolve();
    let finalPromise = null;
    let descriptorClosed = false;
    const closeDescriptor = async () => {
        if (descriptorClosed) { return; }
        descriptorClosed = true;
        await descriptor.close();
    };
    const enqueue = (operation) => {
        if (state !== 'open') { return Promise.reject(error('InvalidStateError', 'OPFS writable is not open')); }
        const current = queue.then(async () => {
            if (failure !== null) { throw failure; }
            return await operation();
        });
        queue = current.then(() => {}, (cause) => { failure ??= cause; });
        return current;
    };
    const seek = (offset) => enqueue(async () => { cursor = position(offset, 'Seek position'); });
    const truncate = (size) => enqueue(async () => {
        position(size, 'Truncate size');
        await descriptor.truncate(size);
        cursor = Math.min(cursor, size);
        record(context, {type: 'writable-truncate', path: location, size});
    });
    const writeData = async (data, at) => {
        let input;
        if (typeof data === 'string') { input = new TextEncoder().encode(data); }
        else if (data instanceof Blob) { input = new Uint8Array(await data.arrayBuffer()); }
        else { input = bytes(data); }
        if (typeof at !== 'undefined') { cursor = position(at, 'Write position'); }
        if (!Number.isSafeInteger(cursor + input.byteLength)) { throw new RangeError('Write end exceeds safe integer range'); }
        record(context, {type: 'logical-write', path: location, offset: cursor, length: input.byteLength});
        let written = 0;
        while (written < input.byteLength) {
            const {bytesWritten} = await descriptor.write(input, written, input.byteLength - written, cursor);
            record(context, {type: 'write-call', path: location, offset: cursor, requested: input.byteLength - written, bytes: bytesWritten});
            if (bytesWritten <= 0) { throw new Error('OPFS write made no progress'); }
            written += bytesWritten;
            cursor += bytesWritten;
        }
    };
    const write = (data) => enqueue(async () => {
        if (data !== null && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !(data instanceof Blob) && Object.hasOwn(data, 'type')) {
            if (data.type === 'seek') { cursor = position(data.position, 'Seek position'); return; }
            if (data.type === 'truncate') {
                const size = position(data.size, 'Truncate size');
                await descriptor.truncate(size);
                cursor = Math.min(cursor, size);
                record(context, {type: 'writable-truncate', path: location, size});
                return;
            }
            if (data.type !== 'write') { throw new TypeError('Unknown OPFS write operation'); }
            await writeData(data.data, data.position);
        } else { await writeData(data); }
    });
    const resource = {
        seek, truncate, write,
        close() {
            if (finalPromise !== null) { return finalPromise; }
            state = 'closing';
            finalPromise = (async () => {
                const failures = [];
                try {
                    await queue;
                    if (failure !== null) { throw failure; }
                    await descriptor.sync();
                    record(context, {type: 'writable-flush', path: location});
                    await closeDescriptor();
                    await rename(temporary, location);
                    record(context, {type: 'writable-commit', path: location});
                } catch (cause) { failures.push(cause); }
                try { await closeDescriptor(); } catch (cause) { failures.push(cause); }
                try { await rm(temporary, {force: true}); } catch (cause) { failures.push(cause); }
                try { release(); } catch (cause) { failures.push(cause); }
                state = 'closed';
                context.resources.delete(resource);
                if (failures.length === 1) { throw failures[0]; }
                if (failures.length > 1) { throw new AggregateError(failures, 'OPFS writable close failed'); }
            })();
            return finalPromise;
        },
        abort() {
            if (finalPromise !== null) { return finalPromise; }
            state = 'aborting';
            finalPromise = (async () => {
                await queue;
                const failures = [];
                try { await closeDescriptor(); } catch (cause) { failures.push(cause); }
                try { await rm(temporary, {force: true}); } catch (cause) { failures.push(cause); }
                try { release(); } catch (cause) { failures.push(cause); }
                state = 'closed';
                context.resources.delete(resource);
                record(context, {type: 'writable-abort', path: location});
                if (failures.length === 1) { throw failures[0]; }
                if (failures.length > 1) { throw new AggregateError(failures, 'OPFS writable abort failed'); }
            })();
            return finalPromise;
        },
    };
    context.resources.add(resource);
    record(context, {type: 'writable-open', path: location, keepExistingData: options.keepExistingData === true});
    return resource;
}
function syncAccess(context, location) {
    const release = acquireLock(context, location);
    let descriptor;
    try { descriptor = openSync(location, 'r+'); } catch (cause) { release(); throw cause; }
    let closed = false;
    const check = () => { if (closed) { throw error('InvalidStateError', 'OPFS synchronous handle is closed'); } };
    const resource = {
        read(destination, {at = 0} = {}) {
            check(); position(at, 'Read position');
            const target = bytes(destination);
            const count = readSync(descriptor, target, 0, target.byteLength, at);
            record(context, {type: 'sync-read-call', path: location, offset: at, requested: target.byteLength, bytes: count});
            return count;
        },
        write(source, {at = 0} = {}) {
            check(); position(at, 'Write position');
            const input = bytes(source);
            if (!Number.isSafeInteger(at + input.byteLength)) { throw new RangeError('Write end exceeds safe integer range'); }
            const count = writeSync(descriptor, input, 0, input.byteLength, at);
            record(context, {type: 'sync-write-call', path: location, offset: at, requested: input.byteLength, bytes: count});
            return count;
        },
        getSize() { check(); return position(fstatSync(descriptor).size, 'File size'); },
        truncate(size) {
            check(); position(size, 'Truncate size'); ftruncateSync(descriptor, size);
            record(context, {type: 'sync-truncate', path: location, size});
        },
        flush() { check(); fsyncSync(descriptor); record(context, {type: 'sync-flush', path: location}); },
        close() {
            if (closed) { return; }
            closed = true;
            const failures = [];
            try { closeSync(descriptor); } catch (cause) { failures.push(cause); }
            try { release(); } catch (cause) { failures.push(cause); }
            context.resources.delete(resource);
            record(context, {type: 'sync-close', path: location});
            if (failures.length === 1) { throw failures[0]; }
            if (failures.length > 1) { throw new AggregateError(failures, 'OPFS synchronous close failed'); }
        },
    };
    context.resources.add(resource);
    record(context, {type: 'sync-open', path: location});
    return resource;
}
function fileHandle(context, location) {
    within(context.rootPath, location);
    const handle = {
        kind: 'file',
        name: path.basename(location),
        async getFile() {
            let snapshot;
            try { snapshot = await stat(location, {bigint: true}); } catch (cause) {
                if (cause?.code === 'ENOENT') { throw error('NotFoundError', 'OPFS file no longer exists'); }
                throw cause;
            }
            if (!snapshot.isFile()) { throw error('TypeMismatchError', 'OPFS handle is not a file'); }
            record(context, {type: 'file-snapshot', path: location, size: Number(snapshot.size)});
            return new LazyFile(context, location, snapshot);
        },
        async createWritable(options) { return await writable(context, location, options); },
        async createSyncAccessHandle() { return syncAccess(context, location); },
        async isSameEntry(other) { return handles.get(other)?.location === location; },
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
    };
    handles.set(handle, {context, location});
    return handle;
}
function directoryHandle(context, location) {
    within(context.rootPath, location);
    const handle = {
        kind: 'directory',
        name: path.basename(location),
        async getFileHandle(name, {create = false} = {}) {
            const target = path.join(location, namePart(name));
            await ensureKind(target, 'file', create);
            return fileHandle(context, target);
        },
        async getDirectoryHandle(name, {create = false} = {}) {
            const target = path.join(location, namePart(name));
            await ensureKind(target, 'directory', create);
            return directoryHandle(context, target);
        },
        async removeEntry(name, {recursive = false} = {}) {
            const target = path.join(location, namePart(name));
            let information;
            try { information = await lstat(target); } catch (cause) {
                if (cause?.code === 'ENOENT') { throw error('NotFoundError', 'OPFS entry no longer exists'); }
                throw cause;
            }
            if (information.isDirectory()) {
                assertNoDescendantLocks(context, target);
                if (recursive) { await rm(target, {recursive: true, force: false}); }
                else { await rmdir(target); }
            } else {
                const release = acquireLock(context, target);
                try { await rm(target, {force: false}); } finally { release(); }
            }
            record(context, {type: 'remove-entry', path: target, recursive});
        },
        async *entries() {
            for (const entry of (await readdir(location, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
                if (entry.isSymbolicLink()) { throw error('TypeMismatchError', 'OPFS symbolic links are unsupported'); }
                yield [entry.name, entry.isDirectory() ? directoryHandle(context, path.join(location, entry.name)) : fileHandle(context, path.join(location, entry.name))];
            }
        },
        async *values() { for await (const [, value] of handle.entries()) { yield value; } },
        async *keys() { for await (const [key] of handle.entries()) { yield key; } },
        async resolve(possibleDescendant) {
            const other = handles.get(possibleDescendant);
            if (!other || other.context.rootPath !== context.rootPath) { return null; }
            const relative = path.relative(location, other.location);
            return relative === '' ? [] : (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ? null : relative.split(path.sep));
        },
        async isSameEntry(other) { return handles.get(other)?.location === location; },
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
    };
    handle[Symbol.asyncIterator] = handle.entries;
    handles.set(handle, {context, location});
    return handle;
}
async function contextFor(rootPath, operations = []) {
    const absolute = path.resolve(rootPath);
    const identity = createHash('sha256').update(absolute).digest('hex');
    const lockRoot = path.join(os.tmpdir(), 'manabitan-node-opfs-locks-' + identity);
    const stagingRoot = absolute + '.staging';
    mkdirSync(lockRoot, {recursive: true});
    await mkdir(stagingRoot, {recursive: true});
    return {rootPath: absolute, lockRoot, stagingRoot, operations, resources: new Set()};
}
export async function createNodeOpfs({rootPath, create = true, operations = []} = {}) {
    const ownRoot = typeof rootPath === 'undefined';
    const location = ownRoot ? await mkdtemp(path.join(os.tmpdir(), 'manabitan-node-opfs-')) : path.resolve(rootPath);
    if (create) { await mkdir(location, {recursive: true}); }
    await ensureKind(location, 'directory', false);
    const context = await contextFor(location, operations);
    let disposed = false;
    return {
        root: directoryHandle(context, location),
        rootPath: location,
        operations,
        get openResourceCount() { return context.resources.size; },
        async dispose({remove = ownRoot} = {}) {
            if (disposed) { return; }
            disposed = true;
            const failures = [];
            for (const resource of [...context.resources]) {
                try { await (typeof resource.abort === 'function' ? resource.abort() : resource.close()); } catch (cause) { failures.push(cause); }
            }
            if (remove) {
                try { assertNoDescendantLocks(context, location); await rm(location, {recursive: true, force: true}); } catch (cause) { failures.push(cause); }
            }
            try { await rmdir(context.stagingRoot); } catch (cause) { if (cause?.code !== 'ENOENT' && cause?.code !== 'ENOTEMPTY') { failures.push(cause); } }
            try { await rmdir(context.lockRoot); } catch (cause) { if (cause?.code !== 'ENOENT' && cause?.code !== 'ENOTEMPTY') { failures.push(cause); } }
            if (failures.length === 1) { throw failures[0]; }
            if (failures.length > 1) { throw new AggregateError(failures, 'OPFS adapter disposal failed'); }
        },
    };
}
export function describeFileHandle(handle) {
    const identity = handles.get(handle);
    if (!identity || handle.kind !== 'file') { throw new TypeError('Only adapter file handles can be described'); }
    return {nodeOpfsFile: 1, rootPath: identity.context.rootPath, path: identity.location};
}
export async function reviveFileHandle(descriptor, {operations = []} = {}) {
    if (descriptor?.nodeOpfsFile !== 1 || typeof descriptor.rootPath !== 'string' || typeof descriptor.path !== 'string') {
        throw new TypeError('Invalid Node OPFS file descriptor');
    }
    if (!path.isAbsolute(descriptor.rootPath) || !path.isAbsolute(descriptor.path)) {
        throw new TypeError('Node OPFS descriptors require absolute paths');
    }
    const rootPath = path.resolve(descriptor.rootPath);
    const location = path.resolve(descriptor.path);
    const relative = within(rootPath, location);
    if (relative === '') { throw new TypeError('A file descriptor cannot describe the root directory'); }
    await ensureKind(rootPath, 'directory', false);
    let parent = rootPath;
    for (const part of relative.split(path.sep).slice(0, -1)) {
        parent = path.join(parent, part);
        await ensureKind(parent, 'directory', false);
    }
    await ensureKind(location, 'file', false);
    return fileHandle(await contextFor(rootPath, operations), location);
}
export function getNodeOpfsOperations(handle) {
    const identity = handles.get(handle);
    if (!identity) { throw new TypeError('Unknown OPFS handle'); }
    return identity.context.operations;
}

/**
 * Read-only success gate after all parent and worker writers have settled.
 * The caller must finalize/terminate worker owners before this assertion.
 * Unlike dispose(), this refuses orphan staging files or surviving worker locks.
 */
export async function assertNodeOpfsQuiescent(filesystemOrHandle) {
    const handle = filesystemOrHandle?.root ?? filesystemOrHandle;
    const identity = handles.get(handle);
    if (!identity) { throw new TypeError('Unknown OPFS root or handle'); }
    const context = identity.context;
    const entries = async (directory) => {
        try { return (await readdir(directory)).sort(); } catch (cause) {
            if (cause?.code === 'ENOENT') { return []; }
            throw cause;
        }
    };
    const [lockEntries, stagingEntries] = await Promise.all([entries(context.lockRoot), entries(context.stagingRoot)]);
    const receipt = {
        rootPath: context.rootPath,
        parentOpenResources: context.resources.size,
        lockDirectory: context.lockRoot,
        stagingDirectory: context.stagingRoot,
        lockEntries,
        stagingEntries,
    };
    if (receipt.parentOpenResources !== 0 || lockEntries.length !== 0 || stagingEntries.length !== 0) {
        const failure = new Error('Node OPFS adapter has not reached post-finalization quiescence');
        failure.receipt = receipt;
        throw failure;
    }
    return receipt;
}
