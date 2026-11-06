/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test, vi} from 'vitest';
import {TemplateRendererProxy} from '../ext/js/templates/template-renderer-proxy.js';

describe('TemplateRendererProxy frame-load recovery', () => {
    test.each(['Timeout', 'Failed to initialize frame URL'])('retries after %s and coalesces concurrent callers', async (message) => {
        const loadFrame = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValue(void 0);
        const result = [{result: {result: 'healthy', requirements: []}}];
        const invoke = vi.fn().mockResolvedValue(result);
        const proxy = /** @type {TemplateRendererProxy} */ (Object.assign(Object.create(TemplateRendererProxy.prototype), {
            _frame: {},
            _frameNeedsLoad: true,
            _frameLoading: false,
            _frameLoadPromise: null,
            _frameUrl: 'test-frame',
            _loadFrame: loadFrame,
            _invoke: invoke,
        }));

        const failed = await Promise.allSettled([proxy.renderMulti([]), proxy.renderMulti([])]);
        expect(failed.map(({status}) => status)).toEqual(['rejected', 'rejected']);
        expect(loadFrame).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalled();
        expect(Reflect.get(proxy, '_frameLoading')).toBe(false);

        const healthy = await Promise.all([proxy.renderMulti([]), proxy.renderMulti([])]);
        expect(healthy).toEqual([result, result]);
        expect(loadFrame).toHaveBeenCalledTimes(2);
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(Reflect.get(proxy, '_frameNeedsLoad')).toBe(false);
        await expect(proxy.renderMulti([])).resolves.toEqual(result);
        expect(loadFrame).toHaveBeenCalledTimes(2);
    });
    test('an old failed load cannot clear a retry started in the next microtask', async () => {
        /** @type {(reason: unknown) => void} */
        let rejectFirst = () => {};
        /** @type {() => void} */
        let resolveSecond = () => {};
        const firstLoad = new Promise((_resolve, reject) => { rejectFirst = reject; });
        const secondLoad = new Promise((resolve) => { resolveSecond = () => resolve(void 0); });
        const loadFrame = vi.fn().mockReturnValueOnce(firstLoad).mockReturnValueOnce(secondLoad);
        const invoke = vi.fn().mockResolvedValue([]);
        const proxy = /** @type {TemplateRendererProxy} */ (Object.assign(Object.create(TemplateRendererProxy.prototype), {
            _frame: {},
            _frameNeedsLoad: true,
            _frameLoading: false,
            _frameLoadPromise: null,
            _frameUrl: 'test-frame',
            _invocations: new Set(),
            _loadFrame: loadFrame,
            _invoke: invoke,
        }));
        /** @type {Promise<unknown>|null} */
        let retry = null;
        void firstLoad.catch(() => {
            queueMicrotask(() => {
                retry = proxy.renderMulti([]);
                void retry.catch(() => {});
            });
        });
        const initial = proxy.renderMulti([]);
        rejectFirst(new Error('first frame failed'));
        try {
            await Promise.allSettled([initial]);
            expect(loadFrame).toHaveBeenCalledTimes(2);
            expect(Reflect.get(proxy, '_frameLoading')).toBe(true);
            proxy._onFrameLoad();
            expect(Reflect.get(proxy, '_frameNeedsLoad')).toBe(false);
        } finally {
            resolveSecond();
            if (retry !== null) { await retry; }
        }
    });
});
