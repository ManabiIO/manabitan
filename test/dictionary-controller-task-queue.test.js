/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {describe, expect, test, vi} from 'vitest';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

/**
 * @param {string} name
 * @returns {Function}
 */
function method(name) {
    const value = Reflect.get(DictionaryController.prototype, name);
    if (typeof value !== 'function') { throw new Error(`Missing controller method: ${name}`); }
    return value;
}

/** @returns {DictionaryController} */
function controller() {
    const value = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
    Reflect.set(value, '_isTaskQueueRunning', false);
    return value;
}

describe('DictionaryController active and pending tasks', () => {
    test('runs a delete queued while the same dictionary update is active', async () => {
        const value = controller();
        /** @type {() => void} */
        let finishUpdate = () => {};
        /** @type {Promise<void>} */
        const gate = new Promise((resolve) => {
            finishUpdate = () => {
                resolve();
            };
        });
        const update = vi.fn(async () => { await gate; });
        const remove = vi.fn(async () => {});
        Reflect.set(value, '_dictionaryTaskQueue', [{type: 'update', dictionaryTitle: 'JMdict', downloadUrl: 'first'}]);
        Reflect.set(value, '_updateDictionary', update);
        Reflect.set(value, '_deleteDictionary', remove);

        const running = method('_runTaskQueue').call(value);
        method('_enqueueTask').call(value, {type: 'delete', dictionaryTitle: 'JMdict'});

        expect(update).toHaveBeenCalledOnce();
        expect(remove).not.toHaveBeenCalled();
        expect(value.isDictionaryInTaskQueue('JMdict')).toBe(true);
        finishUpdate();
        await running;

        expect(remove).toHaveBeenCalledExactlyOnceWith('JMdict');
        expect(value.isDictionaryInTaskQueue('JMdict')).toBe(false);
        expect(Reflect.get(value, '_isTaskQueueRunning')).toBe(false);
    });

    test('coalesces pending updates without replacing the update already in flight', async () => {
        const value = controller();
        /** @type {() => void} */
        let finishUpdate = () => {};
        /** @type {Promise<void>} */
        const gate = new Promise((resolve) => {
            finishUpdate = () => {
                resolve();
            };
        });
        const update = vi.fn(async () => { await gate; });
        Reflect.set(value, '_dictionaryTaskQueue', [{type: 'update', dictionaryTitle: 'JMdict', downloadUrl: 'first'}]);
        Reflect.set(value, '_updateDictionary', update);

        const running = method('_runTaskQueue').call(value);
        method('_enqueueTask').call(value, {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: 'superseded'});
        method('_enqueueTask').call(value, {type: 'update', dictionaryTitle: 'JMdict', downloadUrl: 'latest'});
        finishUpdate();
        await running;

        expect(update.mock.calls).toEqual([['JMdict', 'first'], ['JMdict', 'latest']]);
        expect(Reflect.get(value, '_dictionaryTaskQueue')).toEqual([]);
    });

    test('restores the update action after a failed task leaves the queue', async () => {
        const value = controller();
        let updateActionVisible = false;
        Reflect.set(value, '_dictionaryTaskQueue', [{type: 'update', dictionaryTitle: 'JMdict', downloadUrl: 'first'}]);
        Reflect.set(value, '_updateDictionary', vi.fn().mockRejectedValue(new Error('download failed')));
        Reflect.set(value, '_showMutationError', vi.fn());
        Reflect.set(value, '_dictionaryEntries', [{
            dictionaryTitle: 'JMdict',
            showUpdatesAvailableButton() {
                if (!value.isDictionaryInTaskQueue('JMdict')) { updateActionVisible = true; }
            },
        }]);

        await method('_runTaskQueue').call(value);

        expect(Reflect.get(value, '_dictionaryTaskQueue')).toEqual([]);
        expect(updateActionVisible).toBe(true);
    });
});
