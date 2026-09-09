/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

// Observe the browser's real memory classification. Never override navigator.
const server = createServer((_request, response) => {
    response.writeHead(200, {
        'Content-Type': 'text/html',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    response.end('<!doctype html><title>Runtime policy check</title>');
});
await new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (address === null || typeof address === 'string') { throw new Error('Missing preflight server address'); }
const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    const observed = await page.evaluate(async () => {
        const url = URL.createObjectURL(new Blob([
            'postMessage({deviceMemory:navigator.deviceMemory,cores:navigator.hardwareConcurrency})',
        ], {type: 'text/javascript'}));
        const worker = new Worker(url);
        try {
            const data = await new Promise(/** @param {(value: {deviceMemory?: number, cores?: number}) => void} resolve */ (resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Policy worker did not respond')), 10000);
                worker.onmessage = (event) => { clearTimeout(timeout); resolve(event.data); };
                worker.onerror = () => { clearTimeout(timeout); reject(new Error('Policy worker failed')); };
            });
            return {pageMemory: Reflect.get(navigator, 'deviceMemory'), worker: data,
                crossOriginIsolated, userAgent: navigator.userAgent};
        } finally {
            worker.terminate();
            URL.revokeObjectURL(url);
        }
    });
    const result = {...observed, browserVersion: browser.version()};
    await writeFile(process.argv[2], JSON.stringify(result, null, 2));
    if (![result.pageMemory, result.worker.deviceMemory].every((value) => typeof value === 'number' && value > 0 && value <= 4)) {
        throw new Error('Real page and worker did not select low-memory policy');
    }
} finally {
    await browser.close();
    await new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => server.close(() => resolve()));
}
