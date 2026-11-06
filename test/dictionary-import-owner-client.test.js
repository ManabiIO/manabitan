/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {DictionaryImportOwnerClient} from '../ext/js/comm/dictionary-import-owner-client.js';

/** @returns {{addListener: ReturnType<typeof vi.fn>, removeListener: ReturnType<typeof vi.fn>, emit: (message?: unknown) => void}} */
function browserEvent() {
    /** @type {Set<(message?: unknown) => void>} */
    const listeners = new Set();
    return {
        addListener: vi.fn((callback) => { listeners.add(callback); }),
        removeListener: vi.fn((callback) => { listeners.delete(callback); }),
        emit(message) { for (const callback of listeners) { callback(message); } },
    };
}

/** @type {DictionaryImportOwnerClient[]} */
const clients = [];
afterEach(() => {
    for (const client of clients.splice(0)) { client.closeAll(); }
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function fixture() {
    vi.useFakeTimers();
    const port = {onMessage: browserEvent(), onDisconnect: browserEvent(), disconnect: vi.fn()};
    const connect = vi.fn(() => port);
    vi.stubGlobal('chrome', {runtime: {connect}});
    const client = new DictionaryImportOwnerClient();
    clients.push(client);
    return {client, port, connect};
}

test.each(['onMessage', 'onDisconnect'])('listener setup failure (%s) rejects readiness and closes the connection', async (eventName) => {
    const {client, port, connect} = fixture();
    port[/** @type {'onMessage'|'onDisconnect'} */ (eventName)].addListener.mockImplementationOnce(() => { throw new Error('context invalidated during setup'); });
    // Capture synchronous throws too, so the regression does not leak its unreturned promise.
    let ready;
    try { ready = client.open('page-A'); } catch (error) {
        const connection = Reflect.get(client, '_connections').get('page-A');
        connection?.ready.catch(() => {});
        throw error;
    }
    await expect(ready).rejects.toThrow('context invalidated during setup');
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const retry = client.open('page-A');
    expect(connect).toHaveBeenCalledTimes(2);
    port.onMessage.emit({type: 'ready', ownerId: 'page-A'});
    await retry;
    client.close('page-A');
    expect(vi.getTimerCount()).toBe(0);
});

test('a listener-removal failure cannot prevent readiness acknowledgement', async () => {
    const {client, port} = fixture();
    const ready = client.open('page-A');
    port.onMessage.removeListener.mockImplementation(() => { throw new Error('context invalidated during removal'); });
    expect(() => { port.onMessage.emit({type: 'ready', ownerId: 'page-A'}); }).not.toThrow();
    await ready;
    expect(vi.getTimerCount()).toBe(0);
    client.close('page-A');
    expect(port.disconnect).toHaveBeenCalledOnce();
});

test('closeAll settles and disconnects every pending owner despite listener-removal failures', async () => {
    const {client, port, connect} = fixture();
    const other = {onMessage: browserEvent(), onDisconnect: browserEvent(), disconnect: vi.fn()};
    connect.mockReturnValueOnce(port).mockReturnValueOnce(other);
    const first = expect(client.open('page-A')).rejects.toThrow(/disconnected/iu);
    const second = expect(client.open('page-B')).rejects.toThrow(/disconnected/iu);
    port.onDisconnect.removeListener.mockImplementation(() => { throw new Error('context invalidated during shutdown'); });
    port.onMessage.removeListener.mockImplementation(() => { throw new Error('context invalidated during shutdown'); });
    expect(() => { client.closeAll(); }).not.toThrow();
    await Promise.all([first, second]);
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(other.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

test('a stale disconnect listener cannot close a replacement connection', async () => {
    const {client, port, connect} = fixture();
    const first = client.open('page-A');
    port.onMessage.emit({type: 'ready', ownerId: 'page-A'});
    await first;
    port.onDisconnect.removeListener.mockImplementation(() => { throw new Error('context invalidated during shutdown'); });
    client.close('page-A');
    const replacement = {onMessage: browserEvent(), onDisconnect: browserEvent(), disconnect: vi.fn()};
    connect.mockReturnValueOnce(replacement);
    const next = client.open('page-A');
    replacement.onMessage.emit({type: 'ready', ownerId: 'page-A'});
    await next;
    port.onDisconnect.emit();
    expect(replacement.disconnect).not.toHaveBeenCalled();
    expect(client.open('page-A')).toBe(next);
    client.close('page-A');
    expect(replacement.disconnect).toHaveBeenCalledOnce();
});
