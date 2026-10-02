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

import {JSDOM} from 'jsdom';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';
import {DisplayHistory} from '../ext/js/display/display-history.js';

/** @returns {{display: Display, clear: ReturnType<typeof vi.fn>, finish: () => void}} */
function createDisplay() {
    let finish = () => {};
    const pending = new Promise((resolve) => { finish = () => resolve(void 0); });
    const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
    const clear = vi.fn(() => {
        Reflect.set(display, '_setContentToken', {});
        Reflect.set(display, '_activePublication', null);
    });
    Reflect.set(display, '_activePublication', null);
    Reflect.set(display, '_publicationGenerations', new Map());
    Reflect.set(display, '_setContentToken', null);
    Reflect.set(display, 'setContent', () => {
        Reflect.set(display, '_activePublication', null);
        Reflect.set(display, '_setContentToken', {});
        return pending;
    });
    Reflect.set(display, 'invalidateSearchDraft', clear);
    return {display, clear, finish};
}

/**
 * @param {Display} display
 * @param {import('popup').PublicationToken} [publication]
 * @returns {Promise<void>}
 */
async function show(display, publication) {
    await Reflect.get(Display.prototype, '_onMessageSetContent').call(display, {
        details: {focus: false, params: {type: 'terms', query: ''}, state: {}, content: {}, historyMode: 'clear'},
        publication,
    });
}

/**
 * @param {Display} display
 * @param {import('popup').PublicationToken} publication
 */
function cancel(display, publication) {
    Reflect.get(Display.prototype, '_onMessageCancelPublication').call(display, {publication});
}

test('cancellation invalidates the currently rendering reader content', async () => {
    const {display, clear, finish} = createDisplay();
    const publication = {source: 'reader', generation: 1};
    const completion = show(display, publication);
    cancel(display, publication);
    expect(clear).toHaveBeenCalledOnce();
    cancel(display, publication);
    expect(clear).toHaveBeenCalledOnce();
    finish();
    await completion;
});

test.each([{source: 'reader', generation: 2}, void 0])('old cancellation cannot clear a newer lookup: %j', async (publication) => {
    const {display, clear, finish} = createDisplay();
    const oldPublication = {source: 'reader', generation: 1};
    const old = show(display, oldPublication);
    const current = show(display, publication);
    cancel(display, oldPublication);
    expect(clear).not.toHaveBeenCalled();
    finish();
    await Promise.all([old, current]);
});

test('old cancellation cannot clear an independent history or options render', async () => {
    const {display, clear, finish} = createDisplay();
    const publication = {source: 'reader', generation: 1};
    const completion = show(display, publication);
    Reflect.set(display, '_setContentToken', {});
    cancel(display, publication);
    expect(clear).not.toHaveBeenCalled();
    finish();
    await completion;
});

test('cancellation arriving before content prevents that content from starting', async () => {
    const {display, clear} = createDisplay();
    const setContent = vi.spyOn(display, 'setContent');
    const publication = {source: 'reader', generation: 1};
    cancel(display, publication);
    await show(display, publication);
    expect(setContent).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
});

test('late content cannot replace a newer publication and state grows per owner', async () => {
    const {display, finish} = createDisplay();
    const setContent = vi.spyOn(display, 'setContent');
    const current = show(display, {source: 'reader', generation: 2});
    await show(display, {source: 'reader', generation: 1});
    expect(setContent).toHaveBeenCalledOnce();
    expect(Reflect.get(display, '_publicationGenerations').size).toBe(1);
    finish();
    await current;
});

/**
 * Production message, history, and state-change handlers; only rendering dependencies are replaced.
 * @returns {{display: Display, renders: {finish: () => void, token: object}[], handlers: Promise<void>[], render: () => Promise<void>}}
 */
function createRenderingDisplay() {
    const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
    const history = new DisplayHistory(true, false);
    /** @type {{finish: () => void, token: object}[]} */
    const renders = [];
    /** @type {Promise<void>[]} */
    const handlers = [];
    for (const [key, value] of Object.entries({
        _history: history,
        _historyChangeIgnore: false,
        _historyHasChanged: false,
        _stateChangeCompleteResolvers: [],
        _activePublication: null,
        _publicationGenerations: new Map(),
        _setContentToken: null,
        _options: null,
        _eventListeners: {removeAllEventListeners: vi.fn()},
        _contentManager: {unloadAll: vi.fn()},
        _elementOverflowController: {clearElements: vi.fn()},
        _container: {textContent: ''},
    })) {
        Reflect.set(display, key, value);
    }
    for (const key of [
        '_closePopups',
        '_closeAllPopupMenus',
        '_hideTagNotification',
        '_hideInflectionNotification',
        '_triggerContentClear',
        '_setNoContentVisible',
        '_setNoDictionariesVisible',
        '_clearContent',
    ]) {
        Reflect.set(display, key, vi.fn());
    }
    Reflect.set(display, 'onError', vi.fn());
    /**
     * @param {string} _type
     * @param {URLSearchParams} _params
     * @param {object} token
     * @returns {Promise<void>}
     */
    function renderTerms(_type, _params, token) {
        return new Promise((resolve) => {
            renders.push({token, finish: () => resolve(void 0)});
        });
    }
    Reflect.set(display, '_setContentTermsOrKanji', renderTerms);
    const render = () => {
        const completion = Reflect.get(Display.prototype, '_onStateChanged').call(display);
        handlers.push(completion);
        return completion;
    };
    history.on('stateChanged', render);
    return {display, renders, handlers, render};
}

describe('per-render publication completion ownership', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        const {window} = new JSDOM('', {url: 'https://example.com/search.html?type=terms'});
        vi.stubGlobal('location', window.location);
        vi.stubGlobal('history', window.history);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    test.each(['older-first', 'newer-first'])('overlapping renders settle only their own publication: %s', async (order) => {
        const {display, renders, handlers} = createRenderingDisplay();
        const olderDone = vi.fn();
        const newerDone = vi.fn();
        const older = show(display, {source: 'reader', generation: 1}).then(olderDone);
        const newer = show(display, {source: 'reader', generation: 2}).then(newerDone);
        // The new render starts immediately, without waiting for obsolete work.
        expect(renders).toHaveLength(2);
        expect(Reflect.get(display, '_setContentToken')).toBe(renders[1].token);
        expect(vi.getTimerCount()).toBe(2);
        const first = order === 'older-first' ? 0 : 1;
        renders[first].finish();
        await handlers[first];
        await (first === 0 ? older : newer);
        expect(first === 0 ? newerDone : olderDone).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        renders[1 - first].finish();
        await Promise.all([older, newer, ...handlers]);
        expect(olderDone).toHaveBeenCalledOnce();
        expect(newerDone).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    test.each([true, false])('obsolete work cannot acknowledge or cancel the current render (cancel old first: %s)', async (cancelOldFirst) => {
        const {display, renders, handlers} = createRenderingDisplay();
        const oldPublication = {source: 'reader', generation: 1};
        const currentPublication = {source: 'reader', generation: 2};
        const older = show(display, oldPublication);
        if (cancelOldFirst) {
            cancel(display, oldPublication);
            expect(Reflect.get(display, '_setContentToken')).not.toBe(renders[0].token);
        }
        const currentDone = vi.fn();
        const current = show(display, currentPublication).then(currentDone);
        const currentToken = renders[1].token;
        cancel(display, oldPublication);
        expect(Reflect.get(display, '_setContentToken')).toBe(currentToken);
        renders[0].finish();
        await handlers[0];
        await older;
        expect(currentDone).not.toHaveBeenCalled();
        // A caller still waiting for confirmation can cancel the actual current render.
        cancel(display, currentPublication);
        expect(Reflect.get(display, '_setContentToken')).not.toBe(currentToken);
        renders[1].finish();
        await Promise.all([current, ...handlers]);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('initialization without waiters cannot acknowledge a later publication', async () => {
        const {display, renders, handlers, render} = createRenderingDisplay();
        const initialization = render();
        const done = vi.fn();
        const publication = show(display, {source: 'reader', generation: 1}).then(done);
        renders[0].finish();
        await initialization;
        expect(done).not.toHaveBeenCalled();
        renders[1].finish();
        await Promise.all([publication, ...handlers]);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('ignored history changes leave waiters for the next actual render', async () => {
        const {display, renders, handlers, render} = createRenderingDisplay();
        Reflect.set(display, '_historyChangeIgnore', true);
        const done = vi.fn();
        const publication = show(display, {source: 'reader', generation: 1}).then(done);
        await handlers[0];
        expect(renders).toHaveLength(0);
        expect(done).not.toHaveBeenCalled();
        expect(Reflect.get(display, '_stateChangeCompleteResolvers')).toHaveLength(1);
        Reflect.set(display, '_historyChangeIgnore', false);
        const completion = render();
        renders[0].finish();
        await Promise.all([publication, completion]);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('a timed-out publication invalidates its own pending render and rejects the RPC', async () => {
        const {display, renders, handlers} = createRenderingDisplay();
        const oldPublication = {source: 'reader', generation: 1};
        const older = show(display, oldPublication);
        const failure = expect(older).rejects.toMatchObject({name: 'PopupContentTimeoutError', message: 'Popup content rendering timed out'});
        const oldToken = renders[0].token;
        await vi.advanceTimersByTimeAsync(5000);
        await failure;
        expect(Reflect.get(display, '_setContentToken')).not.toBe(oldToken);
        expect(Reflect.get(display, '_activePublication')).toBeNull();
        await show(display, oldPublication);
        expect(renders).toHaveLength(1);
        const done = vi.fn();
        const current = show(display, {source: 'reader', generation: 2}).then(done);
        renders[0].finish();
        await handlers[0];
        expect(done).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        renders[1].finish();
        await Promise.all([current, ...handlers]);
        expect(vi.getTimerCount()).toBe(0);
    });

    test.each([1, 2])('an old timeout cannot invalidate a newer publication, even with the same generation: %s', async (generation) => {
        const {display, renders, handlers} = createRenderingDisplay();
        const older = show(display, {source: 'reader', generation: 1});
        await vi.advanceTimersByTimeAsync(1000);
        const done = vi.fn();
        const current = show(display, {source: 'reader', generation}).then(done);
        await vi.advanceTimersByTimeAsync(4000);
        await older;
        expect(done).not.toHaveBeenCalled();
        expect(Reflect.get(display, '_setContentToken')).toBe(renders[1].token);
        expect(Reflect.get(display, '_publicationGenerations').get('reader')?.cancelled).toBe(false);
        renders[0].finish();
        await handlers[0];
        expect(done).not.toHaveBeenCalled();
        renders[1].finish();
        await Promise.all([current, ...handlers]);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('publication timeout cannot clear an independent history render', async () => {
        const {display, renders, handlers, render} = createRenderingDisplay();
        const publication = show(display, {source: 'reader', generation: 1});
        const independent = render();
        const token = renders[1].token;
        await vi.advanceTimersByTimeAsync(5000);
        await publication;
        expect(Reflect.get(display, '_setContentToken')).toBe(token);
        renders[0].finish();
        renders[1].finish();
        await Promise.all([independent, ...handlers]);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('ordinary popup timeout still resolves without invalidating its render', async () => {
        const {display, renders, handlers} = createRenderingDisplay();
        const completion = display.setContent({focus: false, params: {type: 'terms'}, state: {}, content: {}, historyMode: 'clear'});
        const token = renders[0].token;
        await vi.advanceTimersByTimeAsync(5000);
        expect(await completion).toBe(false);
        expect(Reflect.get(display, '_setContentToken')).toBe(token);
        renders[0].finish();
        await Promise.all(handlers);
        expect(vi.getTimerCount()).toBe(0);
    });
});
