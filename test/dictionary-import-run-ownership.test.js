/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryImportController, ImportProgressTracker} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {deferPromise} from '../ext/js/core/utilities.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, '__manabitanImportStepTimingHistory');
});

/** @returns {import('core').DeferredPromiseDetails<void>} */
function barrier() {
    return deferPromise();
}

function setup() {
    vi.stubGlobal('document', {querySelectorAll: vi.fn(() => [])});
    vi.stubGlobal('chrome', {runtime: {getManifest: () => ({version: '1.0.0'})}});
    const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
    const mode = vi.fn().mockResolvedValue(void 0);
    const options = vi.fn().mockResolvedValue({global: {database: {prefixWildcardsSupported: true}}});
    const importZip = vi.fn().mockResolvedValue({errors: [], importedTitle: 'Test'});
    const showErrors = vi.fn();
    const changed = vi.fn();
    const completion = vi.fn();
    Reflect.set(controller, '_modifying', false);
    Reflect.set(controller, '_activeImportRunGeneration', 0);
    Reflect.set(controller, '_activeMdx', null);
    Reflect.set(controller, '_statusFooter', null);
    Reflect.set(controller, '_settingsController', {application: {api: {setDictionaryImportMode: mode}}, getOptionsFull: options});
    Reflect.set(controller, '_preventPageExit', vi.fn(() => ({end: vi.fn()})));
    Reflect.set(controller, '_getUseImportSession', vi.fn(() => false));
    Reflect.set(controller, '_getImportPerformanceFlags', vi.fn(() => ({})));
    Reflect.set(controller, '_hideErrors', vi.fn());
    Reflect.set(controller, '_showErrors', showErrors);
    Reflect.set(controller, '_triggerStorageChanged', changed);
    Reflect.set(controller, '_signalImportSessionCompletion', completion);
    Reflect.set(controller, '_importDictionaryFromZip', importZip);
    Reflect.set(controller, '_setRecommendedError', vi.fn());
    Reflect.set(controller, '_errorToString', vi.fn(() => 'injected timeout'));
    Reflect.set(controller, '_updateRecommendedImportDebugState', vi.fn());
    return {controller, mode, options, importZip, showErrors, changed, completion};
}

/**
 * @param {DictionaryImportController} controller
 */
function recover(controller) {
    controller._forceRecoverHungImportSession(new Error('injected timeout'), 'test import');
}

/**
 * @param {number} [count]
 * @yields {File}
 * @returns {AsyncGenerator<File, void, void>}
 */
async function *files(count = 1) {
    for (let i = 0; i < count; ++i) {
        yield new File(['test'], `dictionary-${i}.zip`);
    }
}

test.each(['mode', 'options', 'source'])('recovered imports do not dispatch work after a delayed %s completes', async (phase) => {
    const {controller, mode, options, importZip, completion} = setup();
    const entered = barrier();
    const resume = barrier();
    let sources = files();
    if (phase === 'mode' || phase === 'options') {
        const operation = phase === 'mode' ? mode : options;
        operation.mockImplementationOnce(async () => {
            entered.resolve();
            await resume.promise;
            return {global: {database: {prefixWildcardsSupported: true}}};
        });
    } else {
        sources = (async function *delayedSource() {
            entered.resolve();
            await resume.promise;
            yield new File(['test'], 'dictionary.zip');
        })();
    }
    const pending = controller._importDictionaries(sources, null, null, new ImportProgressTracker([{label: 'Import'}], 1));
    await entered.promise;
    recover(controller);
    resume.resolve();

    await pending;
    expect(importZip).not.toHaveBeenCalled();
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({importRunCurrent: false}));
});

test('recovered imports do not start a later file when an older worker request settles', async () => {
    const {controller, importZip} = setup();
    const entered = barrier();
    const resume = barrier();
    importZip.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return {errors: [], importedTitle: null};
    });
    const pending = controller._importDictionaries(files(2), null, null, new ImportProgressTracker([{label: 'Import'}], 2));
    await entered.promise;
    recover(controller);
    resume.resolve();

    await pending;
    expect(importZip).toHaveBeenCalledOnce();
});

test('import remains mutation-owned until backend mode exit settles', async () => {
    const {controller, mode} = setup();
    const entered = barrier();
    const resume = barrier();
    mode.mockImplementation(async (active) => {
        if (active) { return; }
        entered.resolve();
        await resume.promise;
    });
    const pending = controller._importDictionaries(files(), null, null, new ImportProgressTracker([{label: 'Import'}], 1));
    await entered.promise;
    const modifyingBeforeExit = Reflect.get(controller, '_modifying');
    resume.resolve();
    await pending;

    expect(modifyingBeforeExit).toBe(true);
    expect(Reflect.get(controller, '_modifying')).toBe(false);
});

test('obsolete mode-exit completion does not publish callbacks or UI state to a newer run', async () => {
    const {controller, mode, showErrors, changed} = setup();
    const entered = barrier();
    const resume = barrier();
    mode.mockImplementationOnce(async () => {});
    mode.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
    });
    const done = vi.fn();
    const pending = controller._importDictionaries(files(), null, done, new ImportProgressTracker([{label: 'Import'}], 1));
    await entered.promise;
    recover(controller);
    // A new run now owns the page. Its progress history must not be replaced.
    Reflect.set(controller, '_activeImportRunGeneration', 3);
    Reflect.set(controller, '_modifying', true);
    const currentHistory = [{owner: 'new run'}];
    Reflect.set(globalThis, '__manabitanImportStepTimingHistory', currentHistory);
    showErrors.mockClear();
    changed.mockClear();
    resume.resolve();
    await pending;

    expect(done).not.toHaveBeenCalled();
    expect(showErrors).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(Reflect.get(controller, '_modifying')).toBe(true);
    expect(Reflect.get(globalThis, '__manabitanImportStepTimingHistory')).toBe(currentHistory);
});

test('healthy imports complete all files and publish once', async () => {
    const {controller, mode, importZip, completion} = setup();
    const done = vi.fn();
    await controller._importDictionaries(files(2), null, done, new ImportProgressTracker([{label: 'Import'}], 2));

    expect(importZip).toHaveBeenCalledTimes(2);
    expect(mode.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(mode.mock.calls[0][1]).toEqual(expect.any(String));
    expect(mode.mock.calls[1][1]).toBe(mode.mock.calls[0][1]);
    expect(Reflect.get(controller, '_activeImportOwnerId')).toBeUndefined();
    expect(done).toHaveBeenCalledWith({ok: true, errors: [], importedTitles: ['Test']});
    expect(completion).toHaveBeenCalledOnce();
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({importRunCurrent: true}));
});

test('finishing an import closes its suspended source generator', async () => {
    const {controller} = setup();
    const closed = vi.fn();
    const sources = (async function *ownedSource() {
        try {
            yield new File(['test'], 'dictionary.zip');
        } finally {
            closed();
        }
    })();
    await controller._importDictionaries(sources, null, null, new ImportProgressTracker([{label: 'Import'}], 1));
    const wasClosed = closed.mock.calls.length;
    // Clean up the pre-fix generator as well so the test leaves no resources.
    await sources.return();
    expect(wasClosed).toBe(1);
});

test('late progress from a recovered import cannot overwrite the current progress UI', async () => {
    const {controller, importZip} = setup();
    const info = {textContent: ''};
    vi.stubGlobal('document', {querySelectorAll: (/** @type {string} */ selector) => (selector.endsWith(' .progress-info') ? [info] : [])});
    const entered = barrier();
    const resume = barrier();
    importZip.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return {errors: [], importedTitle: null};
    });
    const oldTracker = new ImportProgressTracker([{label: 'Old start'}, {label: 'Old import'}, {label: 'Old finalization'}], 1);
    const pending = controller._importDictionaries(files(), null, null, oldTracker);
    await entered.promise;
    recover(controller);
    const currentTracker = new ImportProgressTracker([{label: 'New import'}], 1);
    const currentLabel = info.textContent;
    oldTracker.onProgress({nextStep: true, index: 1, count: 1});
    const observedLabel = info.textContent;
    resume.resolve();
    await pending;

    expect(observedLabel).toBe(currentLabel);
    expect(currentLabel).toContain(currentTracker.currentStep.label);
});
