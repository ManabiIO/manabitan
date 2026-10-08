/*
 * Copyright (C) 2026  Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {describe, expect, test} from 'vitest';
import {EventDispatcher} from '../ext/js/core/event-dispatcher.js';

/**
 * @returns {EventDispatcher<import('core').EventSurface>}
 */
function createDispatcher() {
    return new EventDispatcher();
}

describe('EventDispatcher listener mutation', () => {
    test('self-removal cannot skip the following listener', () => {
        const dispatcher = createDispatcher();
        /** @type {string[]} */
        const calls = [];
        const first = () => {
            calls.push('first');
            dispatcher.off('event', first);
        };
        dispatcher.on('event', first);
        dispatcher.on('event', () => { calls.push('second'); });
        dispatcher.on('event', () => { calls.push('third'); });

        expect(dispatcher.trigger('event', void 0)).toBe(true);
        expect(calls).toEqual(['first', 'second', 'third']);
        calls.length = 0;
        dispatcher.trigger('event', void 0);
        expect(calls).toEqual(['second', 'third']);
    });

    test('listeners registered while firing wait until a subsequent emission', () => {
        const dispatcher = createDispatcher();
        /** @type {string[]} */
        const calls = [];
        const lateListener = () => { calls.push('late'); };
        const first = () => {
            calls.push('first');
            dispatcher.on('event', lateListener);
        };
        dispatcher.on('event', first);

        dispatcher.trigger('event', void 0);
        expect(calls).toEqual(['first']);
        dispatcher.off('event', first);
        dispatcher.trigger('event', void 0);
        expect(calls).toEqual(['first', 'late']);
    });

    test('unsubscribing a peer suppresses that callback without skipping other listeners', () => {
        const dispatcher = createDispatcher();
        /** @type {string[]} */
        const calls = [];
        const second = () => { calls.push('second'); };
        dispatcher.on('event', () => {
            calls.push('first');
            dispatcher.off('event', second);
        });
        dispatcher.on('event', second);
        dispatcher.on('event', () => { calls.push('third'); });

        dispatcher.trigger('event', void 0);
        expect(calls).toEqual(['first', 'third']);
        calls.length = 0;
        dispatcher.trigger('event', void 0);
        expect(calls).toEqual(['first', 'third']);
    });

    test('no subscribed event preserves the false return contract', () => {
        const dispatcher = createDispatcher();
        expect(dispatcher.trigger('event', void 0)).toBe(false);
        dispatcher.on('event', () => {});
        expect(dispatcher.trigger('event', void 0)).toBe(true);
    });
});
