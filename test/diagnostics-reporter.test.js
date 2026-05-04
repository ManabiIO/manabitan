/*
 * Copyright (C) 2026  Manabitan authors
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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

/**
 * @returns {Promise<void>}
 */
async function settleMicrotasks() {
    for (let i = 0; i < 8; ++i) {
        await Promise.resolve();
    }
}

/**
 * @param {string} manifestName
 * @returns {{storageGet: ReturnType<typeof vi.fn>, storageSet: ReturnType<typeof vi.fn>, fetchMock: ReturnType<typeof vi.fn>}}
 */
function stubRuntime(manifestName) {
    const storageGet = vi.fn((keys, callback) => {
        callback({});
    });
    const storageSet = vi.fn((value, callback) => {
        if (typeof callback === 'function') {
            callback();
        }
    });
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('chrome', {
        runtime: {
            id: 'test-extension-id',
            getManifest: () => ({name: manifestName, version: '0.0.0.0'}),
            lastError: null,
        },
        storage: {
            local: {
                get: storageGet,
                set: storageSet,
            },
        },
    });
    vi.stubGlobal('fetch', fetchMock);
    return {storageGet, storageSet, fetchMock};
}

describe('diagnostics reporter gating', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('release manifests do not emit diagnostics', async () => {
        const {storageGet, storageSet, fetchMock} = stubRuntime('Manabitan Popup Dictionary');
        const {reportDiagnostics, reportDiagnosticsLazy} = await import('../ext/js/core/diagnostics-reporter.js');

        reportDiagnostics('extension-start', {source: 'release'});
        reportDiagnosticsLazy('dictionary-lookup-snapshot', () => {
            throw new Error('lazy payload should not run for release builds');
        });
        await settleMicrotasks();

        expect(storageGet).not.toHaveBeenCalled();
        expect(storageSet).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('dev manifests emit diagnostics by default', async () => {
        const {storageGet, fetchMock} = stubRuntime('Manabitan Popup Dictionary (dev)');
        const {reportDiagnostics} = await import('../ext/js/core/diagnostics-reporter.js');

        reportDiagnostics('extension-start', {source: 'dev'});
        await settleMicrotasks();

        expect(storageGet).toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalled();
    });
});
