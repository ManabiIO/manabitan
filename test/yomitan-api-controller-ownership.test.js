/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {expect, vi} from 'vitest';
import {DOMDataBinder} from '../ext/js/dom/dom-data-binder.js';
import {YomitanApiController} from '../ext/js/pages/settings/yomitan-api-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {{request: import('vitest').Mock, button: HTMLButtonElement, input: HTMLInputElement, results: HTMLElement}}
 */
function setup(window) {
    window.document.body.innerHTML = '<button id="test-yomitan-api-button">Test</button><input id="test-yomitan-url-input" value="http://old"><div id="test-yomitan-api-results" hidden></div>';
    const request = vi.fn();
    const controller = new YomitanApiController(/** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({testYomitanApi: request})));
    controller.prepare();
    const button = /** @type {HTMLButtonElement} */ (window.document.querySelector('button'));
    const input = /** @type {HTMLInputElement} */ (window.document.querySelector('input'));
    const results = /** @type {HTMLElement} */ (window.document.querySelector('div'));
    return {request, button, input, results};
}

for (const eventName of ['input', 'settingChanged']) {
    for (const outcome of ['success', 'failure']) {
        test(`${eventName} invalidates a pending ${outcome}, including an edit back to the original URL`, async ({window}) => {
            const h = setup(window);
            const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
            h.request.mockReturnValueOnce(pending.promise).mockImplementation(async () => {});
            h.button.click();
            expect(h.request).toHaveBeenCalledWith('http://old');
            h.input.value = 'http://new';
            h.input.dispatchEvent(new window.Event(eventName));
            h.input.value = 'http://old';
            h.input.dispatchEvent(new window.Event(eventName));
            if (outcome === 'success') {
                pending.resolve();
            } else {
                pending.reject(new Error('obsolete error'));
            }
            await vi.waitFor(() => expect(h.button.disabled).toBe(false));
            expect(h.results.hidden).toBe(true);
            expect(h.results.textContent).toBe('');
            h.button.click();
            await vi.waitFor(() => expect(h.results.textContent).toBe('Connection was successful'));
            expect(h.request).toHaveBeenCalledTimes(2);
        });
    }
}

test('normal failure and retry work, and editing clears the published status', async ({window}) => {
    const h = setup(window);
    h.request.mockRejectedValueOnce(new Error('connection refused')).mockImplementation(async () => {});
    h.button.click();
    await vi.waitFor(() => expect(h.results.textContent).toBe('connection refused'));
    expect(h.results.classList.contains('danger-text')).toBe(true);
    expect(h.button.disabled).toBe(false);
    h.button.click();
    await vi.waitFor(() => expect(h.results.textContent).toBe('Connection was successful'));
    expect(h.results.classList.contains('danger-text')).toBe(false);
    h.input.value = 'http://new';
    h.input.dispatchEvent(new window.Event('input'));
    expect(h.results.hidden).toBe(true);
    expect(h.results.textContent).toBe('');
});

for (const pendingResult of [true, false]) {
    test(`an unchanged bound value preserves a ${pendingResult ? 'pending' : 'published'} connection result`, async ({window}) => {
        const h = setup(window);
        const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        h.request.mockReturnValueOnce(pending.promise);
        h.input.value = 'http://edited';
        h.input.dispatchEvent(new window.Event('input'));
        h.button.click();
        if (!pendingResult) {
            pending.resolve();
            await vi.waitFor(() => expect(h.results.hidden).toBe(false));
        }
        h.input.dispatchEvent(new window.CustomEvent('settingChanged', {detail: {value: 'http://edited'}}));
        pending.resolve();
        await vi.waitFor(() => expect(h.button.disabled).toBe(false));
        expect(h.results.hidden).toBe(false);
        expect(h.results.textContent).toBe('Connection was successful');
    });
}

test('a delayed settings binder save does not erase the current connection test', async ({window}) => {
    const h = setup(window);
    vi.stubGlobal('Node', window.Node);
    const save = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const response = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    const write = vi.fn();
    const binder = new DOMDataBinder(
        ['#test-yomitan-url-input'],
        () => ({}),
        () => true,
        async () => [{result: 'http://old'}],
        async (targets) => {
            write();
            await save.promise;
            return targets.map(({value}) => ({result: value}));
        },
    );
    try {
        binder.observe(window.document.body);
        await binder.refresh();
        h.input.value = 'http://edited';
        h.input.dispatchEvent(new window.Event('input'));
        h.input.dispatchEvent(new window.Event('change'));
        h.request.mockReturnValueOnce(response.promise);
        h.button.click();
        await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
        const published = new Promise((resolve) => { h.input.addEventListener('settingChanged', resolve, {once: true}); });
        save.resolve();
        await published;
        response.resolve();
        await vi.waitFor(() => expect(h.button.disabled).toBe(false));
        expect(h.results.hidden).toBe(false);
        expect(h.results.textContent).toBe('Connection was successful');
    } finally {
        save.resolve();
        response.resolve();
        binder.disconnect();
        vi.unstubAllGlobals();
    }
});
