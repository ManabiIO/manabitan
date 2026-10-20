/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {getDictionaryRuntimeActionPolicy, hasDictionaryRuntimeActionPolicy} from '../ext/js/background/dictionary-runtime-action-policy.js';

const unknownActionPolicy = {
    concurrency: 'exclusive',
    timeoutClass: 'standard',
    retryable: false,
    requiresDatabase: false,
    rejectDuringImport: true,
};

test.each(['constructor', 'toString', '__proto__'])('inherited action name %s receives the unknown-action policy', (action) => {
    expect(hasDictionaryRuntimeActionPolicy(action)).toBe(false);
    expect(getDictionaryRuntimeActionPolicy(action)).toEqual(unknownActionPolicy);
});
