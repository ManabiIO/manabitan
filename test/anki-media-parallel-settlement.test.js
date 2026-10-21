/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {AnkiNoteBuilder} from '../ext/js/data/anki-note-builder.js';

/**
 * @template T
 * @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void}}
 */
function deferred() {
    /** @type {(value: T) => void} */
    let resolve = () => {};
    /** @type {(error: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<T>} */
    const promise = new Promise((resolve2, reject2) => {
        resolve = resolve2;
        reject = reject2;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve(); }
}

function media() {
    return {audioFileName: null, screenshotFileName: null, clipboardImageFileName: null, clipboardText: null, dictionaryMedia: [], errors: []};
}

function setup() {
    const injection = deferred();
    const parsing = deferred();
    const api = {injectAnkiNoteMedia: vi.fn(() => injection.promise), parseText: vi.fn(() => parsing.promise)};
    const builder = new AnkiNoteBuilder(
        /** @type {import('anki-note-builder').MinimalApi} */ (/** @type {unknown} */ (api)),
        /** @type {import('../ext/js/templates/template-renderer.js').TemplateRenderer} */ (/** @type {unknown} */ ({})),
    );
    const details = /** @type {import('anki-note-builder').CreateNoteDetails} */ ({
        dictionaryEntry: {
            type: 'term',
            headwords: [{term: '漢字', reading: 'かんじ', sources: [{deinflectedText: '漢字'}]}],
        },
        cardFormat: {type: 'term', deck: 'Deck', model: 'Basic', fields: {}},
        context: {url: '', sentence: {text: '漢字', offset: 0}},
        template: '',
        requirements: [{type: 'textFurigana', text: '漢字', readingMode: null}],
        mediaOptions: {textParsing: {optionsContext: {index: 0}, scanLength: 10}},
    });
    return {builder, api, injection, parsing, details};
}

test('furigana failure settles note generation while media is still pending', async () => {
    const {builder, api, injection, parsing, details} = setup();
    const failure = new Error('Parser unavailable');
    /** @type {unknown} */
    let rejection;
    const observed = builder.createNote(details).catch((error) => { rejection = error; });
    try {
        await flush();
        expect(api.injectAnkiNoteMedia).toHaveBeenCalledOnce();
        expect(api.parseText).toHaveBeenCalledOnce();
        parsing.reject(failure);
        await flush();
        expect(rejection).toBe(failure);
    } finally {
        injection.resolve(media());
        await observed;
    }
});

test('a late parser failure remains handled after media collection fails', async () => {
    const {builder, injection, parsing, details} = setup();
    const failure = new Error('Media unavailable');
    const observed = builder.createNote(details).catch((error) => error);
    await flush();
    injection.reject(failure);
    expect(await observed).toBe(failure);
    parsing.reject(new Error('Late parser failure'));
    await flush();
});

test('a synchronous media API throw remains handled with a later parser rejection', async () => {
    const {builder, api, parsing, details} = setup();
    const failure = new Error('Media API unavailable');
    api.injectAnkiNoteMedia.mockImplementation(() => { throw failure; });
    const observed = builder.createNote(details).catch((error) => error);
    await flush();
    expect(api.parseText).toHaveBeenCalledOnce();
    expect(await observed).toBe(failure);
    parsing.reject(new Error('Late parser failure'));
    await flush();
});

test('healthy media and parsing overlap and produce a note', async () => {
    const {builder, api, injection, parsing, details} = setup();
    const request = builder.createNote(details);
    try {
        await flush();
        expect(api.injectAnkiNoteMedia).toHaveBeenCalledOnce();
        expect(api.parseText).toHaveBeenCalledOnce();
    } finally {
        injection.resolve(media());
        parsing.resolve([{id: 'scan', source: 'scanning-parser', dictionary: null, index: 0, content: [[{text: '漢字', reading: 'かんじ'}]]}]);
    }
    await expect(request).resolves.toMatchObject({note: {deckName: 'Deck', modelName: 'Basic', fields: {}}, errors: []});
});
