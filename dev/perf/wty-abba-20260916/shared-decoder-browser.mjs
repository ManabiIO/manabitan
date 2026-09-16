/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from '@playwright/test'

const root = process.cwd()
const expectFailure = process.argv.includes('--expect-failure')
const server = createServer((request, response) => {
    void (async () => {
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><title>Shared parser decoding regression</title>')
            return
        }
        const filePath = path.resolve(root, `.${decodeURIComponent(pathname)}`)
        if (!filePath.startsWith(`${root}${path.sep}`) || !pathname.startsWith('/ext/')) {
            response.writeHead(404).end()
            return
        }
        response.setHeader('Content-Type', filePath.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        response.end(await readFile(filePath))
    })().catch(() => { response.writeHead(500).end() })
})
await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
assert(address && typeof address === 'object')
const browser = await chromium.launch({headless: true, args: ['--no-sandbox']})
try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}`)
    const result = await page.evaluate(async () => {
        /**
         * @param {unknown} value
         * @param {string} message
         * @returns {asserts value}
         */
        function check(value, message) {
            if (!value) { throw new Error(message) }
        }
        check(globalThis.crossOriginIsolated, 'Test must execute with shared memory enabled')
        const parser = /** @type {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} */ (
            await import('/ext/js/dictionary/term-bank-wasm-parser.js') // eslint-disable-line no-unsanitized/method
        )
        const compiled = await WebAssembly.compile(await (await fetch('/ext/lib/term-bank-parser.wasm')).arrayBuffer())
        const instance = await WebAssembly.instantiate(compiled)
        check(/** @type {WebAssembly.Memory} */ (instance.exports.memory).buffer instanceof SharedArrayBuffer, 'Production parser must use shared WASM memory')
        parser.setTermBankWasmModule(compiled)
        const encoder = new TextEncoder()
        const fixtures = [
            ['plain', 'reading', 'noun', 'rule', 3, ['ordinary glossary'], 2, 'common'],
            ['quote"slash\\', 'line\nbreak', 'tag"quoted', 'r\\ule', -3, ['quotes " and backslash \\'], 8, 'term\ttag'],
            ['日本語😀é', 'にほんご', '名詞', '', 0, [{type: 'structured-content', content: {tag: 'span', content: '意味😀'}}], 9, '一般'],
            ['large', '', '', '', 1, ['x'.repeat(100000)], 11, ''],
        ]
        let checks = 0
        /** @type {number[][]} */
        const retained = []
        for (const sharedInput of [false, true]) {
            const bytes = encoder.encode(JSON.stringify(fixtures))
            const source = sharedInput ? new Uint8Array(new SharedArrayBuffer(bytes.length)) : new Uint8Array(bytes.length)
            source.set(bytes)
            try {
                const decoded = await parser.parseTermBankWithWasm(source, 3)
                check(decoded.length === fixtures.length, 'Wrong decoded row count')
                for (let i = 0; i < fixtures.length; ++i) {
                    const row = decoded[i]
                    const actual = [row.expression, row.reading, row.definitionTags, row.rules, row.score, JSON.parse(row.glossaryJson), row.sequence, row.termTags]
                    check(JSON.stringify(actual) === JSON.stringify(fixtures[i]), `Decoded fields differ for fixture ${i}`)
                    check(row.termEntryContentBytes.buffer instanceof ArrayBuffer, 'Retained content must own non-shared bytes')
                    retained.push([...row.termEntryContentBytes])
                    ++checks
                }
                check(source.every((value, i) => value === bytes[i]), 'Input was mutated')
                ++checks
            } catch (error) {
                if (error instanceof Error && /TextDecoder|ArrayBufferView.*shared|must not be shared/.test(error.message)) {
                    return {status: 'shared-decoder-failure', message: error.message, checks}
                }
                throw error
            }
        }
        let invalidRejected = false
        try {
            await parser.parseTermBankWithWasm(encoder.encode('[["bad"'), 3)
        } catch {
            invalidRejected = true
        }
        check(invalidRejected, 'Malformed JSON must remain rejected')
        const recovered = await parser.parseTermBankWithWasm(encoder.encode(JSON.stringify(fixtures)), 3)
        check(recovered.length === fixtures.length, 'Valid parse did not recover after failure')
        for (let i = 0; i < recovered.length; ++i) {
            check(JSON.stringify([...recovered[i].termEntryContentBytes]) === JSON.stringify(retained[i]), 'Content changed across shared-heap reuse')
        }
        return {status: 'success', checks: checks + 6}
    })
    assert.equal(result.status, expectFailure ? 'shared-decoder-failure' : 'success', JSON.stringify(result))
    console.log(JSON.stringify({browser: browser.version(), expectedFailure: expectFailure, ...result}))
} finally {
    await browser.close()
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error)
                return
            }
            resolve()
        })
    })
}
