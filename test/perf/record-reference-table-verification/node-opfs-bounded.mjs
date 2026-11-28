// Census-only OPFS boundary. Staging files preserve commit-on-close behavior
// without retaining/recopying whole writable files in the Node JavaScript heap.
// No sync-access API is exposed: the production writer fallback stays unchanged.
import {openAsBlob} from 'node:fs';
import {copyFile, link, mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function createBoundedNodeOpfs() {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'manabitan-opfs-bounded-'));
    const rootPath = path.join(temporaryRoot, 'files');
    const snapshotsPath = path.join(temporaryRoot, 'snapshots');
    await mkdir(rootPath);
    await mkdir(snapshotsPath);
    const operations = [];
    const hooks = {beforeWrite: null,
        beforeGetFile: null,
        beforeTruncate: null,
        beforeCreateWritable: null,
        afterCreateWritable: null};
    const openStreams = new Set();
    let serial = 0;
    const missing = () => new DOMException('File not found', 'NotFoundError');
    const validName = (name) => {
        if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
        name.includes('/') || name.includes('\\') || name.includes('\0')) {
            throw new TypeError('Invalid filename');
        }
    };
    const validPosition = (value) => {
        if (!Number.isSafeInteger(value) || value < 0) { throw new TypeError('Invalid file position'); }
    };

    class Directory {
        constructor(location) {
            this.location = location;
            this.kind = 'directory';
            this.name = path.basename(location);
        }

        async getDirectoryHandle(name, options = {}) {
            validName(name);
            const location = path.join(this.location, name);
            try {
                if (!(await stat(location)).isDirectory()) { throw new DOMException('Not a directory', 'TypeMismatchError'); }
            } catch (error) {
                if (error.code !== 'ENOENT') { throw error; }
                if (!options.create) { throw missing(); }
                await mkdir(location);
            }
            return new Directory(location);
        }

        async getFileHandle(name, options = {}) {
            validName(name);
            const location = path.join(this.location, name);
            try {
                if (!(await stat(location)).isFile()) { throw new DOMException('Not a file', 'TypeMismatchError'); }
            } catch (error) {
                if (error.code !== 'ENOENT') { throw error; }
                if (!options.create) { throw missing(); }
                await writeFile(location, new Uint8Array(), {flag: 'wx'});
                operations.push({type: 'create', name});
            }
            return new Handle(location);
        }

        async removeEntry(name, options = {}) {
            validName(name);
            operations.push({type: 'remove', name});
            try {
                await rm(path.join(this.location, name), {recursive: options.recursive ?? false});
            } catch (error) {
                if (error.code === 'ENOENT') { throw missing(); }
                throw error;
            }
        }

        async *entries() {
            for (const entry of await readdir(this.location, {withFileTypes: true})) {
                if (entry.name.startsWith('.temporary-')) { continue; }
                const location = path.join(this.location, entry.name);
                yield [entry.name, entry.isDirectory() ? new Directory(location) : new Handle(location)];
            }
        }
    }

    class Handle {
        constructor(location) {
            this.location = location;
            this.kind = 'file';
            this.name = path.basename(location);
        }

        async getFile() {
            await hooks.beforeGetFile?.(this.name);
            try {
                // Node's lazy Blob verifies its pathname on reads. Keep a
                // private hard link to the immutable published inode so later
                // atomic replacements cannot invalidate an existing snapshot.
                // Links share data; all snapshot lifetimes end at env.dispose.
                // They live outside the visible OPFS root and final size oracle.
                const snapshot = path.join(snapshotsPath, `snapshot-${++serial}`);
                await link(this.location, snapshot);
                const info = await stat(snapshot);
                const file = await openAsBlob(snapshot);
                Object.defineProperty(file, 'name', {value: this.name});
                Object.defineProperty(file, 'lastModified', {value: info.mtimeMs});
                return file;
            } catch (error) {
                if (error.code === 'ENOENT') { throw missing(); }
                throw error;
            }
        }

        async createWritable({keepExistingData = false} = {}) {
            await hooks.beforeCreateWritable?.(this.name);
            operations.push({type: 'writable', name: this.name});
            const location = this.location;
            const name = this.name;
            const temporary = path.join(path.dirname(location), `.temporary-${++serial}`);
            if (keepExistingData) { await copyFile(location, temporary); }
            let handle = await open(temporary, keepExistingData ? 'r+' : 'wx+');
            let size = keepExistingData ? (await handle.stat()).size : 0;
            let cursor = 0;
            let closed = false;
            const check = () => {
                if (closed) { throw new DOMException('Closed', 'InvalidStateError'); }
            };
            async function writeBytes(bytes) {
                let offset = 0;
                while (offset < bytes.byteLength) {
                    const {bytesWritten} = await handle.write(bytes, offset, bytes.byteLength - offset, cursor);
                    if (bytesWritten <= 0) { throw new Error('File write made no progress'); }
                    offset += bytesWritten;
                    cursor += bytesWritten;
                }
                size = Math.max(size, cursor);
            }
            const stream = {
                async seek(offset) {
                    check();
                    validPosition(offset);
                    cursor = offset;
                },
                async truncate(nextSize) {
                    check(); validPosition(nextSize);
                    await hooks.beforeTruncate?.(name, nextSize);
                    operations.push({type: 'truncate', name, size: nextSize, previousSize: size});
                    await handle.truncate(nextSize);
                    size = nextSize;
                    cursor = Math.min(cursor, size);
                },
                async write(value) {
                    check();
                    await hooks.beforeWrite?.(name, value);
                    if (value?.type === 'write') {
                        if (typeof value.position !== 'undefined') {
                            validPosition(value.position);
                            cursor = value.position;
                        }
                        value = value.data;
                    }
                    let length;
                    if (value instanceof Blob) {
                        length = value.size;
                        for await (const bytes of value.stream()) { await writeBytes(bytes); }
                    } else {
                        let bytes;
                        if (typeof value === 'string') {
                            bytes = new TextEncoder().encode(value);
                        } else if (value instanceof ArrayBuffer) {
                            bytes = new Uint8Array(value);
                        } else if (ArrayBuffer.isView(value)) {
                            bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                        } else {
                            throw new TypeError('Unsupported writable input');
                        }
                        length = bytes.byteLength;
                        await writeBytes(bytes);
                    }
                    operations.push({type: 'write', name, length});
                },
                async close() {
                    check();
                    await handle.sync();
                    await handle.close();
                    handle = null;
                    await rename(temporary, location);
                    closed = true;
                    openStreams.delete(stream);
                    operations.push({type: 'close', name, length: size});
                },
                async abort() {
                    if (closed) { return; }
                    await handle?.close();
                    handle = null;
                    await rm(temporary, {force: true});
                    closed = true;
                    openStreams.delete(stream);
                    operations.push({type: 'abort', name});
                },
            };
            openStreams.add(stream);
            try {
                await hooks.afterCreateWritable?.(name, stream);
            } catch (error) {
                await stream.abort();
                throw error;
            }
            return stream;
        }
    }
    return {root: new Directory(rootPath),
        rootPath,
        temporaryRoot,
        operations,
        hooks,
        dispose: async () => {
            const outcomes = await Promise.allSettled([...openStreams].map((stream) => stream.abort()));
            await rm(temporaryRoot, {recursive: true, force: true});
            const failures = outcomes.filter((value) => value.status === 'rejected').map((value) => value.reason);
            if (failures.length > 0) { throw new AggregateError(failures, 'Bounded adapter cleanup failed'); }
        }};
}
