/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {describe, expect, test} from 'vitest';
import {EventDispatcher} from '../ext/js/core/event-dispatcher.js';

describe('EventDispatcher mutation during dispatch', () => {
    test('self-removal does not skip the next listener', () => {
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        const first = () => {
            calls.push('first');
            dispatcher.off('event', first);
        };
        dispatcher.on('event', first);
        dispatcher.on('event', () => calls.push('second'));
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'second']);
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'second', 'second']);
    });

    test('removing an earlier listener does not skip a later listener', () => {
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        const first = () => calls.push('first');
        dispatcher.on('event', first);
        dispatcher.on('event', () => {
            calls.push('second');
            dispatcher.off('event', first);
        });
        dispatcher.on('event', () => calls.push('third'));
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'second', 'third']);
    });

    test('a removed pending listener remains cancelled', () => {
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        const removed = () => calls.push('removed');
        dispatcher.on('event', () => {
            calls.push('first');
            dispatcher.off('event', removed);
        });
        dispatcher.on('event', removed);
        dispatcher.on('event', () => calls.push('last'));
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'last']);
    });

    test('new listeners wait for a subsequent dispatch', () => {
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        let added = false;
        dispatcher.on('event', () => {
            calls.push('first');
            if (!added) {
                added = true;
                dispatcher.on('event', () => calls.push('new'));
            }
        });
        dispatcher.on('event', () => calls.push('last'));
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'last']);
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'last', 'first', 'last', 'new']);
    });

    test('removing and readding a pending callback does not revive its old registration', () => {
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        const pending = () => calls.push('pending');
        let replaced = false;
        dispatcher.on('event', () => {
            calls.push('first');
            if (!replaced) {
                replaced = true;
                dispatcher.off('event', pending);
                dispatcher.on('event', pending);
            }
        });
        dispatcher.on('event', pending);
        dispatcher.on('event', () => calls.push('last'));
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'last']);
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'last', 'first', 'last', 'pending']);
    });

    test('self-replacement neither repeats itself nor skips the remaining listener', () => {
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        const first = () => {
            calls.push('first');
            if (calls.length > 10) { throw new Error('Unbounded listener dispatch'); }
            dispatcher.off('event', first);
            dispatcher.on('event', first);
        };
        dispatcher.on('event', first);
        dispatcher.on('event', () => calls.push('last'));
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['first', 'last']);
    });

    test('nested dispatch sees newly registered listeners without adding them to the outer dispatch', () => {
        /** @type {EventDispatcher<{event: string}>} */
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        dispatcher.on('event', (value) => {
            calls.push(`first:${value}`);
            if (value === 'outer') {
                dispatcher.on('event', (nestedValue) => calls.push(`new:${nestedValue}`));
                dispatcher.trigger('event', 'inner');
            }
        });
        dispatcher.on('event', (value) => calls.push(`last:${value}`));
        dispatcher.trigger('event', 'outer');
        expect(calls).toStrictEqual(['first:outer', 'first:inner', 'last:inner', 'new:inner', 'last:outer']);
    });

    test('nested removal cancels pending callbacks in both dispatches', () => {
        /** @type {EventDispatcher<{event: string}>} */
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        const removed = () => calls.push('removed');
        dispatcher.on('event', (value) => {
            calls.push(`first:${value}`);
            if (value === 'outer') {
                dispatcher.trigger('event', 'inner');
            } else {
                dispatcher.off('event', removed);
            }
        });
        dispatcher.on('event', removed);
        dispatcher.trigger('event', 'outer');
        expect(calls).toStrictEqual(['first:outer', 'first:inner']);
    });

    test('duplicate callbacks retain separate registrations and off removes only one', () => {
        const dispatcher = new EventDispatcher();
        let calls = 0;
        const callback = () => { ++calls; };
        dispatcher.on('event', callback);
        dispatcher.on('event', callback);
        dispatcher.trigger('event', null);
        expect(calls).toBe(2);
        expect(dispatcher.off('event', callback)).toBe(true);
        dispatcher.trigger('event', null);
        expect(calls).toBe(3);
        expect(dispatcher.off('event', callback)).toBe(true);
        expect(dispatcher.hasListeners('event')).toBe(false);
    });

    test('removal of one duplicate during dispatch preserves the other', () => {
        const dispatcher = new EventDispatcher();
        /** @type {string[]} */
        const calls = [];
        const callback = () => calls.push('duplicate');
        dispatcher.on('event', () => { dispatcher.off('event', callback); });
        dispatcher.on('event', callback);
        dispatcher.on('event', callback);
        dispatcher.trigger('event', null);
        expect(calls).toStrictEqual(['duplicate']);
    });

    test('a missing callback cannot cancel a registered listener', () => {
        const dispatcher = new EventDispatcher();
        let calls = 0;
        dispatcher.on('event', () => { ++calls; });
        expect(dispatcher.off('event', () => {})).toBe(false);
        expect(dispatcher.trigger('event', null)).toBe(true);
        expect(calls).toBe(1);
        expect(dispatcher.trigger('missing', null)).toBe(false);
    });

    test('removing the last listener keeps the map and trigger result consistent', () => {
        const dispatcher = new EventDispatcher();
        const callback = () => { dispatcher.off('event', callback); };
        dispatcher.on('event', callback);
        expect(dispatcher.trigger('event', null)).toBe(true);
        expect(dispatcher.hasListeners('event')).toBe(false);
        expect(dispatcher.trigger('event', null)).toBe(false);
        expect(dispatcher.off('event', callback)).toBe(false);
    });

    test('callbacks still receive the original details without a receiver', () => {
        const dispatcher = new EventDispatcher();
        const details = {value: 1};
        /** @type {unknown[]} */
        const received = [];
        /**
         * @this {void}
         * @param {unknown} value
         */
        function callback(value) {
            received.push(this, value);
        }
        dispatcher.on('event', callback);
        dispatcher.trigger('event', details);
        expect(received[0]).toBe(undefined);
        expect(received[1]).toBe(details);
    });

    test('listener exceptions still propagate and do not remove other registrations', () => {
        const dispatcher = new EventDispatcher();
        const error = new Error('Listener failure');
        const failing = () => { throw error; };
        let calls = 0;
        dispatcher.on('event', failing);
        dispatcher.on('event', () => { ++calls; });
        expect(() => dispatcher.trigger('event', null)).toThrow(error);
        expect(calls).toBe(0);
        dispatcher.off('event', failing);
        dispatcher.trigger('event', null);
        expect(calls).toBe(1);
    });

    test('removing a callback for another event does not cancel this event', () => {
        const dispatcher = new EventDispatcher();
        let calls = 0;
        const callback = () => { ++calls; };
        dispatcher.on('event', () => { dispatcher.off('other', callback); });
        dispatcher.on('event', callback);
        dispatcher.on('other', callback);
        dispatcher.trigger('event', null);
        expect(calls).toBe(1);
        expect(dispatcher.trigger('other', null)).toBe(false);
    });
});
