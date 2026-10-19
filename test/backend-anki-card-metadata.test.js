/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {DisplayAnki} from '../ext/js/display/display-anki.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();

const cardInfos = [
    null,
    {noteId: 700, cardId: 101, flags: 1, cardState: 2},
    {noteId: 700, cardId: 102, flags: 4, cardState: -1},
    {noteId: 700, cardId: 103, flags: 0, cardState: -2},
    {noteId: 800, cardId: 201, flags: 5, cardState: 1},
    {noteId: 800, cardId: 202, flags: 0, cardState: 0},
    {noteId: 999, cardId: 999, flags: 7, cardState: 2},
];

/**
 * @param {number} noteId
 * @param {number[]} cards
 * @returns {import('anki').NoteInfo}
 */
function makeNote(noteId, cards) {
    return {noteId, tags: [`Note ${noteId}`], fields: {}, modelName: 'Cloze', cards, cardsInfo: []};
}

/**
 * @param {(?import('anki').NoteInfo)[]} notesInfo
 * @param {number[]|null} [cardIds]
 * @returns {{backend: Backend, anki: {notesInfo: ReturnType<typeof vi.fn>, cardsInfo: ReturnType<typeof vi.fn>}}}
 */
function makeBackend(notesInfo, cardIds = null) {
    const anki = {
        notesInfo: vi.fn(async () => notesInfo),
        cardsInfo: vi.fn(async (requestedCardIds) => {
            const requested = new Set(cardIds ?? requestedCardIds);
            return cardInfos.filter((cardInfo) => cardInfo === null || requested.has(cardInfo.cardId));
        }),
    };
    return {
        backend: /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {_anki: anki})),
        anki,
    };
}

/**
 * @param {Document} document
 * @returns {DisplayAnki}
 */
function makeDisplay(document) {
    const entry = /** @type {HTMLElement} */ (document.querySelector('.entry'));
    const display = /** @type {DisplayAnki} */ (Object.create(DisplayAnki.prototype));
    display._displayTagsAndFlags = 'always';
    display._noteTags = [];
    display._targetTags = [];
    display._isAdditionalInfoEnabled = () => true;
    display._getEntry = () => entry;
    display._eventListeners = /** @type {DisplayAnki['_eventListeners']} */ (/** @type {unknown} */ ({addEventListener: vi.fn()}));
    display._display = /** @type {DisplayAnki['_display']} */ (/** @type {unknown} */ ({
        displayGenerator: {
            instantiateTemplate: () => {
                const button = document.createElement('button');
                const icon = document.createElement('span');
                icon.className = 'icon';
                icon.dataset.icon = 'view-note';
                const actionIcon = document.createElement('span');
                actionIcon.className = 'action-icon';
                button.append(icon, actionIcon);
                return button;
            },
        },
    }));
    display._onViewNotesButtonClickBind = () => {};
    display._onViewNotesButtonContextMenuBind = () => {};
    display._onViewNotesButtonMenuCloseBind = () => {};
    display._onShowFlagsBind = () => {};
    display._onShowTagsBind = () => {};
    return display;
}

/**
 * @param {Document} document
 */
function makeFixture(document) {
    document.body.innerHTML = '<div class="entry"><div class="note-actions-container"><div class="action-button-container" data-card-format-index="0"></div></div></div>';
}

domTest('all card metadata reaches DisplayAnki without crossing note boundaries', async ({window}) => {
    makeFixture(window.document);
    const notesInfo = [
        makeNote(700, [101, 102, 103]),
        null,
        makeNote(800, [201, 202]),
        makeNote(900, [901]),
    ];
    const {backend, anki} = makeBackend(notesInfo);
    const result = await Backend.prototype._notesCardsInfo.call(backend, [700, 800, 900]);

    expect(result).toBe(notesInfo);
    expect(result.map((note) => note?.noteId ?? null)).toEqual([700, null, 800, 900]);
    expect(result[0]?.cardsInfo.map(({cardId}) => cardId)).toEqual([101, 102, 103]);
    expect(result[2]?.cardsInfo.map(({cardId}) => cardId)).toEqual([201, 202]);
    expect(result[3]?.cardsInfo).toEqual([]);
    expect(anki.cardsInfo).toHaveBeenCalledWith([101, 102, 103, 201, 202, 901]);

    const display = makeDisplay(window.document);
    const viewNoteButton = display._createViewNoteButton(0, 0, [700, 800], result);
    display._setupFlagsIndicator(0, 0, [result[0], result[2]]);
    display._setupTagsIndicator(0, 0, [result[0], result[2]]);

    expect((/** @type {HTMLElement|null} */ (viewNoteButton?.querySelector('.icon')))?.dataset.icon).toBe('view-note-buried');
    expect(viewNoteButton?.title).toBe('View added note (buried)');
    expect([...window.document.querySelectorAll('button')].map(({title}) => title)).toContain('Card flags: Red, Blue, Pink');
    expect([...window.document.querySelectorAll('button')].map(({title}) => title)).toContain('Card tags: Note 700, Note 800');
});

domTest('single card and empty note results retain their existing controls', async ({window}) => {
    makeFixture(window.document);
    const singleNote = makeNote(800, [201]);
    const {backend, anki} = makeBackend([singleNote]);
    const result = await Backend.prototype._notesCardsInfo.call(backend, [800]);

    expect(result).toEqual([singleNote]);
    expect(singleNote.cardsInfo.map(({cardId}) => cardId)).toEqual([201]);
    expect(anki.cardsInfo).toHaveBeenCalledWith([201]);

    const display = makeDisplay(window.document);
    const singleButton = display._createViewNoteButton(0, 0, [800], result);
    display._setupFlagsIndicator(0, 0, result);
    expect((/** @type {HTMLElement|null} */ (singleButton?.querySelector('.icon')))?.dataset.icon).toBe('view-note-learning');
    expect([...window.document.querySelectorAll('button')].map(({title}) => title)).toContain('Card flags: Pink');

    const {backend: emptyBackend, anki: emptyAnki} = makeBackend([]);
    const empty = await Backend.prototype._notesCardsInfo.call(emptyBackend, []);
    expect(empty).toEqual([]);
    expect(emptyAnki.cardsInfo).toHaveBeenCalledWith([]);
    expect(display._setViewNoteButtonCardState([], window.document.createElement('button')).title).toBe('');
    display._setupFlagsIndicator(0, 0, empty);
    display._setupTagsIndicator(0, 0, empty);
    expect(window.document.querySelectorAll('button')).toHaveLength(2);
});
