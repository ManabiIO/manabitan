/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {ExtensionError} from '../ext/js/core/extension-error.js';

describe('ExtensionError.deserialize', () => {
    test('preserves ordinary serialized Error details', () => {
        const original = new Error('transport unavailable');
        const result = ExtensionError.deserialize(ExtensionError.serialize(original));
        expect(result).toBeInstanceOf(ExtensionError);
        expect(result.message).toBe(original.message);
        expect(result.name).toBe('Error');
        expect(result.stack).toBe(original.stack);
    });

    test('preserves ExtensionError data', () => {
        const original = new ExtensionError('import failed');
        original.data = {source: 'dictionary', retryable: true};
        const result = ExtensionError.deserialize(ExtensionError.serialize(original));
        expect(result.name).toBe('ExtensionError');
        expect(result.data).toEqual({source: 'dictionary', retryable: true});
    });

    test('handles serialized Symbol errors without throwing again', () => {
        const serialized = ExtensionError.serialize(Symbol('offline'));
        const result = ExtensionError.deserialize(serialized);
        expect(result.message).toBe('Error of type symbol: Symbol(offline)');
    });

    test('preserves conversion failure as a transport decode error', () => {
        const value = {
            toString() { throw new Error('string conversion failed'); },
            valueOf() { throw new Error('value conversion failed'); },
        };
        const serialized = /** @type {import('core').SerializedError} */ ({hasValue: true, value});
        expect(() => ExtensionError.deserialize(serialized)).toThrow('string conversion failed');
    });

    test('rejects malformed non-object replies for caller transport recovery', () => {
        for (const value of [null, undefined, 'bad error', 7]) {
            expect(() => ExtensionError.deserialize(/** @type {import('core').SerializedError} */ (/** @type {unknown} */ (value)))).toThrow(TypeError);
        }
    });

    test('keeps sensible defaults when a malformed error object omits strings', () => {
        const result = ExtensionError.deserialize(/** @type {import('core').SerializedError} */ (/** @type {unknown} */ ({
            name: 4,
            message: null,
            stack: null,
        })));
        expect(result.message).toBe('Unknown error');
        expect(result.name).toBe('ExtensionError');
        expect(typeof result.stack).toBe('string');
    });
});


test('nonconvertible serialized values retain the transport TypeError boundary', () => {
    const serialized = /** @type {import('core').SerializedError} */ (/** @type {unknown} */ ({
        hasValue: true, value: {toString: null, valueOf: null},
    }));
    expect(() => ExtensionError.deserialize(serialized)).toThrow(TypeError);
});
