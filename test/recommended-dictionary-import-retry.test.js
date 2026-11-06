/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';

afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, '__manabitanImportStepTimingHistory');
});

function setup() {
    class Button {
        /** @param {string} url */
        constructor(url) {
            this.disabled = false;
            this.dataset = {importUrl: url};
            this.attributes = {getNamedItem: () => ({value: url})};
        }
    }
    vi.stubGlobal('HTMLButtonElement', Button);
    vi.stubGlobal('document', {querySelectorAll: () => []});
    const controller = Object.create(DictionaryImportController.prototype);
    const showError = vi.fn();
    const imports = vi.fn();
    const buttons = [new Button('https://example.test/one.zip'), new Button('https://example.test/two.zip')];
    Object.assign(controller, {
        _modifying: false,
        _errorToStringOverrides: [],
        _recommendedDictionaryQueue: [],
        _recommendedDictionaryActiveImport: false,
        _recommendedDictionaryCurrentUrl: null,
        _updateRecommendedImportDebugState: vi.fn(),
        _clearRecommendedError: vi.fn(),
        _setRecommendedError: showError,
        _showErrors: vi.fn(),
        _getUrlImportSteps: () => [{label: 'Download'}],
        /**
         * @param {string[]} urls
         * @returns {string[]}
         */
        _getUrlImportSources: (urls) => urls,
        _importDictionaries: imports,
        /**
         * @param {string} url
         * @param {boolean} disabled
         */
        _setRecommendedImportButtonDisabled: (url, disabled) => {
            for (const button of buttons) {
                if (button.dataset.importUrl === url) { button.disabled = disabled; }
            }
        },
        /** @param {Promise<void>} promise */
        _runImportWithWatchdog: async (promise) => { await promise; },
    });
    return {controller, imports, buttons, showError};
}

test('recommended import failures restore retry and continue queued imports', async () => {
    const {controller, imports, buttons, showError} = setup();
    imports.mockImplementationOnce(async (_sources, _settings, done) => {
        await controller._onRecommendedImportClick({currentTarget: buttons[1]});
        done?.({ok: false, errors: [new Error('Download failed')], importedTitles: []});
    }).mockImplementation(async (_sources, _settings, done) => {
        done?.({ok: true, errors: [], importedTitles: ['Dictionary']});
    });
    await controller._onRecommendedImportClick({currentTarget: buttons[0]});
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('Download failed'));
    expect(buttons.map(({disabled}) => disabled)).toEqual([false, true]);
    expect(imports).toHaveBeenCalledTimes(2);
    await controller._onRecommendedImportClick({currentTarget: buttons[0]});
    expect(imports).toHaveBeenCalledTimes(3);
    expect(buttons[0].disabled).toBe(true);
});

test('a busy local import visibly rejects recommendations without consuming their retry', async () => {
    const {controller, imports, buttons, showError} = setup();
    controller._modifying = true;
    await controller._onRecommendedImportClick({currentTarget: buttons[0]});
    expect(imports).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('in progress'));
    expect(buttons[0].disabled).toBe(false);
    expect(controller._recommendedDictionaryQueue).toEqual([]);
});

test.each(['mode', 'source', 'worker'])('real import runner reports a %s failure to the recommendation and permits retry', async (phase) => {
    const {controller, buttons, showError} = setup();
    const failure = new Error(`${phase} failed`);
    const mode = vi.fn().mockResolvedValue(void 0);
    const importZip = vi.fn().mockResolvedValue({errors: [], importedTitle: 'Dictionary'});
    if (phase === 'mode') { mode.mockRejectedValueOnce(failure); }
    if (phase === 'worker') { importZip.mockResolvedValueOnce({errors: [failure], importedTitle: null}); }
    let failSource = phase === 'source';
    vi.stubGlobal('chrome', {runtime: {getManifest: () => ({version: '1.0.0'})}});
    Object.assign(controller, {
        _importDictionaries: DictionaryImportController.prototype._importDictionaries,
        _activeImportRunGeneration: 0,
        _activeMdx: null,
        _statusFooter: null,
        _settingsController: {
            application: {api: {setDictionaryImportMode: mode}},
            getOptionsFull: async () => ({global: {database: {prefixWildcardsSupported: true}}}),
        },
        _preventPageExit: () => ({end: vi.fn()}),
        _getUseImportSession: () => false,
        _getImportPerformanceFlags: () => ({}),
        _hideErrors: vi.fn(),
        _triggerStorageChanged: vi.fn(),
        _signalImportSessionCompletion: vi.fn(),
        _importDictionaryFromZip: importZip,
        async *_getUrlImportSources() {
            if (failSource) {
                failSource = false;
                throw failure;
            }
            yield new File(['dictionary'], 'dictionary.zip');
        },
    });
    await controller._onRecommendedImportClick({currentTarget: buttons[0]});
    expect(showError).toHaveBeenCalledWith(expect.stringContaining(failure.message));
    expect(buttons[0].disabled).toBe(false);
    expect(controller._modifying).toBe(false);
    showError.mockClear();
    await controller._onRecommendedImportClick({currentTarget: buttons[0]});
    expect(showError).not.toHaveBeenCalled();
    expect(buttons[0].disabled).toBe(true);
    expect(controller._modifying).toBe(false);
});


test('a skipped import cannot be reported as a successful recommendation', async () => {
    const {controller, imports, buttons, showError} = setup();
    imports.mockResolvedValue(void 0);
    await controller._onRecommendedImportClick({currentTarget: buttons[0]});
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('Dictionary import failed'));
    expect(buttons[0].disabled).toBe(false);
});
