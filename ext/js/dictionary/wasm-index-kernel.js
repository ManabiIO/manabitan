/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

let modulePromise = null;

async function loadModule() {
    if (modulePromise !== null) {
        return modulePromise;
    }

    modulePromise = (async () => {
        const {default: createModule} = await import('../../lib/manabi-index-kernel.js');
        const module = await createModule({
            locateFile(path) {
                if (path.endsWith('.wasm')) {
                    return '/lib/manabi-index-kernel.wasm';
                }
                return `/lib/${path}`;
            },
        });
        return module;
    })();

    return modulePromise;
}

function uint8ArrayToBase64(array) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < array.length; i += chunkSize) {
        const chunk = array.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const output = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) {
        output[i] = binary.charCodeAt(i);
    }
    return output;
}

export class WasmPrefixBloomIndex {
    constructor(module, handle) {
        this._module = module;
        this._handle = handle;
    }

    static async create(bitCount = 1 << 22, hashCount = 7) {
        const isBrowserLike = (typeof window !== 'undefined') || (typeof WorkerGlobalScope !== 'undefined');
        if (typeof WebAssembly === 'undefined' || !isBrowserLike) {
            return null;
        }
        try {
            const module = await loadModule();
            const handle = module.ccall('manabi_index_create', 'number', ['number', 'number'], [bitCount, hashCount]);
            if (handle <= 0) {
                return null;
            }
            return new WasmPrefixBloomIndex(module, handle);
        } catch {
            return null;
        }
    }

    clear() {
        this._module.ccall('manabi_index_clear', null, ['number'], [this._handle]);
    }

    add(key, id) {
        if (typeof key !== 'string' || key.length === 0) {
            return;
        }
        this._module.ccall('manabi_index_add', null, ['number', 'string', 'number'], [this._handle, key, id]);
    }

    mightContain(key) {
        if (typeof key !== 'string' || key.length === 0) {
            return false;
        }
        const result = this._module.ccall('manabi_index_might_contain', 'number', ['number', 'string'], [this._handle, key]);
        return result !== 0;
    }

    search(prefix) {
        if (typeof prefix !== 'string' || prefix.length === 0) {
            return [];
        }

        const count = this._module.ccall('manabi_index_query_prefix', 'number', ['number', 'string'], [this._handle, prefix]);
        if (count <= 0) {
            return [];
        }
        const ptr = this._module.ccall('manabi_index_result_ptr', 'number', ['number'], [this._handle]);
        if (ptr <= 0) {
            return [];
        }
        const start = ptr >>> 2;
        return Array.from(this._module.HEAP32.subarray(start, start + count));
    }

    exportState() {
        const size = this._module.ccall('manabi_index_export', 'number', ['number'], [this._handle]);
        if (size <= 0) {
            return null;
        }
        const ptr = this._module.ccall('manabi_index_export_ptr', 'number', ['number'], [this._handle]);
        if (ptr <= 0) {
            return null;
        }

        const data = this._module.HEAPU8.slice(ptr, ptr + size);
        return {
            encoding: 'base64',
            data: uint8ArrayToBase64(data),
        };
    }

    importState(state) {
        if (!state || typeof state !== 'object') {
            return false;
        }
        if (state.encoding !== 'base64' || typeof state.data !== 'string') {
            return false;
        }

        const bytes = base64ToUint8Array(state.data);
        const ptr = this._module._malloc(bytes.length);
        try {
            this._module.HEAPU8.set(bytes, ptr);
            const ok = this._module.ccall('manabi_index_import', 'number', ['number', 'number', 'number'], [this._handle, ptr, bytes.length]);
            return ok !== 0;
        } finally {
            this._module._free(ptr);
        }
    }

    destroy() {
        this._module.ccall('manabi_index_destroy', null, ['number'], [this._handle]);
    }
}
