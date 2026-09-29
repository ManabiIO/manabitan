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

import {expect, test, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';

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
