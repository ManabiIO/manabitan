/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {log} from '../ext/js/core/log.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Error logging robustness', () => {
    test('a thrown Symbol can be logged without another exception', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => log.error(Symbol('failure'))).not.toThrow();
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0][0]).toContain('Symbol(failure)');
    });

    test('an object without a string representation can be logged', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => log.error(Object.create(null))).not.toThrow();
        expect(spy.mock.calls[0][0]).toContain('Unknown error');
    });

    test('a thrown string conversion does not hide the original failure', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const value = {
            toString() { throw new Error('cannot stringify'); },
            valueOf() { throw new Error('cannot convert'); },
        };
        expect(() => log.error(value)).not.toThrow();
        expect(spy.mock.calls[0][0]).toContain('Unknown error');
    });

    test('circular extension error data remains reportable', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        /** @type {{self?: unknown}} */
        const data = {};
        data.self = data;
        const error = new ExtensionError('failed import');
        error.data = data;
        expect(() => log.error(error)).not.toThrow();
        expect(spy.mock.calls[0][0]).toContain('failed import');
        expect(spy.mock.calls[0][0]).toContain('Data: [unserializable]');
    });

    test('a subscriber exception cannot escape the logger', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const listener = () => { throw new Error('subscriber error'); };
        log.on('logGenericError', listener);
        try {
            expect(() => log.error(new Error('original failure'))).not.toThrow();
            expect(spy).toHaveBeenCalledTimes(2);
            expect(spy.mock.calls[0][0]).toContain('original failure');
            expect(spy.mock.calls[1][0]).toContain('logGenericError listener');
        } finally {
            log.off('logGenericError', listener);
        }
    });
});
