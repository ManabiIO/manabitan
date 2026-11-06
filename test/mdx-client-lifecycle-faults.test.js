/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Mdx} from '../ext/js/comm/mdx.js';
import {log} from '../ext/js/core/log.js';

class ConversionWorker {
    constructor() {
        this.terminate = vi.fn();
        this.postMessage = vi.fn();
        /** @type {Map<string, (event: MessageEvent) => void>} */
        this.listeners = new Map();
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent) => void} listener
     */
    addEventListener(type, listener) { this.listeners.set(type, listener); }

    /** @param {unknown} data */
    emit(data) { this.listeners.get('message')?.(new MessageEvent('message', {data})); }
}

function setup() {
    /** @type {ConversionWorker[]} */
    const workers = [];
    vi.stubGlobal('Worker', vi.fn(function createWorker() {
        const worker = new ConversionWorker();
        workers.push(worker);
        return worker;
    }));
    vi.spyOn(log, 'error').mockImplementation(() => { throw new Error('Logger unavailable'); });
    return {workers, mdx: new Mdx(), file: new File([new Uint8Array([1, 2, 3])], 'test.mdx')};
}

const result = {archiveContent: new ArrayBuffer(3), archiveFileName: 'converted.zip'};
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

test('a worker termination failure cannot strand completed conversion or retained ownership', async () => {
    const {mdx, workers, file} = setup();
    const completed = vi.fn();
    const rejected = vi.fn();
    const pending = mdx.convertDictionary({mdxFile: file}).then(completed, rejected);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0].terminate.mockImplementation(() => { throw new Error('Worker teardown failed'); });
    workers[0].emit({action: 'complete', params: {result}});
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
    expect(mdx.isActive()).toBe(false);
    expect(mdx.isConnected()).toBe(false);
    await pending;
    const next = mdx.convertDictionary({mdxFile: file});
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    workers[1].emit({action: 'complete', params: {result}});
    await expect(next).resolves.toMatchObject(result);
});

test('disconnect rejects the conversion even if worker termination throws', async () => {
    const {mdx, workers, file} = setup();
    const rejected = vi.fn();
    const pending = mdx.convertDictionary({mdxFile: file}).catch(rejected);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0].terminate.mockImplementation(() => { throw new Error('Worker teardown failed'); });
    expect(() => mdx.disconnect()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: 'MDX conversion cancelled'}));
    expect(mdx.isActive()).toBe(false);
    expect(mdx.isConnected()).toBe(false);
    await pending;
});

test.each(['upload', 'convert'])('a throwing %s progress observer cannot abort conversion', async (stage) => {
    const {mdx, workers, file} = setup();
    const pending = mdx.convertDictionary({mdxFile: file}, (details) => {
        if (details.stage === stage) { throw new Error('Detached progress UI'); }
    });
    const observed = pending.catch(() => null);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0].emit({action: 'progress', params: {details: {stage: 'convert', completed: 1, total: 2}}});
    expect(mdx.isActive()).toBe(true);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].emit({action: 'complete', params: {result}});
    await expect(pending).resolves.toMatchObject(result);
    await observed;
});
