/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';

vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({
    isDevDiagnosticsBuild: false,
    reportDiagnostics: vi.fn(),
    reportDiagnosticsLazy: vi.fn(),
}));

const {Backend} = await import('../ext/js/background/backend.js');
const {reportDiagnostics} = await import('../ext/js/core/diagnostics-reporter.js');

function createLookupBackend() {
    const backend = /** @type {InstanceType<typeof Backend>} */ (Object.create(Backend.prototype));
    const findTerms = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 2});
    const getDictionaryInfo = vi.fn().mockResolvedValue([]);
    const debugLookupState = vi.fn().mockResolvedValue({ok: true});
    Reflect.set(backend, '_awaitDictionaryMutationSettled', vi.fn().mockResolvedValue(void 0));
    Reflect.set(backend, '_awaitDictionaryRefreshSettled', vi.fn().mockResolvedValue(void 0));
    Reflect.set(backend, '_ensureDictionaryDatabaseReady', vi.fn().mockResolvedValue(void 0));
    Reflect.set(backend, '_translator', {findTerms});
    Reflect.set(backend, '_dictionaryDatabase', {getDictionaryInfo});
    Reflect.set(backend, '_getProfileOptions', vi.fn().mockReturnValue({
        general: {resultOutputMode: 'group', maxResults: 32},
        dictionaries: [],
    }));
    Reflect.set(backend, '_getTranslatorFindTermsOptions', vi.fn().mockReturnValue({
        enabledDictionaryMap: new Map([['Test Dictionary', {}]]),
    }));
    Reflect.set(backend, '_hasInstalledDictionaries', vi.fn().mockResolvedValue(false));
    Reflect.set(backend, '_debugDictionaryLookupState', debugLookupState);
    return {backend, findTerms, getDictionaryInfo, debugLookupState};
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('Backend lookup diagnostic error recovery', () => {
    test('dictionary-info failure does not replace a valid lookup result with a ReferenceError', async () => {
        const {backend, findTerms, getDictionaryInfo} = createLookupBackend();
        getDictionaryInfo.mockRejectedValue(new Error('temporary metadata failure'));

        const result = await Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記', details: {}, optionsContext: {depth: 0, url: 'https://example.test/'},
        }, {});

        expect(result).toMatchObject({dictionaryEntries: [], originalTextLength: 2});
        expect(findTerms).toHaveBeenCalledOnce();
        expect(reportDiagnostics).toHaveBeenCalledWith('dictionary-lookup-installed-dictionary-info-failed', expect.objectContaining({
            error: 'temporary metadata failure',
        }));
    });

    test('debug-state failure remains diagnostic and does not abort the completed lookup', async () => {
        const {backend, findTerms, debugLookupState} = createLookupBackend();
        debugLookupState.mockRejectedValue(new Error('temporary debug failure'));

        const result = await Backend.prototype._onApiTermsFind.call(backend, {
            text: '暗記', details: {}, optionsContext: {depth: 0, url: 'https://example.test/'},
        }, {});

        expect(result).toMatchObject({dictionaryEntries: [], originalTextLength: 2});
        expect(findTerms).toHaveBeenCalledOnce();
        expect(debugLookupState).toHaveBeenCalledOnce();
    });
});
