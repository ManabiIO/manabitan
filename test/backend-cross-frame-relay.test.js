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
import {Backend} from '../ext/js/background/backend.js';

/** @returns {{backend: Backend, source: ReturnType<typeof createPort>, target: ReturnType<typeof createPort>, connect: ReturnType<typeof vi.fn>}} */
function createRelay() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const source = createPort();
    const target = createPort();
    const connect = vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(target);
    vi.stubGlobal('chrome', {tabs: {connect}, runtime: {}});
    return {backend, source, target, connect};
}

/** @returns {{onMessage: {addListener: ReturnType<typeof vi.fn>, removeListener: ReturnType<typeof vi.fn>}, onDisconnect: {addListener: ReturnType<typeof vi.fn>, removeListener: ReturnType<typeof vi.fn>}, postMessage: ReturnType<typeof vi.fn>, disconnect: ReturnType<typeof vi.fn>}} */
function createPort() {
    return {
        onMessage: {addListener: vi.fn(), removeListener: vi.fn()},
        onDisconnect: {addListener: vi.fn(), removeListener: vi.fn()},
        postMessage: vi.fn(),
        disconnect: vi.fn(),
    };
}

/**
 * @param {Backend} backend
 * @returns {ReturnType<Backend['_onApiOpenCrossFramePort']>}
 */
function openRelay(backend) {
    return backend._onApiOpenCrossFramePort({targetTabId: 2, targetFrameId: 3}, {tab: /** @type {chrome.tabs.Tab} */ ({id: 1}), frameId: 0});
}

describe('Backend cross-frame relay lifetime', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('failure opening the target closes the already-open source', () => {
        const {backend, source, connect} = createRelay();
        connect.mockReset().mockReturnValueOnce(source).mockImplementationOnce(() => { throw new Error('target missing'); });
        expect(() => openRelay(backend)).toThrow('target missing');
        expect(source.disconnect).toHaveBeenCalledTimes(1);
    });

    test.each(['source-message', 'target-message', 'source-disconnect', 'target-disconnect'])('partial listener setup closes both endpoints: %s', (stage) => {
        const {backend, source, target} = createRelay();
        const port = stage.startsWith('source') ? source : target;
        const event = stage.endsWith('message') ? port.onMessage : port.onDisconnect;
        event.addListener.mockImplementation(() => { throw new Error('listener failed'); });
        expect(() => openRelay(backend)).toThrow('listener failed');
        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(target.disconnect).toHaveBeenCalledTimes(1);
    });

    test.each(['source', 'target'])('a failed %s send disconnects both endpoints without escaping its listener', (side) => {
        const {backend, source, target} = createRelay();
        openRelay(backend);
        const sender = side === 'source' ? source : target;
        const receiver = side === 'source' ? target : source;
        receiver.postMessage.mockImplementation(() => { throw new Error('port closed'); });
        expect(() => sender.onMessage.addListener.mock.calls[0][0]({type: 'ack', id: 0})).not.toThrow();
        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(target.disconnect).toHaveBeenCalledTimes(1);
    });

    test.each(['source', 'target'])('cleanup remains complete and idempotent if %s disconnect throws', (side) => {
        const {backend, source, target} = createRelay();
        openRelay(backend);
        const fault = side === 'source' ? source : target;
        fault.disconnect.mockImplementation(() => { throw new Error('already closed'); });
        const cleanup = source.onDisconnect.addListener.mock.calls[0][0];
        expect(() => cleanup()).not.toThrow();
        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(target.disconnect).toHaveBeenCalledTimes(1);
        expect(() => cleanup()).not.toThrow();
        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(target.disconnect).toHaveBeenCalledTimes(1);
    });

    test('successful relay forwards both directions and ignores late messages after cleanup', () => {
        const {backend, source, target} = createRelay();
        expect(openRelay(backend)).toEqual({targetTabId: 2, targetFrameId: 3});
        const sourceMessage = source.onMessage.addListener.mock.calls[0][0];
        const targetMessage = target.onMessage.addListener.mock.calls[0][0];
        const data = {type: 'ack', id: 0};
        sourceMessage(data);
        targetMessage(data);
        expect(source.postMessage).toHaveBeenCalledExactlyOnceWith(data);
        expect(target.postMessage).toHaveBeenCalledExactlyOnceWith(data);
        source.onDisconnect.addListener.mock.calls[0][0]();
        sourceMessage(data);
        targetMessage(data);
        expect(source.postMessage).toHaveBeenCalledTimes(1);
        expect(target.postMessage).toHaveBeenCalledTimes(1);
        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(target.disconnect).toHaveBeenCalledTimes(1);
    });

    test('synchronous disconnect notifications cannot recursively close either endpoint', () => {
        const {backend, source, target} = createRelay();
        openRelay(backend);
        const cleanup = source.onDisconnect.addListener.mock.calls[0][0];
        source.disconnect.mockImplementation(cleanup);
        target.disconnect.mockImplementation(cleanup);
        expect(() => cleanup()).not.toThrow();
        expect(source.disconnect).toHaveBeenCalledTimes(1);
        expect(target.disconnect).toHaveBeenCalledTimes(1);
    });
});
