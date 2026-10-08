/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {toError} from '../ext/js/core/to-error.js';

describe('toError', () => {
    test('preserves the identity and metadata of existing Error instances', () => {
        const original = new TypeError('bad input');
        expect(toError(original)).toBe(original);
    });

    test('converts ordinary thrown values to errors with their previous messages', () => {
        expect(toError('failure').message).toBe('failure');
        expect(toError(42).message).toBe('42');
        expect(toError(123n).message).toBe('123');
        expect(toError(null).message).toBe('null');
        expect(toError(void 0).message).toBe('undefined');
    });

    test('converts symbols without a secondary TypeError', () => {
        const error = toError(Symbol('failure'));
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Symbol(failure)');
    });

    test('handles objects with no usable string representation', () => {
        const error = toError(Object.create(null));
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Unknown error');
    });

    test('handles objects whose string conversion throws', () => {
        const thrown = {
            toString() { throw new Error('toString failed'); },
            valueOf() { throw new Error('valueOf failed'); },
        };
        expect(toError(thrown).message).toBe('Unknown error');
    });
});
