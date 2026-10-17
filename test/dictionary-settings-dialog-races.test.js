/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {createDomTest} from './fixtures/dom-test.js';
import {createDictionarySettingsHarness, dictionaryRow} from './fixtures/dictionary-settings-harness.js';

const domTest = createDomTest();
/** @typedef {Awaited<ReturnType<typeof createDictionarySettingsHarness>>} Harness */

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {Harness} h
 * @param {HTMLInputElement|HTMLSelectElement} element
 * @param {boolean|string} value
 */
async function edit(window, h, element, value) {
    const before = h.modifySettings.mock.calls.length;
    if (typeof value === 'boolean') {
        /** @type {HTMLInputElement} */ (element).checked = value;
    } else {
        element.value = value;
    }
    element.dispatchEvent(new window.Event('change', {bubbles: true}));
    await vi.waitFor(() => expect(h.modifySettings.mock.calls.length).toBeGreaterThan(before));
    await h.modifySettings.mock.results[before].value;
}

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return {promise, resolve};
}

domTest('stale rendered checkbox is checked only after its dispatched write completes', async ({window}) => {
    const h = await createDictionarySettingsHarness(window, [dictionaryRow('A'), dictionaryRow('B')]);
    try {
        const stale = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-enabled'));
        const reorder = h.settings.modifyProfileSettings([{action: 'moveDictionary', path: 'dictionaries', currentIndex: 0, targetIndex: 1, expectedNames: ['A', 'B'], expectedEntries: h.getRows()}]);
        await edit(window, h, stale, false);
        await reorder;
        expect(h.modifySettings.mock.calls).toHaveLength(2);
        expect(h.modifySettings.mock.calls[1][0][0]).toMatchObject({action: 'setDictionaryField', index: 0, field: 'enabled', value: false});
        expect(h.getRows().map(({name, enabled}) => [name, enabled])).toEqual([['B', true], ['A', true]]);
    } finally { h.cleanup(); }
});

domTest('all-row writes keep independently rendered individual controls usable', async ({window}) => {
    const h = await createDictionarySettingsHarness(window, [dictionaryRow('A'), dictionaryRow('B')]);
    try {
        await h.dictionary._setAllDictionariesEnabled(false);
        const secondary = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-allow-secondary-searches'));
        await edit(window, h, secondary, true);
        expect(h.getRows().map(({enabled, allowSecondarySearches}) => [enabled, allowSecondarySearches])).toEqual([[false, true], [false, false]]);
        await h.collapsible._setDefinitionsCollapsibleAll('expanded');
        const main = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-enabled'));
        await edit(window, h, main, true);
        const select = /** @type {HTMLSelectElement} */ (h.collapsible._selects[0]);
        await edit(window, h, select, 'collapsed');
        expect(h.getRows()[0]).toMatchObject({enabled: true, allowSecondarySearches: true, definitionsCollapsible: 'collapsed'});
        expect(h.getRows()[1]).toMatchObject({enabled: false, allowSecondarySearches: false, definitionsCollapsible: 'expanded'});
    } finally { h.cleanup(); }
});

domTest('same-name same-alias rows preserve distinct preferences through edits and a move', async ({window}) => {
    const h = await createDictionarySettingsHarness(window, [
        dictionaryRow('A', {alias: 'same', partsOfSpeechFilter: true}),
        dictionaryRow('A', {alias: 'same', enabled: false, partsOfSpeechFilter: false}),
    ]);
    try {
        const control = /** @type {HTMLInputElement} */ (window.document.querySelectorAll('.dictionary-enabled')[1]);
        await edit(window, h, control, true);
        await edit(window, h, control, false);
        expect(h.getRows().map(({enabled, partsOfSpeechFilter}) => [enabled, partsOfSpeechFilter])).toEqual([[true, true], [false, false]]);
        await h.dictionary._dictionaryEntries[1]._move(-1);
        await vi.waitFor(() => expect(h.getRows().map(({partsOfSpeechFilter}) => partsOfSpeechFilter)).toEqual([false, true]));
        expect(h.getRows().map(({enabled}) => enabled)).toEqual([false, true]);
    } finally { h.cleanup(); }
});

for (const reopenIndex of [0, 1]) {
    domTest(`delayed Save cannot consume a new dialog draft when reopened for row ${reopenIndex}`, async ({window}) => {
        const h = await createDictionarySettingsHarness(window, [dictionaryRow('A'), dictionaryRow('A', {alias: 'second'})]);
        try {
            const modal = h.modals.get('dictionary-set-alias');
            const input = /** @type {HTMLInputElement} */ (modal?.node.querySelector('#dictionary-alias-input'));
            const entries = h.dictionary._dictionaryEntries;
            entries[0]._showRenameModal();
            input.value = 'confirmed old draft';
            const gate = deferred();
            const originalGetOptions = h.settings.getOptions.bind(h.settings);
            const snapshot = await originalGetOptions();
            const spy = vi.spyOn(h.settings, 'getOptions').mockImplementationOnce(() => gate.promise);
            const save = h.dictionary._onDictionarySetAliasButtonClick();
            expect(spy).toHaveBeenCalledOnce();
            entries[reopenIndex]._showRenameModal();
            input.value = 'new unconfirmed draft';
            gate.resolve(snapshot);
            await save;
            expect(input.value).toBe('new unconfirmed draft');
            expect(h.getRows().map(({alias}) => alias)).toEqual(['A', 'second']);
            expect(h.modifySettings).not.toHaveBeenCalled();
        } finally { h.cleanup(); }
    });

    domTest(`delayed Reset cannot overwrite a new dialog draft when reopened for row ${reopenIndex}`, async ({window}) => {
        const h = await createDictionarySettingsHarness(window, [dictionaryRow('A'), dictionaryRow('A', {alias: 'second'})]);
        try {
            const input = /** @type {HTMLInputElement} */ (h.modals.get('dictionary-set-alias')?.node.querySelector('#dictionary-alias-input'));
            const entries = h.dictionary._dictionaryEntries;
            entries[0]._showRenameModal();
            const snapshot = await h.settings.getOptions();
            const gate = deferred();
            const spy = vi.spyOn(h.settings, 'getOptions').mockImplementationOnce(() => gate.promise);
            const reset = h.dictionary._onDictionaryResetAliasButtonClick();
            expect(spy).toHaveBeenCalledOnce();
            entries[reopenIndex]._showRenameModal();
            input.value = 'new unconfirmed draft';
            gate.resolve(snapshot);
            await reset;
            expect(input.value).toBe('new unconfirmed draft');
            expect(h.getRows().map(({alias}) => alias)).toEqual(['A', 'second']);
        } finally { h.cleanup(); }
    });
}
