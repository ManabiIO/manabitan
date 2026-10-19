/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, vi} from 'vitest';
import {createDomTest} from './fixtures/dom-test.js';
import {createDictionarySettingsHarness, dictionaryRow} from './fixtures/dictionary-settings-harness.js';

const domTest = createDomTest();

/**
 * @param {string} title
 * @returns {{ok: boolean, status: number, json: () => Promise<{title: string, revision: string, format: number, downloadUrl: string}>, body: {cancel: ReturnType<typeof vi.fn>}}}
 */
function indexResponse(title) {
    return {
        ok: true,
        status: 200,
        json: async () => ({title, revision: '2', format: 3, downloadUrl: `https://example.test/${title}.zip`}),
        body: {cancel: vi.fn().mockResolvedValue(void 0)},
    };
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {Promise<{harness: Awaited<ReturnType<typeof createDictionarySettingsHarness>>, dictionary: import('../ext/js/pages/settings/dictionary-controller.js').DictionaryController, entries: import('../ext/js/pages/settings/dictionary-controller.js').DictionaryController['_dictionaryEntries'], checkButton: HTMLButtonElement, mutationButton: HTMLButtonElement, mutationButtons: HTMLButtonElement[]}>}
 */
async function setup(window) {
    const harness = await createDictionarySettingsHarness(window, [dictionaryRow('A'), dictionaryRow('B')]);
    const {dictionary} = harness;
    for (const entry of dictionary._dictionaryEntries) {
        Object.assign(entry._dictionaryInfo, {
            isUpdatable: true,
            indexUrl: `https://example.test/${entry.dictionaryTitle}/index.json`,
            downloadUrl: `https://example.test/${entry.dictionaryTitle}/old.zip`,
            revision: '1',
        });
    }
    const checkButton = /** @type {HTMLButtonElement} */ (window.document.querySelector('#dictionary-check-updates'));
    Reflect.set(dictionary, '_checkUpdatesButton', checkButton);
    Reflect.set(dictionary, '_checkingIntegrity', false);
    Reflect.set(dictionary, '_checkingUpdates', false);
    Reflect.set(dictionary, '_isTaskQueueRunning', false);
    const mutationButton = /** @type {HTMLButtonElement} */ (window.document.querySelector('#dictionary-check-integrity'));
    const mutationButtons = [...window.document.querySelectorAll('.dictionary-database-mutating-input')].map((button) => /** @type {HTMLButtonElement} */ (button));
    return {harness, dictionary, entries: dictionary._dictionaryEntries, checkButton, mutationButton, mutationButtons};
}

describe('dictionary provider update check deadline', () => {
    domTest('bounds a stalled headers request, keeps a successful sibling, ignores late data, and permits retry', async ({window}) => {
        vi.useFakeTimers();
        const {harness, dictionary, entries, checkButton, mutationButton, mutationButtons} = await setup(window);
        /** @type {AbortSignal|undefined} */
        let firstSignal;
        /** @type {(response: Response) => void} */
        let resolveLateHeaders = () => {};
        const lateResponse = indexResponse('A');
        let finished = false;
        try {
            vi.stubGlobal('fetch', vi.fn((url, init) => {
                if (url === 'https://example.test/A/index.json') {
                    firstSignal = init?.signal;
                    return new Promise((resolve) => { resolveLateHeaders = resolve; });
                }
                return Promise.resolve(indexResponse('B'));
            }));
            const running = dictionary._checkForUpdates().then(() => { finished = true; });
            await vi.waitFor(() => expect(entries[1]._updatesAvailable.hidden).toBe(false));
            expect(mutationButton.disabled).toBe(true);
            expect(mutationButtons.every((button) => button.disabled)).toBe(true);

            await vi.advanceTimersByTimeAsync(60_000);
            await Promise.resolve();
            const finishedAtDeadline = finished;
            if (!finishedAtDeadline) { resolveLateHeaders(/** @type {Response} */ (/** @type {unknown} */ (lateResponse))); }
            await running;
            resolveLateHeaders(/** @type {Response} */ (/** @type {unknown} */ (lateResponse)));
            await Promise.resolve();
            await Promise.resolve();

            expect(finishedAtDeadline).toBe(true);
            expect(firstSignal?.aborted).toBe(true);
            expect(entries[0]._updatesAvailable.hidden).toBe(true);
            expect(entries[0].updateDownloadUrl).toBeNull();
            expect(lateResponse.body.cancel).toHaveBeenCalledOnce();
            expect(entries[1]._updatesAvailable.hidden).toBe(false);
            expect(mutationButton.disabled).toBe(false);
            expect(mutationButtons.every((button) => !button.disabled)).toBe(true);
            expect(dictionary._checkingUpdates).toBe(false);
            expect(checkButton.disabled).toBe(false);

            vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve(indexResponse(url.includes('/A/') ? 'A' : 'B'))));
            await dictionary._checkForUpdates();
            expect(entries[0]._updatesAvailable.hidden).toBe(false);
            expect(checkButton.textContent).toBe('2 updates');
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
            harness.cleanup();
        }
    });

    domTest('bounds a stalled response body, cancels it, and suppresses its late parsed index', async ({window}) => {
        vi.useFakeTimers();
        const {harness, dictionary, entries, mutationButton, mutationButtons} = await setup(window);
        /** @type {AbortSignal|undefined} */
        let bodySignal;
        /** @type {(value: unknown) => void} */
        let resolveLateBody = () => {};
        const cancelBody = vi.fn().mockResolvedValue(void 0);
        let finished = false;
        try {
            vi.stubGlobal('fetch', vi.fn((url, init) => {
                if (url === 'https://example.test/A/index.json') {
                    bodySignal = init?.signal;
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () => new Promise((resolve) => { resolveLateBody = resolve; }),
                        body: {cancel: cancelBody},
                    });
                }
                return Promise.resolve(indexResponse('B'));
            }));
            const running = dictionary._checkForUpdates().then(() => { finished = true; });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(entries[1]._updatesAvailable.hidden).toBe(false);

            await vi.advanceTimersByTimeAsync(60_000);
            await Promise.resolve();
            const finishedAtDeadline = finished;
            if (!finishedAtDeadline) { resolveLateBody({title: 'A', revision: '2', format: 3}); }
            await running;
            resolveLateBody({title: 'A', revision: '2', format: 3});
            await Promise.resolve();
            await Promise.resolve();

            expect(finishedAtDeadline).toBe(true);
            expect(bodySignal?.aborted).toBe(true);
            expect(cancelBody).toHaveBeenCalledOnce();
            expect(entries[0]._updatesAvailable.hidden).toBe(true);
            expect(entries[0].updateDownloadUrl).toBeNull();
            expect(mutationButton.disabled).toBe(false);
            expect(mutationButtons.every((button) => !button.disabled)).toBe(true);
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
            harness.cleanup();
        }
    });

    domTest('entry cleanup invalidates pending headers and body responses', async ({window}) => {
        vi.useFakeTimers();
        const {harness, entries} = await setup(window);
        const headerEntry = entries[0];
        /** @type {AbortSignal|undefined} */
        let headersSignal;
        /** @type {(response: Response) => void} */
        let resolveHeaders = () => {};
        /** @type {AbortSignal|undefined} */
        let bodySignal;
        /** @type {(value: unknown) => void} */
        let resolveBody = () => {};
        const lateHeadersResponse = indexResponse('A');
        try {
            vi.stubGlobal('fetch', vi.fn((url, init) => {
                if (url === 'https://example.test/A/index.json') {
                    headersSignal = init?.signal;
                    return new Promise((resolve) => { resolveHeaders = resolve; });
                }
                return Promise.resolve(indexResponse('B'));
            }));
            const headersCheck = headerEntry.checkForUpdate();
            headerEntry.cleanup();
            resolveHeaders(/** @type {Response} */ (/** @type {unknown} */ (lateHeadersResponse)));
            await expect(headersCheck).rejects.toThrow('cancelled');
            expect(headersSignal?.aborted).toBe(true);
            expect(lateHeadersResponse.body.cancel).toHaveBeenCalledOnce();
            expect(headerEntry._updatesAvailable.hidden).toBe(true);
            expect(headerEntry.updateDownloadUrl).toBeNull();

            const bodyEntry = entries[1];
            const cancelBody = vi.fn().mockResolvedValue(void 0);
            vi.stubGlobal('fetch', vi.fn((_url, init) => {
                bodySignal = init?.signal;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => new Promise((resolve) => { resolveBody = resolve; }),
                    body: {cancel: cancelBody},
                });
            }));
            const bodyCheck = bodyEntry.checkForUpdate();
            await Promise.resolve();
            await Promise.resolve();
            bodyEntry.cleanup();
            resolveBody({title: 'B', revision: '2', format: 3, downloadUrl: 'https://example.test/B-new.zip'});
            await expect(bodyCheck).rejects.toThrow('cancelled');
            expect(bodySignal?.aborted).toBe(true);
            expect(bodyEntry._updatesAvailable.hidden).toBe(true);
            expect(bodyEntry.updateDownloadUrl).toBeNull();
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
            harness.cleanup();
        }
    });

    domTest('list rebuild suppresses stale aggregate update results', async ({window}) => {
        vi.useFakeTimers();
        const {harness, dictionary, entries, checkButton} = await setup(window);
        /** @type {(response: Response) => void} */
        let resolveHeaders = () => {};
        const staleResponse = indexResponse('A');
        try {
            vi.stubGlobal('fetch', vi.fn((url) => {
                if (url === 'https://example.test/A/index.json') {
                    return new Promise((resolve) => { resolveHeaders = resolve; });
                }
                return Promise.resolve(indexResponse('B'));
            }));
            const running = dictionary._checkForUpdates();
            const currentOptions = await dictionary._settingsController.getOptions();
            dictionary._updateCurrentEntries(currentOptions);
            const currentEntry = dictionary._dictionaryEntries[0];
            checkButton.textContent = 'Current profile';
            checkButton.disabled = false;

            resolveHeaders(/** @type {Response} */ (/** @type {unknown} */ (staleResponse)));
            await running;
            await Promise.resolve();

            expect(entries[0]._updatesAvailable.hidden).toBe(true);
            expect(entries[0].updateDownloadUrl).toBeNull();
            expect(staleResponse.body.cancel).toHaveBeenCalledOnce();
            expect(currentEntry._updatesAvailable.hidden).toBe(true);
            expect(currentEntry.updateDownloadUrl).toBeNull();
            expect(checkButton.textContent).toBe('Current profile');
            expect(checkButton.disabled).toBe(false);
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
            harness.cleanup();
        }
    });

    domTest('rejects non-ok index responses even when their JSON advertises a newer revision', async ({window}) => {
        const {harness, dictionary, entries, checkButton} = await setup(window);
        try {
            const cancelBody = vi.fn().mockResolvedValue(void 0);
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                json: async () => ({title: 'A', revision: '99', format: 3}),
                body: {cancel: cancelBody},
            }));
            await dictionary._checkForUpdates();
            expect(entries[0]._updatesAvailable.hidden).toBe(true);
            expect(entries[0].updateDownloadUrl).toBeNull();
            expect(checkButton.textContent).toBe('Check failed');
            expect(checkButton.disabled).toBe(false);
            expect(cancelBody).toHaveBeenCalledTimes(2);
        } finally {
            vi.unstubAllGlobals();
            harness.cleanup();
        }
    });
});
