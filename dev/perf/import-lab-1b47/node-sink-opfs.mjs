/* SPDX-License-Identifier: GPL-3.0-or-later */
// Test boundary only. Real staged files implement async writable semantics.
// This does not model Chromium OPFS sync-access-handle performance or durability.
import {copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join, basename} from 'node:path';
import {tmpdir} from 'node:os';

export async function createNodeOpfs() {
    const rootPath = await mkdtemp(join(tmpdir(), 'manabitan-sink-1b47-'));
    const operations = [];
    let serial = 0;
    const missing = () => new DOMException('File not found', 'NotFoundError');
    const checkedName = (name) => {
        if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') { throw new TypeError('Invalid filename'); }
        return name;
    };
    class Directory {
        constructor(location) { this.location = location; this.kind = 'directory'; this.name = basename(location); }
        async getDirectoryHandle(name, {create = false} = {}) {
            const location = join(this.location, checkedName(name));
            try { if (!(await stat(location)).isDirectory()) { throw new DOMException('Not a directory', 'TypeMismatchError'); } }
            catch (error) { if (error.code !== 'ENOENT') { throw error; } if (!create) { throw missing(); } await mkdir(location); }
            return new Directory(location);
        }
        async getFileHandle(name, {create = false} = {}) {
            const location = join(this.location, checkedName(name));
            try { if (!(await stat(location)).isFile()) { throw new DOMException('Not a file', 'TypeMismatchError'); } }
            catch (error) { if (error.code !== 'ENOENT') { throw error; } if (!create) { throw missing(); } await writeFile(location, new Uint8Array()); operations.push({type: 'create', name}); }
            return new Handle(location);
        }
        async removeEntry(name, {recursive = false} = {}) {
            try { await rm(join(this.location, checkedName(name)), {recursive}); operations.push({type: 'remove', name}); }
            catch (error) { if (error.code === 'ENOENT') { throw missing(); } throw error; }
        }
        async *entries() {
            for (const entry of await readdir(this.location, {withFileTypes: true})) {
                if (entry.name.startsWith('.temporary-')) { continue; }
                const location = join(this.location, entry.name);
                yield [entry.name, entry.isDirectory() ? new Directory(location) : new Handle(location)];
            }
        }
    }
    class Handle {
        constructor(location) { this.location = location; this.kind = 'file'; this.name = basename(location); }
        async getFile() {
            try { return new File([await readFile(this.location)], this.name); }
            catch (error) { if (error.code === 'ENOENT') { throw missing(); } throw error; }
        }
        async createWritable({keepExistingData = false} = {}) {
            const location = this.location;
            const name = this.name;
            const temporary = join(location.slice(0, location.lastIndexOf('/')), `.temporary-${++serial}`);
            if (keepExistingData) { await copyFile(location, temporary); }
            const file = await open(temporary, keepExistingData ? 'r+' : 'w+');
            let position = 0;
            let closed = false;
            const check = () => { if (closed) { throw new DOMException('Closed', 'InvalidStateError'); } };
            operations.push({type: 'writable', name});
            return {
                async seek(value) { check(); position = value; },
                async truncate(size) { check(); await file.truncate(size); position = Math.min(position, size); operations.push({type: 'truncate', name, size}); },
                async write(value) {
                    check();
                    if (value?.type === 'write') { if (value.position !== undefined) { position = value.position; } value = value.data; }
                    if (value instanceof Blob) { value = new Uint8Array(await value.arrayBuffer()); }
                    else if (typeof value === 'string') { value = new TextEncoder().encode(value); }
                    else if (value instanceof ArrayBuffer) { value = new Uint8Array(value); }
                    else { value = new Uint8Array(value.buffer, value.byteOffset, value.byteLength); }
                    const start = performance.now();
                    let offset = 0;
                    while (offset < value.byteLength) {
                        const {bytesWritten} = await file.write(value, offset, value.byteLength - offset, position + offset);
                        if (bytesWritten === 0) { throw new Error('Empty Node storage write'); }
                        offset += bytesWritten;
                    }
                    position += value.byteLength;
                    operations.push({type: 'write', name, length: value.byteLength, elapsedMs: performance.now() - start});
                },
                async close() { check(); await file.close(); await rename(temporary, location); closed = true; operations.push({type: 'close', name}); },
                async abort() { if (closed) { return; } closed = true; await file.close(); await rm(temporary, {force: true}); operations.push({type: 'abort', name}); },
            };
        }
    }
    return {root: new Directory(rootPath), rootPath, operations, dispose: () => rm(rootPath, {recursive: true, force: true})};
}
