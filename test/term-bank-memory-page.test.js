/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, expect, test} from 'vitest';
import {moveFixtureToTrash} from './util/move-fixture-to-trash.js';
import {findCompiler} from './util/wasm-compiler.js';

/** @typedef {{memory: WebAssembly.Memory, ensure_memory_probe: (required: number, pages: number, growResult: number) => number, growth_calls: () => number, growth_pages: () => number}} Exports */
/** @type {Exports} */
let wasm;
/** @type {string|undefined} */
let outputDirectory;

beforeAll(async () => {
    outputDirectory = mkdtempSync(path.join(realpathSync(tmpdir()), 'manabitan-term-bank-memory-'));
    const compiler = findCompiler(outputDirectory);
    const source = readFileSync(new URL('../ext/js/dictionary/wasm/term-bank-parser.c', import.meta.url), 'utf8');
    // Compile the actual allocator with controlled memory builtins. The real
    // test module stays small; no test reserves or grows a 4 GiB heap.
    const wrapper = `#include <stdint.h>
static uint32_t mock_pages, mock_growth_calls, mock_growth_pages;
static int32_t mock_growth_result;
static int32_t mock_memory_grow(uint32_t pages) {
    ++mock_growth_calls; mock_growth_pages = pages; return mock_growth_result;
}
#define __builtin_wasm_memory_size(index) mock_pages
#define __builtin_wasm_memory_grow(index, pages) mock_memory_grow(pages)
${source}
uint32_t ensure_memory_probe(uint32_t required, uint32_t pages, int32_t grow_result) {
    mock_pages = pages; mock_growth_calls = 0; mock_growth_pages = 0;
    mock_growth_result = grow_result; return ensure_memory(required);
}
uint32_t growth_calls(void) { return mock_growth_calls; }
uint32_t growth_pages(void) { return mock_growth_pages; }
`;
    const outputPath = path.join(outputDirectory, 'memory-page-test.wasm');
    execFileSync(compiler.command, [...compiler.args,
        '--target=wasm32-freestanding',
        '-O3',
        '-matomics',
        '-mbulk-memory',
        '-msimd128',
        '-nostdlib',
        '-Wl,--no-entry',
        '-Wl,--shared-memory',
        '-Wl,--max-memory=4294967296',
        '-Wl,--export=ensure_memory_probe',
        '-Wl,--export=growth_calls',
        '-Wl,--export=growth_pages',
        '-Wl,--strip-all',
        '-x',
        'c',
        '-',
        '-o',
        outputPath], {input: wrapper, stdio: ['pipe', 'pipe', 'pipe']});
    const module = await WebAssembly.compile(readFileSync(outputPath));
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    wasm = /** @type {Exports} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(module)).exports));
});

afterAll(() => {
    if (!outputDirectory || !existsSync(outputDirectory)) { return; }
    const trashDirectory = path.join(process.env.HOME ?? tmpdir(), '.Trash');
    mkdirSync(trashDirectory, {recursive: true});
    let destination = path.join(trashDirectory, `manabitan-term-bank-memory-${Date.now()}-${process.pid}`);
    while (existsSync(destination)) { destination += '-1'; }
    moveFixtureToTrash(outputDirectory, destination);
});

test.each([
    {required: 0, pages: 0, growth: 0},
    {required: 1, pages: 0, growth: 1},
    {required: 65535, pages: 1, growth: 0},
    {required: 65536, pages: 1, growth: 0},
    {required: 65537, pages: 1, growth: 1},
    {required: 131072, pages: 1, growth: 1},
    {required: 131073, pages: 1, growth: 2},
    {required: 0xfffeffff, pages: 65535, growth: 0},
    {required: 0xffff0000, pages: 65535, growth: 0},
    {required: 0xffff0001, pages: 65535, growth: 1},
    {required: 0xffffffff, pages: 65535, growth: 1},
    {required: 0xffffffff, pages: 0, growth: 65536},
    {required: 1, pages: 65536, growth: 0},
    {required: 65537, pages: 65536, growth: 0},
    {required: 0xffffffff, pages: 65536, growth: 0},
])('uses page counts at required=$required, existing pages=$pages', ({required, pages, growth}) => {
    const initialBytes = wasm.memory.buffer.byteLength;
    expect(wasm.ensure_memory_probe(required, pages, pages)).toBe(1);
    expect(wasm.growth_calls()).toBe(growth > 0 ? 1 : 0);
    expect(wasm.growth_pages()).toBe(growth);
    expect(wasm.memory.buffer.byteLength).toBe(initialBytes);
    expect(initialBytes).toBeLessThan(1024 * 1024);
});

test('reports real growth failure without changing the required page count', () => {
    expect(wasm.ensure_memory_probe(0xffffffff, 65535, -1)).toBe(0);
    expect(wasm.growth_calls()).toBe(1);
    expect(wasm.growth_pages()).toBe(1);
});

test('allocations within a full wasm32 heap never ask the maxed memory to grow', () => {
    expect(wasm.ensure_memory_probe(65537, 65536, -1)).toBe(1);
    expect(wasm.growth_calls()).toBe(0);
});
