/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {afterAll, describe, expect, test} from 'vitest';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {TemplateRendererProxy} from '../ext/js/templates/template-renderer-proxy.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();
afterAll(async () => {
    await testEnv.teardown(global);
});

/**
 * @param {{postMessage: (message: unknown, targetOrigin: string) => void}} frameWindow
 * @returns {TemplateRendererProxy}
 */
function createProxy(frameWindow) {
    const proxy = /** @type {TemplateRendererProxy} */ (Object.create(TemplateRendererProxy.prototype));
    Reflect.set(proxy, '_frame', {contentWindow: frameWindow});
    Reflect.set(proxy, '_invocations', new Set());
    return proxy;
}

/**
 * @param {TemplateRendererProxy} proxy
 * @param {unknown} params
 * @param {number|null} [timeout]
 * @returns {Promise<unknown>}
 */
function invoke(proxy, params, timeout = null) {
    return Reflect.get(proxy, '_invoke').call(proxy, 'render', params, timeout);
}

/**
 * @param {unknown} source
 * @param {unknown} data
 */
function dispatchMessage(source, data) {
    const event = new Event('message');
    Object.defineProperty(event, 'source', {value: source});
    Object.defineProperty(event, 'data', {value: data});
    window.dispatchEvent(event);
}

describe('TemplateRendererProxy transport settlement', () => {
    test('cleans up an invocation when postMessage throws synchronously', async () => {
        const frameWindow = {
            postMessage() {
                throw new Error('postMessage failed');
            },
        };
        const proxy = createProxy(frameWindow);

        await expect(invoke(proxy, {}, 1000)).rejects.toThrow('postMessage failed');
        expect(Reflect.get(proxy, '_invocations').size).toBe(0);
    });

    test('rejects a malformed error response instead of accepting it as success', async () => {
        /** @type {unknown} */
        let request;
        const frameWindow = {
            postMessage(message) {
                request = message;
            },
        };
        const proxy = createProxy(frameWindow);
        const promise = invoke(proxy, {}, 1000);
        const id = Reflect.get(/** @type {object} */ (request), 'id');

        dispatchMessage(frameWindow, {
            action: 'response',
            id,
            params: {error: null},
        });

        await expect(promise).rejects.toBeInstanceOf(TypeError);
        expect(Reflect.get(proxy, '_invocations').size).toBe(0);
    });

    test('preserves valid serialized errors', async () => {
        /** @type {unknown} */
        let request;
        const frameWindow = {
            postMessage(message) {
                request = message;
            },
        };
        const proxy = createProxy(frameWindow);
        const promise = invoke(proxy, {}, 1000);
        const id = Reflect.get(/** @type {object} */ (request), 'id');
        const error = new ExtensionError('render failed');
        error.data = {field: 'Front'};

        dispatchMessage(frameWindow, {
            action: 'response',
            id,
            params: {error: ExtensionError.serialize(error)},
        });

        await expect(promise).rejects.toMatchObject({
            name: 'ExtensionError',
            message: 'render failed',
            data: {field: 'Front'},
        });
        expect(Reflect.get(proxy, '_invocations').size).toBe(0);
    });

    test('preserves successful responses', async () => {
        /** @type {unknown} */
        let request;
        const frameWindow = {
            postMessage(message) {
                request = message;
            },
        };
        const proxy = createProxy(frameWindow);
        const promise = invoke(proxy, {}, 1000);
        const id = Reflect.get(/** @type {object} */ (request), 'id');
        const result = {result: 'ok'};

        dispatchMessage(frameWindow, {
            action: 'response',
            id,
            params: {result},
        });

        await expect(promise).resolves.toBe(result);
        expect(Reflect.get(proxy, '_invocations').size).toBe(0);
    });
});
