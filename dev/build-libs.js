/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import esbuild from 'esbuild';
import fs from 'fs';
import {createRequire} from 'module';
import path from 'path';
import {fileURLToPath} from 'url';
import {copyDictionaryWasm} from './dictionary-wasm.js';
import {parseJson} from './json.js';

const require = createRequire(import.meta.url);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(dirname, '..', 'ext');
/**
 * @param {string} out
 */
async function copyWasm(out) {
    // copy from node modules '@resvg/resvg-wasm/index_bg.wasm' to out
    const resvgWasmPath = path.dirname(require.resolve('@resvg/resvg-wasm'));
    const wasmPath = path.join(resvgWasmPath, 'index_bg.wasm');
    fs.copyFileSync(wasmPath, path.join(out, 'resvg.wasm'));
}

/**
 * @param {string} out
 */
async function copySqliteWasm(out) {
    const sqliteWasmPath = path.dirname(require.resolve('@sqlite.org/sqlite-wasm/package.json'));
    const sqliteDistPath = path.join(sqliteWasmPath, 'dist');
    const sqliteOutPath = path.join(out, 'sqlite');
    fs.mkdirSync(sqliteOutPath, {recursive: true});
    for (const fileName of fs.readdirSync(sqliteDistPath)) {
        const source = path.join(sqliteDistPath, fileName);
        const destination = path.join(sqliteOutPath, fileName);
        fs.copyFileSync(source, destination);
    }
}

/**
 * @param {string} out
 */
async function copyZstdAssets(out) {
    const zstdWasmPath = path.join(dirname, 'data', 'zstd-simd.wasm');
    fs.copyFileSync(zstdWasmPath, path.join(out, 'zstd.wasm'));

    const zstdDictOutPath = path.join(out, 'zstd-dicts');
    fs.mkdirSync(zstdDictOutPath, {recursive: true});
    const jmdictDictPath = path.join(dirname, 'data', 'zstd-dicts', 'jmdict.zdict');
    if (!fs.existsSync(jmdictDictPath)) {
        throw new Error(`Missing vendored zstd dictionary asset: ${jmdictDictPath}`);
    }
    fs.copyFileSync(jmdictDictPath, path.join(zstdDictOutPath, 'jmdict.zdict'));
}

/**
 * @param {string} scriptPath
 */
async function buildLib(scriptPath) {
    await esbuild.build({
        entryPoints: [scriptPath],
        bundle: true,
        minify: false,
        sourcemap: true,
        target: 'es2020',
        format: 'esm',
        outfile: path.join(extDir, 'lib', path.basename(scriptPath)),
        external: ['fs'],
        banner: {
            js: '// @ts-nocheck',
        },
    });
}

/**
 * Keep the generated worker beside its source so import.meta.url assets retain
 * their existing locations while startup loads a single module.
 * @returns {Promise<import('esbuild').Metafile>}
 * @throws {Error} The source copyright header is missing.
 */
export async function buildTermBankParserWorker() {
    const root = path.join(dirname, '..');
    const entryPoint = path.join(extDir, 'js/dictionary/term-bank-wasm-parser-worker.js');
    const outputPath = path.join(extDir, 'js/dictionary/term-bank-wasm-parser-worker.bundle.js');
    const result = await esbuild.build({
        absWorkingDir: root,
        entryPoints: [entryPoint],
        bundle: true,
        minify: false,
        sourcemap: false,
        target: 'es2020',
        format: 'esm',
        outfile: outputPath,
        write: false,
        metafile: true,
        banner: {js: '// @ts-nocheck'},
    });
    // Ordinary source headers are removed by bundling. Preserve every input's
    // copyright notice with the worker's complete GPL header in the output.
    const notices = new Set();
    for (const fileName of Object.keys(result.metafile.inputs)) {
        const source = fs.readFileSync(path.resolve(root, fileName), 'utf8');
        for (const notice of source.match(/^ \* Copyright[^\n]*/gm) ?? []) { notices.add(notice); }
    }
    const header = fs.readFileSync(entryPoint, 'utf8').match(/^\/\*[\s\S]*?\*\//)?.[0];
    if (typeof header === 'undefined') { throw new Error('Missing parser worker copyright header'); }
    const banner = header.replace(/^ \* Copyright[^\n]*\n/m, `${[...notices].join('\n')}\n`);
    fs.writeFileSync(outputPath, `${banner}\n${result.outputFiles[0].text}`);
    return result.metafile;
}

/**
 * Bundles libraries.
 */
export async function buildLibs() {
    copyDictionaryWasm(path.join(extDir, 'lib'));
    const devLibPath = path.join(dirname, 'lib');
    const files = await fs.promises.readdir(devLibPath, {
        withFileTypes: true,
    });
    for (const f of files) {
        if (f.isFile()) {
            await buildLib(path.join(devLibPath, f.name));
        }
    }
    await buildTermBankParserWorker();

    const schemaDir = path.join(extDir, 'data/schemas/');
    const schemaFileNames = fs.readdirSync(schemaDir);
    const schemas = schemaFileNames.map((schemaFileName) => {
        /** @type {import('ajv').AnySchema} */
        const result = parseJson(fs.readFileSync(path.join(schemaDir, schemaFileName), {encoding: 'utf8'}));
        return result;
    });
    const ajv = new Ajv({
        schemas,
        code: {source: true, esm: true},
        allowUnionTypes: true,
    });
    const moduleCode = standaloneCode(ajv);

    // https://github.com/ajv-validator/ajv/issues/2209
    const patchedModuleCode = "// @ts-nocheck\nimport {ucs2length} from './ucs2length.js';" + moduleCode.replaceAll('require("ajv/dist/runtime/ucs2length").default', 'ucs2length');

    fs.writeFileSync(path.join(extDir, 'lib/validate-schemas.js'), patchedModuleCode);

    await copyWasm(path.join(extDir, 'lib'));
    await copySqliteWasm(path.join(extDir, 'lib'));
    await copyZstdAssets(path.join(extDir, 'lib'));
}
