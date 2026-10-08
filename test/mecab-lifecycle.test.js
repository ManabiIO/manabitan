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
import {Mecab} from '../ext/js/comm/mecab.js';

/**
 * @param {() => void} [postMessage]
 * @returns {{mecab: Mecab, port: {postMessage: import('vitest').Mock, disconnect: import('vitest').Mock}}}
 */
function createConnectedMecab(postMessage = () => {}) {
    const mecab = new Mecab();
    const port = {postMessage: vi.fn(postMessage), disconnect: vi.fn()};
    Reflect.set(mecab, '_port', port);
    return {mecab, port};
}

describe('MeCab native messaging lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    test('explicit disconnect rejects pending calls and clears their timeouts', async () => {
        vi.useFakeTimers();
        const {mecab, port} = createConnectedMecab();
        const request = mecab._invoke('parse_text', {text: '日本語'});
        expect(mecab.isActive()).toBe(true);

        mecab.disconnect();

        await expect(request).rejects.toThrow('MeCab disconnected');
        expect(mecab.isActive()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(port.disconnect).toHaveBeenCalledOnce();
    });

    test('disabling MeCab rejects pending calls instead of leaving them unresolved', async () => {
        vi.useFakeTimers();
        const {mecab} = createConnectedMecab();
        mecab.setEnabled(true);
        const request = mecab._invoke('parse_text', {text: '日本語'});

        mecab.setEnabled(false);

        await expect(request).rejects.toThrow('MeCab disconnected');
        expect(mecab.isActive()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('synchronous native send failure removes the pending request and timer', async () => {
        vi.useFakeTimers();
        const {mecab} = createConnectedMecab(() => {
            throw new Error('native send failed');
        });

        await expect(mecab._invoke('parse_text', {text: '日本語'})).rejects.toThrow('native send failed');

        expect(mecab.isActive()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('native disconnect propagates lastError to pending callers', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('chrome', {runtime: {lastError: {message: 'native host exited'}}});
        const {mecab} = createConnectedMecab();
        const request = mecab._invoke('parse_text', {text: '日本語'});

        mecab._onDisconnect();

        await expect(request).rejects.toThrow('native host exited');
        expect(mecab.isActive()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});
