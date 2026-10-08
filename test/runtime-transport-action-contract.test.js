/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';

/**
 * @param {string} path
 * @returns {string}
 */
function source(path) {
    return readFileSync(new URL(`../ext/js/${path}`, import.meta.url), 'utf8');
}

/**
 * @param {string} value
 * @param {RegExp} expression
 * @returns {Set<string>}
 */
function actionNames(value, expression) {
    return new Set([...value.matchAll(expression)].map((match) => match[1]));
}

/**
 * @param {Set<string>} calls
 * @param {Set<string>} handlers
 * @returns {string[]}
 */
function missingActions(calls, handlers) {
    return [...calls].filter((name) => !handlers.has(name)).sort();
}

describe('runtime transport action contracts', () => {
    const api = source('comm/api.js');
    const backend = source('background/backend.js');
    const proxy = source('background/offscreen-proxy.js');
    const offscreen = source('background/offscreen.js');
    const worker = source('background/offscreen-dictionary-worker.js');

    const registeredNames = (text) => actionNames(text, /\['([^']+)',\s*this\./g);
    const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));

    test('all literal extension API actions have background handlers', () => {
        const calls = actionNames(api, /this\._invoke\('([^']+)'/g);
        const handlers = registeredNames(between(backend, 'this._apiMap =', 'this._pmApiMap ='));
        expect(missingActions(calls, handlers)).toStrictEqual([]);
    });

    test('all literal postMessage API actions have background handlers', () => {
        const calls = actionNames(api, /this\._pmInvoke\('([^']+)'/g);
        const handlers = registeredNames(between(backend, 'this._pmApiMap =', 'this._commandHandlers ='));
        expect(missingActions(calls, handlers)).toStrictEqual([]);
    });

    test('all literal offscreen-proxy actions have offscreen handlers', () => {
        const calls = actionNames(proxy, /sendMessagePromise\(\{\s*action:\s*'([^']+)'/g);
        const handlers = registeredNames(between(offscreen, 'this._apiMap =', 'this._mcApiMap ='));
        expect(missingActions(calls, handlers)).toStrictEqual([]);
    });

    test('all literal offscreen-to-worker actions have worker implementations', () => {
        const calls = actionNames(offscreen, /this\._invokeDictionaryWorker\('([^']+)'/g);
        const handlers = actionNames(worker, /case '([^']+)':/g);
        expect(missingActions(calls, handlers)).toStrictEqual([]);
    });
});
