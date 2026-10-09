/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test} from 'vitest';
import {getUnsupportedRuntimeSkipReason} from './firefox/unsupported-runtime-classifier.js';

describe('Firefox E2E unsupported-runtime classification', () => {
    test('does not skip failed dictionary import because diagnostics say opfs-sahpool', () => {
        const failure = 'Jitendex backend content integrity failed after import: ' +
        '{"reason":"no-readable-entry-content","openStorageMode":"opfs-sahpool","hasCreateSyncAccessHandle":true}';

        expect(getUnsupportedRuntimeSkipReason(failure)).toBe('');
    });

    test('does not skip an unexpected lookup failure after successful OPFS initialization', () => {
        const failure = 'Term lookup failed: empty result. backendStorageDiagnostics=' +
        '{"mode":"opfs-sahpool","runtimeContext":{"globalConstructor":"DedicatedWorkerGlobalScope"}}';

        expect(getUnsupportedRuntimeSkipReason(failure)).toBe('');
    });

    for (const failure of [
        'OPFS is required but unavailable',
        'no such vfs: opfs',
        'Firefox runtime does not satisfy opfs-sahpool prerequisites: no worker access',
        'opfs-sahpool runtime prerequisites are unavailable',
        'opfs-sahpool requires a DedicatedWorkerGlobalScope',
    ]) {
        test(`classifies unsupported storage runtime: ${failure}`, () => {
            expect(getUnsupportedRuntimeSkipReason(failure)).toContain('OPFS SyncAccessHandle');
        });
    }

    test('preserves known Selenium startup environment classification', () => {
        expect(getUnsupportedRuntimeSkipReason('Failed to read marionette port')).toContain('Selenium/Marionette');
    });
});
