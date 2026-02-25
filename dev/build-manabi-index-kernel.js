/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dirname, '..', 'ext', 'lib');
const sourcePath = path.join(dirname, 'wasm', 'manabi-index-kernel.cpp');
const outPath = path.join(outDir, 'manabi-index-kernel.js');

function hasEmcc() {
    const result = spawnSync('emcc', ['--version'], {stdio: 'ignore'});
    return result.status === 0;
}

export function buildManabiIndexKernel() {
    if (!hasEmcc()) {
        console.warn('Skipping manabi-index-kernel.wasm build because emcc is unavailable.');
        return;
    }

    fs.mkdirSync(outDir, {recursive: true});

    const args = [
        sourcePath,
        '-O3',
        '-std=c++20',
        '-s', 'MODULARIZE=1',
        '-s', 'EXPORT_ES6=1',
        '-s', 'ALLOW_MEMORY_GROWTH=1',
        '-s', 'ENVIRONMENT=web,worker',
        '-s', 'EXPORTED_FUNCTIONS=["_manabi_index_create","_manabi_index_destroy","_manabi_index_clear","_manabi_index_add","_manabi_index_might_contain","_manabi_index_query_prefix","_manabi_index_result_ptr","_manabi_index_export","_manabi_index_export_ptr","_manabi_index_import","_malloc","_free"]',
        '-s', 'EXPORTED_RUNTIME_METHODS=["ccall","cwrap"]',
        '-o',
        outPath,
    ];

    const result = spawnSync('emcc', args, {stdio: 'inherit'});
    if (result.status !== 0) {
        throw new Error(`Failed to build manabi-index-kernel.wasm (exit ${result.status ?? 'unknown'})`);
    }
}
