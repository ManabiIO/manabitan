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
import {Backend} from '../ext/js/background/backend.js';
import {reportDiagnostics} from '../ext/js/core/diagnostics-reporter.js';

vi.mock('../ext/js/core/diagnostics-reporter.js', async (importOriginal) => ({
    .../** @type {Record<string, unknown>} */ (await importOriginal()),
    reportDiagnostics: vi.fn(),
}));

describe('Backend OPFS readiness diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ja":{}}', {status: 200})));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test.each([
        {mode: 'opfs-sahpool', expected: true},
        {mode: 'opfs-sahpool-unavailable', expected: false},
        {mode: 'unknown', expected: false},
        {mode: 'fallback-memory', expected: false},
    ])('recognizes only the successful OPFS mode ($mode)', async ({mode, expected}) => {
        const backend = /** @type {Backend} */ (/** @type {unknown} */ (Object.create(Backend.prototype)));
        Reflect.set(backend, '_dictionaryDatabase', {
            isPrepared: () => true,
            usesFallbackStorage: () => false,
            getOpenStorageDiagnostics: () => ({mode}),
            getDictionaryInfo: async () => [],
        });
        Reflect.set(backend, '_environment', {getInfo: () => ({browser: 'chrome'})});
        Reflect.set(backend, '_startupDiagnosticsSnapshot', {});

        await Backend.prototype._reportStartupHealthCheck.call(backend);

        const healthReports = vi.mocked(reportDiagnostics).mock.calls.filter(([event]) => event === 'startup-health-check');
        expect(healthReports).toHaveLength(1);
        expect(healthReports[0][1]).toMatchObject({
            dbOpened: true,
            opfsReady: expected,
        });
    });
});
