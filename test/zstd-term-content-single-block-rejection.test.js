/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {execFileSync} from 'node:child_process';
import {describe, expect, test} from 'vitest';

const moduleUrl = new URL('../ext/js/dictionary/zstd-term-content.js', import.meta.url).href;

describe('single-block compression failure handling', () => {
    test.each(['beginCompressWrappedTermContentZstdSpansBatch', 'compressWrappedTermContentZstdSpansBatch'])(
        '%s does not leave an unhandled source-consumed rejection',
        (method) => {
            // An isolated process keeps module initialization state deterministic
            // and makes an unhandled sibling rejection a real process failure.
            const script = `
                import assert from 'node:assert/strict';
                const module = await import(${JSON.stringify(moduleUrl)});
                const result = module[${JSON.stringify(method)}](
                    new Uint8Array(new SharedArrayBuffer(4)),
                    Uint32Array.of(0), Uint32Array.of(4),
                    Uint32Array.of(0, 1), Uint32Array.of(4), 'jmdict',
                );
                const completion = result.completion ?? result;
                await assert.rejects(completion, /dictionary is unavailable/);
                await new Promise((resolve) => { setImmediate(resolve); });
                console.log('handled');
            `;
            expect(execFileSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
                encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
            }).trim()).toBe('handled');
        },
    );
});
