/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {JSDOM} from 'jsdom';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {OptionsUtil} from '../ext/js/data/options-util.js';
import {Modal} from '../ext/js/pages/settings/modal.js';
import {BackupController} from '../ext/js/pages/settings/backup-controller.js';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

vi.mock('../ext/js/core/fetch-utilities.js', async (importOriginal) => {
    const actual = /** @type {typeof import('../ext/js/core/fetch-utilities.js')} */ (await importOriginal());
    return {
        ...actual,
        fetchJson: vi.fn(async () => JSON.parse(await readFile(new URL('../ext/data/schemas/options-schema.json', import.meta.url), 'utf8'))),
    };
});

vi.mock('../ext/js/pages/settings/dictionary-controller.js', () => ({
    DictionaryController: {ensureDictionarySettings: vi.fn(async () => {})},
}));

/** @type {JSDOM|null} */
let dom = null;
/** @type {Map<string, unknown>} */
const originalGlobals = new Map();

afterEach(() => {
    dom?.window.close();
    dom = null;
    for (const [key, value] of originalGlobals) {
        if (value === undefined) {
            Reflect.deleteProperty(globalThis, key);
        } else {
            Reflect.set(globalThis, key, value);
        }
    }
    originalGlobals.clear();
    vi.mocked(DictionaryController.ensureDictionarySettings).mockClear();
});

function installDom() {
    dom = new JSDOM(`<!doctype html><html><body>
        <input id="settings-import-file" type="file">
        <section id="settings-import-warning-modal" class="modal" hidden><ul id="settings-import-warning-message"></ul>
        <button class="settings-import-warning-import-button" data-import-sanitize="true">Sanitize and Import</button>
        <button class="settings-import-warning-import-button" data-import-sanitize="false">Import</button>
        <button data-modal-action="hide">Cancel</button></section>
        <section id="settings-reset-modal" class="modal" hidden><button id="settings-reset-confirm-button">Reset All Settings</button></section>
        <section id="settings-import-error-modal" hidden></section>
        <div id="settings-import-error-message"></div>
    </body></html>`, {url: 'https://example.test/'});
    for (const key of ['window', 'document', 'File', 'FileReader', 'MutationObserver', 'HTMLElement', 'CustomEvent', 'MouseEvent', 'Event', 'getComputedStyle', 'dispatchEvent']) {
        originalGlobals.set(key, Reflect.get(globalThis, key));
        let value = Reflect.get(dom.window, key);
        if (key === 'getComputedStyle' || key === 'dispatchEvent') { value = value.bind(dom.window); }
        if (key === 'window') { value = dom.window; }
        Reflect.set(globalThis, key, value);
    }
}

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
    /** @type {(value: void) => void} */
    let resolve = () => {};
    const promise = new Promise((resolve2) => { resolve = resolve2; });
    return {promise, resolve: () => { resolve(void 0); }};
}

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
    for (let i = 0; i < 200; ++i) {
        if (predicate()) { return; }
        await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    throw new Error('Timed out waiting for import UI state');
}

/**
 * @param {string} marker
 * @param {OptionsUtil} optionsUtil
 * @returns {File}
 */
function makeBackup(marker, optionsUtil) {
    const options = optionsUtil.getDefault();
    options.profiles[0].id = `profile-${marker}`;
    options.profiles[0].name = marker;
    options.profiles[0].options.anki.fieldTemplates = `non-default-${marker}`;
    return new File([JSON.stringify({version: 0, options})], `${marker}.json`, {type: 'application/json'});
}

/**
 * @param {BackupController} controller
 * @param {File} file
 * @returns {Promise<void>}
 */
function dispatchFileChange(controller, file) {
    const input = /** @type {HTMLInputElement} */ (document.querySelector('#settings-import-file'));
    Object.defineProperty(input, 'files', {configurable: true, value: [file]});
    let task = Promise.resolve();
    input.addEventListener('change', (event) => { task = controller._onSettingsImportFileChange(event); }, {once: true});
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return task;
}

/**
 * @param {(marker: string) => Promise<void>} [onUpdate]
 * @returns {Promise<{controller: BackupController, warningModal: Modal, errorModal: Modal, resetModal: Modal, persisted: string[], optionsUtil: OptionsUtil}>}
 */
async function createHarness(onUpdate = async () => {}) {
    installDom();
    const optionsUtil = new OptionsUtil();
    await optionsUtil.prepare();
    const warningModal = new Modal(/** @type {HTMLElement} */ (document.querySelector('#settings-import-warning-modal')));
    const errorModal = new Modal(/** @type {HTMLElement} */ (document.querySelector('#settings-import-error-modal')));
    const resetModal = new Modal(/** @type {HTMLElement} */ (document.querySelector('#settings-reset-modal')));
    /** @type {string[]} */
    const persisted = [];
    const controller = /** @type {BackupController} */ (Object.create(BackupController.prototype));
    Reflect.set(controller, '_optionsUtil', optionsUtil);
    Reflect.set(controller, '_currentVersion', 0);
    Reflect.set(controller, '_settingsImportWarningModal', warningModal);
    Reflect.set(controller, '_settingsImportErrorModal', errorModal);
    Reflect.set(controller, '_settingsResetModal', resetModal);
    Reflect.set(controller, '_settingsController', {setAllSettings: async (/** @type {import('settings').Options} */ options) => { persisted.push(options.profiles[0].name); }});
    Reflect.set(controller, '_settingsImportSetOptionsFull', async (/** @type {import('settings').Options} */ options) => { persisted.push(options.profiles[0].name); });
    Reflect.set(controller, '_themeController', {prepare: vi.fn(), updateTheme: vi.fn(), siteOverride: false});
    const update = optionsUtil.update.bind(optionsUtil);
    vi.spyOn(optionsUtil, 'update').mockImplementation(async (/** @type {unknown} */ options) => {
        await onUpdate(/** @type {string} */ (/** @type {any} */ (options).profiles[0].name));
        return await update(options);
    });
    return {controller, warningModal, errorModal, resetModal, persisted, optionsUtil};
}

describe('settings import warning ownership through the file input', () => {
    test('one confirmation can commit only its backup when a second file is selected during upgrade', async () => {
        const firstUpgrade = deferred();
        const secondUpgrade = deferred();
        /** @type {string[]} */
        const upgradeStarted = [];
        const firstStarted = deferred();
        const secondStarted = deferred();
        const {controller, warningModal, persisted, optionsUtil} = await createHarness(async (marker) => {
            if (marker === 'first') { firstStarted.resolve(); }
            if (marker === 'second') { secondStarted.resolve(); }
            upgradeStarted.push(marker);
            await (marker === 'first' ? firstUpgrade.promise : secondUpgrade.promise);
        });

        const firstTask = dispatchFileChange(controller, makeBackup('first', optionsUtil));
        await firstStarted.promise;
        const secondTask = dispatchFileChange(controller, makeBackup('second', optionsUtil));
        await Promise.resolve();
        expect(upgradeStarted).toEqual(['first']);
        firstUpgrade.resolve();
        await waitFor(() => warningModal.isVisible());
        expect(document.querySelector('#settings-import-warning-message')?.textContent).toContain('anki.fieldTemplates contains a non-default value');
        document.querySelector('.settings-import-warning-import-button[data-import-sanitize="false"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
        await firstTask;
        expect(persisted).toEqual(['first']);
        await secondStarted.promise;
        secondUpgrade.resolve();
        await waitFor(() => warningModal.isVisible());
        expect(document.querySelector('#settings-import-warning-message')?.textContent).toContain('anki.fieldTemplates contains a non-default value');
        document.querySelector('.settings-import-warning-import-button[data-import-sanitize="false"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
        await secondTask;
        expect(persisted).toEqual(['first', 'second']);
        expect(warningModal.hasListeners('visibilityChanged')).toBe(false);
    });

    test('dismissal releases the warning listener and a later failed import can be retried', async () => {
        const {controller, warningModal, errorModal, persisted, optionsUtil} = await createHarness(async (marker) => {
            if (marker === 'broken') { throw new Error('upgrade failed'); }
        });

        const cancelled = dispatchFileChange(controller, makeBackup('cancelled', optionsUtil));
        await waitFor(() => warningModal.isVisible());
        const broken = dispatchFileChange(controller, makeBackup('broken', optionsUtil));
        warningModal.setVisible(false, false);
        await cancelled;
        expect(warningModal.hasListeners('visibilityChanged')).toBe(false);
        expect(persisted).toEqual([]);

        await broken;
        expect(errorModal.isVisible()).toBe(true);
        expect(warningModal.hasListeners('visibilityChanged')).toBe(false);

        const retry = dispatchFileChange(controller, makeBackup('retry', optionsUtil));
        await waitFor(() => warningModal.isVisible());
        document.querySelector('.settings-import-warning-import-button[data-import-sanitize="false"]')?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
        await retry;
        expect(persisted).toEqual(['retry']);
        expect(warningModal.hasListeners('visibilityChanged')).toBe(false);
    });

    test('confirmed reset closes immediately while queued import owns the warning modal', async () => {
        const upgradeStarted = deferred();
        const upgradeGate = deferred();
        const {controller, warningModal, resetModal, persisted, optionsUtil} = await createHarness(async () => {
            upgradeStarted.resolve();
            await upgradeGate.promise;
        });
        const importTask = dispatchFileChange(controller, makeBackup('import', optionsUtil));
        await upgradeStarted.promise;

        const warningNode = /** @type {Node} */ (document.querySelector('#settings-import-warning-modal'));
        const resetNode = /** @type {Node} */ (document.querySelector('#settings-reset-modal'));
        expect(warningNode.compareDocumentPosition(resetNode)).toBe(4);
        controller._onSettingsResetClick();
        expect(resetModal.isVisible()).toBe(true);
        let resetTask = Promise.resolve();
        document.querySelector('#settings-reset-confirm-button')?.addEventListener('click', () => {
            resetTask = controller._onSettingsResetConfirmClick();
        }, {once: true});
        document.querySelector('#settings-reset-confirm-button')?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));

        expect(resetModal.isVisible()).toBe(false);
        expect(warningModal.isVisible()).toBe(false);
        expect(persisted).toEqual([]);

        upgradeGate.resolve();
        await waitFor(() => warningModal.isVisible());
        expect(resetModal.isVisible()).toBe(false);
        expect(document.querySelector('#settings-import-warning-message')?.textContent).toContain('anki.fieldTemplates contains a non-default value');
        warningModal.setVisible(false, false);
        await importTask;
        await resetTask;

        expect(persisted).toEqual(['Default']);
        expect(warningModal.hasListeners('visibilityChanged')).toBe(false);
        expect(resetModal.isVisible()).toBe(false);
    });
});
