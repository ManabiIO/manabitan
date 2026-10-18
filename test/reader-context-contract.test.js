/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {parseReaderLookup, ReaderLookupBridge} from '../ext/js/app/reader-lookup-bridge.js';
import {setupDomTest} from './fixtures/dom-test.js';

const request = {protocol: 1, term: '食べる', reading: 'たべる', surface: '食べた', offset: 2, contextID: 'sentence-1'};
const context = {protocol: 1, id: 'sentence-1', text: '私は食べた。'};
const environment = await setupDomTest();
const {document} = environment.window;
/** @type {ReaderLookupBridge[]} */
const bridges = [];

/**
 * @typedef {import('../ext/js/app/reader-lookup-bridge.js').ReaderLookup} ReaderLookup
 * @typedef {(cancel: () => void) => (() => void)} Subscribe
 * @typedef {(request: ReaderLookup, anchor: Element, isCurrent: () => boolean, subscribe: Subscribe) => Promise<void>} ShowLookup
 * @typedef {{owner: HTMLParagraphElement, anchor: HTMLSpanElement, show: import('vitest').Mock<ShowLookup>, invalidateSearch: import('vitest').Mock<() => void>, bridge: ReaderLookupBridge}} Receiver
 */

afterEach(() => {
    for (const bridge of bridges) { bridge.dispose(); }
    bridges.length = 0;
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
    vi.restoreAllMocks();
});
afterAll(async () => { await environment.teardown(global); });

/**
 * @param {() => boolean} [enabled]
 * @returns {Receiver}
 */
function createReceiver(enabled = () => true) {
    const owner = document.createElement('p');
    owner.dataset.readerLookupContext = JSON.stringify(context);
    const anchor = document.createElement('span');
    anchor.textContent = request.surface;
    anchor.dataset.readerLookup = JSON.stringify(request);
    owner.append('私は', anchor, '。');
    document.body.append(owner);
    /** @type {ShowLookup} */
    const showImplementation = async (_lookup, _anchor, _isCurrent, _subscribe) => {};
    const show = vi.fn(showImplementation);
    const invalidateSearch = vi.fn();
    const bridge = new ReaderLookupBridge({document, enabled, show, invalidateSearch});
    bridges.push(bridge);
    return {owner, anchor, show, invalidateSearch, bridge};
}

/**
 * jsdom cannot dispatch trusted input. Call the registered handler with a typed
 * fixture; real browser trust and capture-order arbitration need browser tests.
 * @param {ReaderLookupBridge} bridge
 * @param {'_pointerDown'|'_pointerMove'|'_click'} method
 * @param {PointerEvent} event
 */
function deliver(bridge, method, event) {
    const handler = Reflect.get(bridge, method);
    if (typeof handler !== 'function') { throw new Error(`Missing receiver handler: ${method}`); }
    handler.call(bridge, event);
}

/**
 * @param {Element} target
 * @param {Partial<PointerEvent>} [overrides]
 * @returns {PointerEvent}
 */
function inputEvent(target, overrides = {}) {
    return /** @type {PointerEvent} */ (/** @type {unknown} */ ({
        target,
        isTrusted: true,
        isPrimary: true,
        button: 0,
        detail: 1,
        clientX: 10,
        clientY: 20,
        timeStamp: 100,
        defaultPrevented: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        ...overrides,
    }));
}

/**
 * @param {ReturnType<typeof createReceiver>} receiver
 * @param {Partial<PointerEvent>} [overrides]
 * @returns {PointerEvent}
 */
function activate(receiver, overrides = {}) {
    deliver(receiver.bridge, '_pointerDown', inputEvent(receiver.anchor));
    const click = inputEvent(receiver.anchor, {timeStamp: 150, ...overrides});
    deliver(receiver.bridge, '_click', click);
    return click;
}

/**
 * @param {ReturnType<typeof createReceiver>} receiver
 * @returns {() => boolean}
 */
function currentLookup(receiver) {
    const call = receiver.show.mock.calls[0];
    if (typeof call === 'undefined') { throw new Error('Expected an activated lookup'); }
    return call[2];
}

describe('Reader sentence context protocol', () => {
    test('resolves one sentence context to the original lookup contract', () => {
        const result = parseReaderLookup(JSON.stringify(request), JSON.stringify(context));
        expect(result).toMatchObject({sentence: context.text, offset: 2, surface: '食べた'});
        expect(result).not.toHaveProperty('contextID');
    });

    test('rejects missing, foreign, ambiguous or malformed context', () => {
        for (const raw of [null, 'not JSON', JSON.stringify({...context, id: 'other'}), JSON.stringify({...context, text: '食べる'}), JSON.stringify({...context, protocol: 2})]) {
            expect(parseReaderLookup(JSON.stringify(request), raw)).toBeNull();
        }
        expect(parseReaderLookup(JSON.stringify({...request, sentence: context.text}), JSON.stringify(context))).toBeNull();
    });

    test('checks context and sentence limits after resolving the reference', () => {
        expect(parseReaderLookup(JSON.stringify(request), JSON.stringify({...context, text: '私'.repeat(17000)}))).toBeNull();
        expect(parseReaderLookup(JSON.stringify({...request, contextID: 'x'.repeat(513)}), JSON.stringify(context))).toBeNull();
    });
});

describe('Reader DOM receiver', () => {
    test('activates trusted primary input and hands off the original sentence', () => {
        const receiver = createReceiver();
        const click = activate(receiver);
        expect(receiver.show).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({sentence: context.text, offset: 2}), receiver.anchor, expect.any(Function), expect.any(Function));
        expect(receiver.invalidateSearch).toHaveBeenCalledOnce();
        expect(click.preventDefault).toHaveBeenCalledOnce();
        expect(click.stopImmediatePropagation).toHaveBeenCalledOnce();
        expect(currentLookup(receiver)()).toBe(true);
    });

    test('accepts trusted assistive activation without a pointer gesture', () => {
        const receiver = createReceiver();
        deliver(receiver.bridge, '_click', inputEvent(receiver.anchor, {detail: 0}));
        expect(receiver.show).toHaveBeenCalledOnce();
    });

    test('rejects synthetic dispatched clicks', () => {
        const receiver = createReceiver();
        const click = new environment.window.MouseEvent('click', {bubbles: true, cancelable: true});
        receiver.anchor.dispatchEvent(click);
        expect(receiver.show).not.toHaveBeenCalled();
        expect(click.defaultPrevented).toBe(false);
    });

    test.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey'])('leaves %s activation alone', (modifier) => {
        const receiver = createReceiver();
        const click = activate(receiver, {[modifier]: true});
        expect(receiver.show).not.toHaveBeenCalled();
        expect(click.preventDefault).not.toHaveBeenCalled();
    });

    test.each([{isTrusted: false}, {button: 1}, {defaultPrevented: true}, {timeStamp: 801}])('rejects ineligible clicks: %j', (overrides) => {
        const receiver = createReceiver();
        const click = activate(receiver, overrides);
        expect(receiver.show).not.toHaveBeenCalled();
        expect(click.preventDefault).not.toHaveBeenCalled();
    });

    test('leaves selected text alone', () => {
        const receiver = createReceiver();
        const range = document.createRange();
        range.selectNodeContents(receiver.anchor);
        document.getSelection()?.addRange(range);
        const click = activate(receiver);
        expect(receiver.show).not.toHaveBeenCalled();
        expect(click.preventDefault).not.toHaveBeenCalled();
    });

    test('rejects a drag even when the pointer returns to its starting position', () => {
        const receiver = createReceiver();
        deliver(receiver.bridge, '_pointerDown', inputEvent(receiver.anchor));
        deliver(receiver.bridge, '_pointerMove', inputEvent(receiver.anchor, {clientX: 30}));
        deliver(receiver.bridge, '_pointerMove', inputEvent(receiver.anchor));
        const click = inputEvent(receiver.anchor, {timeStamp: 150});
        deliver(receiver.bridge, '_click', click);
        expect(receiver.show).not.toHaveBeenCalled();
        expect(click.preventDefault).not.toHaveBeenCalled();
    });

    test.each(['a', 'button', 'input', 'textarea', 'select', 'role', 'editable'])('leaves interactive %s ancestors alone', (kind) => {
        const receiver = createReceiver();
        const interactive = document.createElement(kind === 'role' || kind === 'editable' ? 'div' : kind);
        if (kind === 'role') { interactive.setAttribute('role', 'button'); }
        if (kind === 'editable') { interactive.setAttribute('contenteditable', 'true'); }
        receiver.anchor.replaceWith(interactive);
        interactive.append(receiver.anchor);
        const click = activate(receiver);
        expect(receiver.show).not.toHaveBeenCalled();
        expect(click.preventDefault).not.toHaveBeenCalled();
    });

    test.each(['foreign', 'malformed', 'rendered-text', 'offset', 'surface'])('rejects invalid DOM context: %s', (kind) => {
        const receiver = createReceiver();
        if (kind === 'foreign') { receiver.owner.dataset.readerLookupContext = JSON.stringify({...context, id: 'other'}); }
        if (kind === 'malformed') { receiver.owner.dataset.readerLookupContext = 'not JSON'; }
        if (kind === 'rendered-text') { receiver.owner.prepend('違う'); }
        if (kind === 'surface') { receiver.anchor.textContent = '食べる'; }
        if (kind === 'offset') {
            receiver.owner.replaceChildren('食べた', receiver.anchor, '。');
            receiver.owner.dataset.readerLookupContext = JSON.stringify({...context, text: '食べた食べた。'});
            receiver.anchor.dataset.readerLookup = JSON.stringify({...request, offset: 0});
        }
        const click = activate(receiver);
        expect(receiver.show).not.toHaveBeenCalled();
        expect(click.preventDefault).not.toHaveBeenCalled();
    });

    test('ignores ruby annotations while validating the rendered base-text span', () => {
        const receiver = createReceiver();
        const ruby = document.createElement('ruby');
        const annotation = document.createElement('rt');
        annotation.textContent = 'たべた';
        ruby.append(request.surface, annotation);
        receiver.anchor.replaceChildren(ruby);
        activate(receiver);
        expect(receiver.show).toHaveBeenCalledOnce();
        expect(currentLookup(receiver)()).toBe(true);
    });

    test.each(['anchor-data', 'context-data', 'surface', 'context-text', 'anchor-detached', 'context-detached', 'reparented'])('invalidates pending presentation after %s', (kind) => {
        const receiver = createReceiver();
        activate(receiver);
        const isCurrent = currentLookup(receiver);
        expect(isCurrent()).toBe(true);
        if (kind === 'anchor-data') { receiver.anchor.dataset.readerLookup = '{}'; }
        if (kind === 'context-data') { receiver.owner.dataset.readerLookupContext = '{}'; }
        if (kind === 'surface') { receiver.anchor.textContent = '食べる'; }
        if (kind === 'context-text') { receiver.owner.prepend('違う'); }
        if (kind === 'anchor-detached') { receiver.anchor.remove(); }
        if (kind === 'context-detached') { receiver.owner.remove(); }
        if (kind === 'reparented') { document.body.append(receiver.anchor); }
        expect(isCurrent()).toBe(false);
    });

    test('invalidates superseded, disabled, explicitly invalidated and disposed lookups', () => {
        let enabled = true;
        const receiver = createReceiver(() => enabled);
        activate(receiver);
        const first = currentLookup(receiver);
        activate(receiver);
        expect(first()).toBe(false);
        const second = receiver.show.mock.calls[1][2];
        expect(second()).toBe(true);
        enabled = false;
        expect(second()).toBe(false);
        const click = activate(receiver);
        expect(receiver.show).toHaveBeenCalledTimes(2);
        expect(click.preventDefault).not.toHaveBeenCalled();
        enabled = true;
        receiver.bridge.invalidate();
        expect(second()).toBe(false);
        activate(receiver);
        const latest = receiver.show.mock.calls[2][2];
        receiver.bridge.dispose();
        expect(latest()).toBe(false);
    });

    test.each(['mutation', 'detachment', 'pagehide', 'dispose', 'invalidate', 'superseded'])('cancels subscribed pending work after %s', async (kind) => {
        const receiver = createReceiver();
        const cancel = vi.fn();
        const {promise, resolve} = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        receiver.show.mockImplementation(async (_lookup, _anchor, _isCurrent, subscribe) => {
            subscribe(cancel);
            await promise;
        });
        activate(receiver);
        expect(cancel).not.toHaveBeenCalled();
        if (kind === 'mutation') { receiver.anchor.dataset.readerLookup = '{}'; }
        if (kind === 'detachment') { receiver.owner.remove(); }
        if (kind === 'pagehide') { environment.window.dispatchEvent(new environment.window.Event('pagehide')); }
        if (kind === 'dispose') { receiver.bridge.dispose(); }
        if (kind === 'invalidate') { receiver.bridge.invalidate(); }
        if (kind === 'superseded') { activate(receiver); }
        if (kind === 'mutation' || kind === 'detachment') {
            await Promise.resolve();
        }
        expect(cancel).toHaveBeenCalledOnce();
        resolve();
        await promise;
    });

    test.each(['unsubscribe', 'settled'])('cleans up cancellation subscriptions after %s', async (kind) => {
        const receiver = createReceiver();
        const cancel = vi.fn();
        const {promise, resolve} = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        let unsubscribe = () => {};
        receiver.show.mockImplementation(async (_lookup, _anchor, _isCurrent, subscribe) => {
            unsubscribe = subscribe(cancel);
            await promise;
        });
        activate(receiver);
        if (kind === 'unsubscribe') {
            unsubscribe();
            unsubscribe();
        }
        resolve();
        await vi.waitFor(() => { expect(receiver.show.mock.settledResults[0]?.type).toBe('fulfilled'); });
        receiver.anchor.dataset.readerLookup = '{}';
        receiver.bridge.invalidate();
        await Promise.resolve();
        expect(cancel).not.toHaveBeenCalled();
    });
});
