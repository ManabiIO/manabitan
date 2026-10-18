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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const ZSTD_REPOSITORY = 'https://github.com/facebook/zstd.git';
const ZSTD_COMMIT = '82d322c4973d9e2968d94047a40892bc6d9a9bdf';
const EXPORTED_FUNCTIONS = [
    '_ZSTD_isError',
    '_ZSTD_compressBound',
    '_ZSTD_createCCtx',
    '_ZSTD_freeCCtx',
    '_ZSTD_compress_usingDict',
    '_ZSTD_compress',
    '_ZSTD_createDCtx',
    '_ZSTD_freeDCtx',
    '_ZSTD_getFrameContentSize',
    '_ZSTD_decompress_usingDict',
    '_ZSTD_decompress',
    '_manabitan_write_block_envelope',
    '_malloc',
    '_free',
];

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '../..');
const outputJs = path.join(projectRoot, 'dev/lib/zstd-simd-module.js');
const outputWasm = path.join(projectRoot, 'dev/data/zstd-simd.wasm');
const {values: {write, keepTemp}} = parseArgs({
    options: {
        write: {type: 'boolean', default: false},
        keepTemp: {type: 'boolean', default: false},
    },
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manabitan-zstd-wasm-'));
const sourceRoot = path.join(tempRoot, 'zstd');
const generatedJs = path.join(tempRoot, 'zstd-simd-module.js');
const generatedWasm = path.join(tempRoot, 'zstd-simd-module.wasm');
const blockEnvelopeSource = path.join(projectRoot, 'dev/data/zstd-block-envelope.c');

try {
    run('git', ['init', '--quiet', sourceRoot]);
    run('git', ['-C', sourceRoot, 'remote', 'add', 'origin', ZSTD_REPOSITORY]);
    run('git', ['-C', sourceRoot, 'fetch', '--quiet', '--depth=1', 'origin', ZSTD_COMMIT]);
    run('git', ['-C', sourceRoot, 'checkout', '--quiet', 'FETCH_HEAD']);

    const singleFileRoot = path.join(sourceRoot, 'build/single_file_libs');
    run('./create_single_file_library.sh', [], {cwd: singleFileRoot});
    run('emcc', [
        path.join(singleFileRoot, 'zstd.c'),
        blockEnvelopeSource,
        '-O3',
        '-flto',
        '-msimd128',
        '-o',
        generatedJs,
        '-s',
        `EXPORTED_FUNCTIONS=${JSON.stringify(EXPORTED_FUNCTIONS)}`,
        '-s',
        'EXPORTED_RUNTIME_METHODS=["HEAPU8"]',
        '-s',
        'FILESYSTEM=0',
        '-s',
        'ALLOW_MEMORY_GROWTH=1',
        '-s',
        'MODULARIZE=1',
        '-s',
        'EXPORT_ES6=1',
        '-s',
        'EXPORT_NAME=createZstdModule',
        '-s',
        'ENVIRONMENT=web,worker',
    ]);

    if (write) {
        fs.copyFileSync(generatedJs, outputJs);
        fs.copyFileSync(generatedWasm, outputWasm);
        process.stdout.write(`Updated Zstd WASM assets (${digest(generatedWasm)}).\n`);
    } else {
        verifyEqual(generatedJs, outputJs);
        verifyEqual(generatedWasm, outputWasm);
        process.stdout.write(`Zstd WASM assets are reproducible (${digest(generatedWasm)}).\n`);
    }
} finally {
    if (keepTemp) {
        process.stdout.write(`Kept build directory: ${tempRoot}\n`);
    } else {
        moveToTrash(tempRoot);
    }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string}} [options]
 * @throws {Error} When the command cannot be run or exits unsuccessfully.
 */
function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) { return; }
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        .trim()
        .split(/\r?\n/)
        .slice(-30)
        .join('\n');
    throw new Error(`${command} failed with status ${String(result.status)}${output.length > 0 ? `:\n${output}` : ''}`);
}

/**
 * @param {string} generated
 * @param {string} expected
 * @throws {Error} When the generated and checked-in files differ.
 */
function verifyEqual(generated, expected) {
    if (!fs.existsSync(expected) || !fs.readFileSync(generated).equals(fs.readFileSync(expected))) {
        throw new Error(
            `Generated ${path.basename(expected)} does not match the checked-in asset ` +
            `(generated=${digest(generated)}, checked-in=${fs.existsSync(expected) ? digest(expected) : 'missing'}). ` +
            'Run this command with --write only after reviewing the toolchain or source change.',
        );
    }
}

/**
 * @param {string} fileName
 * @returns {string}
 */
function digest(fileName) {
    return crypto.createHash('sha256').update(fs.readFileSync(fileName)).digest('hex');
}

/** @param {string} directory */
function moveToTrash(directory) {
    const trashRoot = path.join(os.homedir(), '.Trash');
    const destination = path.join(trashRoot, `${path.basename(directory)}-${Date.now().toString(36)}`);
    try {
        fs.renameSync(directory, destination);
    } catch (error) {
        process.stderr.write(`Unable to move temporary build directory to Trash; kept ${directory}: ${String(error)}\n`);
    }
}
