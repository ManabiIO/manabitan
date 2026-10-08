/*
 * Copyright (C) 2026  Yomitan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {AudioSystem} from '../ext/js/media/audio-system.js';

/**
 * @param {number} [readyState=0]
 * @returns {HTMLAudioElement}
 */
function createAudio(readyState = 0) {
    const audio = new EventTarget();
    Reflect.set(audio, 'readyState', readyState);
    Reflect.set(audio, 'error', null);
    return /** @type {HTMLAudioElement} */ (/** @type {unknown} */ (audio));
}

describe('AudioSystem pending load lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('resolves immediately when audio has already loaded before listening', async () => {
        const system = new AudioSystem();
        await expect(system._waitForData(createAudio(2))).resolves.toBeUndefined();
    });

    test('releases load listeners and timeout when audio becomes available', async () => {
        vi.useFakeTimers();
        const system = new AudioSystem();
        const audio = createAudio();
        const removeListener = vi.spyOn(audio, 'removeEventListener');
        const pending = system._waitForData(audio);

        audio.dispatchEvent(new Event('loadeddata'));

        await expect(pending).resolves.toBeUndefined();
        expect(removeListener).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('rejects with media error and removes pending timeout', async () => {
        vi.useFakeTimers();
        const system = new AudioSystem();
        const audio = createAudio();
        const error = new Error('Decoder failed');
        const pending = system._waitForData(audio);
        Reflect.set(audio, 'error', error);

        audio.dispatchEvent(new Event('error'));

        await expect(pending).rejects.toBe(error);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('rejects a stalled audio load instead of waiting indefinitely', async () => {
        vi.useFakeTimers();
        const system = new AudioSystem();
        const audio = createAudio();
        const removeListener = vi.spyOn(audio, 'removeEventListener');
        const pending = system._waitForData(audio);
        const assertion = expect(pending).rejects.toThrow('Audio loading timed out');

        await vi.advanceTimersByTimeAsync(30000);

        await assertion;
        expect(removeListener).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});
