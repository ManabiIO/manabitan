/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';
import {API} from '../ext/js/comm/api.js';
import {ExtensionError} from '../ext/js/core/extension-error.js';
import {AnkiNoteBuilder} from '../ext/js/data/anki-note-builder.js';
import {AnkiController} from '../ext/js/pages/settings/anki-controller.js';
import {AnkiDeckGeneratorController} from '../ext/js/pages/settings/anki-deck-generator-controller.js';
import {TemplateRenderer} from '../ext/js/templates/template-renderer.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * Exercise the real Handlebars renderer, batched formatting, and note builder.
 * The minimal data modifier only exposes the requested field marker.
 * @param {string} template
 * @param {Document} document
 * @returns {{controller: AnkiDeckGeneratorController, builder: AnkiNoteBuilder, options: any, api: any, addNotes: ReturnType<typeof vi.fn>, saveBlob: ReturnType<typeof vi.fn>, progressError: ReturnType<typeof vi.fn>}}
 */
function createGenerator(template, document) {
    const renderer = new TemplateRenderer();
    renderer.registerDataType('ankiNote', {
        composeData: (data, commonData) => ({...data, commonData}),
        modifier: (data) => /** @type {any} */ ({marker: data.marker}),
    });
    renderer.setRenderCallbacks(() => ({requirements: []}), null);
    const api = {
        termsFind: vi.fn(async () => ({dictionaryEntries: [{
            type: 'term',
            headwords: [{term: '読む', reading: 'よむ', sources: [{originalText: '読む', isPrimary: true}]}],
            definitions: [],
        }]})),
        getDictionaryInfo: vi.fn(async () => []),
        injectAnkiNoteMedia: vi.fn(async () => ({
            audioFileName: null,
            screenshotFileName: null,
            clipboardImageFileName: null,
            clipboardText: null,
            dictionaryMedia: [],
            errors: [],
        })),
    };
    const options = {
        general: {language: 'ja', resultOutputMode: 'group', glossaryLayoutMode: 'default', compactTags: false},
        audio: {sources: [], enableDefaultAudioSources: false},
        anki: {fieldTemplates: template, downloadTimeout: 0, tags: [], duplicateScope: 'collection', duplicateScopeCheckAllModels: false},
        dictionaries: [],
    };
    const cardFormat = {type: 'term', name: 'Basic', model: 'Basic', deck: 'Japanese', fields: {Front: {value: '{expression}'}, Back: {value: 'definition'}}};
    const addNotes = vi.fn(async () => [123]);
    const saveBlob = vi.fn();
    const progressError = vi.fn();
    const builder = new AnkiNoteBuilder(/** @type {any} */ (api), renderer);
    const input = document.createElement('input');
    input.value = '読む';
    const controller = /** @type {AnkiDeckGeneratorController} */ (Object.assign(Object.create(AnkiDeckGeneratorController.prototype), {
        _application: {api},
        _settingsController: {
            application: {api},
            getOptionsContext: () => ({index: 0, profileId: 'profile-a'}),
            profileIndexChangeGeneration: 0,
            optionsRevision: 0,
            getOptions: async () => options,
        },
        _ankiController: {addNotes, captureConnection: () => ({identity: 'test-connection', configuration: {server: 'http://localhost:8765', enabled: true, apiKey: null}}), assertConnectionIdentity: vi.fn()},
        _ankiNoteBuilder: builder,
        _flashcardFormatDetails: [cardFormat],
        _flashcardFormatDetailsOwnership: {optionsContext: {index: 0, profileId: 'profile-a'}, profileIndexChangeGeneration: 0, optionsRevision: 0},
        _flashcardFormatViewToken: 0,
        _activeFlashcardFormatSelect: {value: '0'},
        _inProgress: false,
        _cancel: false,
        _wordInputTextarea: {value: '読む'},
        _renderTextInput: input,
        _addMediaCheckbox: {checked: false, disabled: false},
        _disallowDuplicatesCheckbox: {checked: false, disabled: false},
        _exportConfirmModal: null,
        _sendToAnkiConfirmModal: null,
        _generationButtons: [],
        _progressContainers: [],
        _saveBlob: saveBlob,
        _updateProgressBar: vi.fn(),
        _updateProgressBarError: progressError,
    }));
    return {controller, builder, options, api, addNotes, saveBlob, progressError};
}

for (const template of ['{{#if}}', '{{missingHelper marker}}']) {
    test(`note generation rejects template errors instead of returning placeholders: ${template}`, async ({window}) => {
        const {controller} = createGenerator(template, window.document);

        await expect(controller._generateNoteData('読む', false)).rejects.toMatchObject({
            message: 'Template render error for {expression}',
            data: {error: expect.any(Error)},
        });
    });
}

test('the card preview displays the actual rendering failure as an error', async ({window}) => {
    const {controller} = createGenerator('{{missingHelper marker}}', window.document);
    const preview = window.document.createElement('div');

    await controller._testNoteData(preview, true);

    expect(preview.hidden).toBe(false);
    expect(preview.classList.contains('text-danger')).toBe(true);
    expect(preview.textContent).toContain('Missing helper');
    expect(preview.textContent).not.toContain('{expression-render-error}');
});

for (const operation of /** @type {const} */ (['send', 'export'])) {
    test(`${operation} stops before publishing broken cards and succeeds after correcting the template`, async ({window}) => {
        const {controller, options, addNotes, saveBlob, progressError} = createGenerator('{{missingHelper marker}}', window.document);
        /** @type {(() => Promise<void>)[]} */
        const pending = [];
        vi.stubGlobal('requestAnimationFrame', (/** @type {FrameRequestCallback} */ callback) => {
            callback(0);
            return 0;
        });
        vi.stubGlobal('setTimeout', (/** @type {() => Promise<void>} */ callback) => {
            pending.push(callback);
            return 0;
        });
        const confirm = operation === 'send' ? controller._onSendToAnkiConfirm.bind(controller) : controller._onExportConfirm.bind(controller);
        await confirm(new window.MouseEvent('click'));
        await pending.shift()?.();

        expect(addNotes).not.toHaveBeenCalled();
        expect(saveBlob).not.toHaveBeenCalled();
        expect(progressError).toHaveBeenCalledWith(expect.stringContaining('Template render error for {expression}'));
        expect(controller._inProgress).toBe(false);

        options.anki.fieldTemplates = '{{marker}}';
        await confirm(new window.MouseEvent('click'));
        await pending.shift()?.();
        expect(operation === 'send' ? addNotes : saveBlob).toHaveBeenCalledOnce();
        expect(controller._inProgress).toBe(false);
        if (operation === 'send') {
            expect(addNotes).toHaveBeenCalledWith([expect.objectContaining({fields: {Front: 'expression', Back: 'definition'}})]);
        }
    });
}

test('optional media errors do not reject an otherwise correctly rendered generated note', async ({window}) => {
    const {controller, api} = createGenerator('{{marker}}', window.document);
    api.injectAnkiNoteMedia.mockResolvedValueOnce({
        audioFileName: null,
        screenshotFileName: null,
        clipboardImageFileName: null,
        clipboardText: null,
        dictionaryMedia: [],
        errors: [ExtensionError.serialize(new Error('Audio not available'))],
    });

    await expect(controller._generateNoteData('読む', true)).resolves.toMatchObject({fields: {Front: 'expression', Back: 'definition'}});
    expect(api.injectAnkiNoteMedia).toHaveBeenCalledOnce();
});

test('the note builder retains its existing diagnostic result behavior unless rejection is requested', async ({window}) => {
    const {controller, builder} = createGenerator('{{missingHelper marker}}', window.document);
    const createNote = vi.spyOn(builder, 'createNote');
    await controller._generateNoteData('読む', false).catch(() => {});
    const details = {...createNote.mock.calls[0][0]};
    delete details.throwOnRenderError;

    await expect(builder.createNote(details)).resolves.toMatchObject({
        note: {fields: {Front: '{expression-render-error}', Back: 'definition'}},
        errors: [expect.objectContaining({message: 'Template render error for {expression}'})],
    });
});

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {{controller: AnkiDeckGeneratorController, backend: Backend, requests: {url: string, body: import('anki').MessageBody}[], pending: (() => Promise<void>)[], progressError: ReturnType<typeof vi.fn>}}
 */
function createProfileDestinationGenerator(window) {
    const {controller, builder, options, api, progressError} = createGenerator('[sound:{{media.audio.value}}]', window.document);
    options.anki.enable = true;
    options.anki.server = 'http://localhost:8766';
    options.anki.apiKey = 'edited-profile-key';
    /**
     * @param {string} server
     * @param {string} key
     * @returns {AnkiConnect}
     */
    const createConnection = (server, key) => {
        const client = new AnkiConnect();
        client.enabled = true;
        client.server = server;
        client.apiKey = key;
        return client;
    };
    const backend = /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {
        _anki: createConnection('http://localhost:8765', 'default-profile-key'),
        _audioDownloader: {downloadTermAudio: vi.fn(async () => ({data: 'YXVkaW8=', contentType: 'audio/mpeg'}))},
        _getNormalizedDictionaryDatabaseMedia: vi.fn(async () => []),
    }));
    const clientApi = /** @type {API} */ (Object.assign(Object.create(API.prototype), {
        _invoke: (/** @type {string} */ action, /** @type {any} */ params) => {
            if (action !== 'injectAnkiNoteMedia') { throw new Error(`Unexpected API action: ${action}`); }
            return backend._onApiInjectAnkiNoteMedia(params, {});
        },
    }));
    api.injectAnkiNoteMedia = vi.fn(clientApi.injectAnkiNoteMedia.bind(clientApi));
    controller._ankiController = /** @type {AnkiController} */ (Object.assign(Object.create(AnkiController.prototype), {
        _ankiConnect: createConnection(options.anki.server, options.anki.apiKey),
        _settingsController: controller._settingsController,
        _ankiOptionsOwner: {optionsContext: {index: 0, profileId: 'profile-a'}, profileIndexChangeGeneration: 0, optionsRevision: 0},
    }));
    const renderer = /** @type {TemplateRenderer} */ (builder._templateRenderer);
    renderer.registerDataType('ankiNote', {
        composeData: (data, commonData) => ({...data, commonData}),
        modifier: (data) => /** @type {any} */ (data.commonData),
    });
    /** @type {{url: string, body: import('anki').MessageBody}[]} */
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, request) => {
        const body = /** @type {import('anki').MessageBody} */ (JSON.parse(String(request?.body)));
        requests.push({url: String(url), body});
        let result;
        switch (body.action) {
            case 'version': result = 6; break;
            case 'storeMediaFile': result = body.params.filename; break;
            case 'canAddNotes': result = /** @type {import('anki').Note[]} */ (body.params.notes).map(() => true); break;
            case 'addNotes': result = [123]; break;
            default: throw new Error(`Unexpected Anki action: ${body.action}`);
        }
        return new Response(JSON.stringify(result));
    }));
    /** @type {(() => Promise<void>)[]} */
    const pending = [];
    vi.stubGlobal('requestAnimationFrame', (/** @type {FrameRequestCallback} */ callback) => {
        callback(0);
        return 0;
    });
    vi.stubGlobal('setTimeout', (/** @type {() => Promise<void>} */ callback) => {
        pending.push(callback);
        return 0;
    });
    controller._addMediaCheckbox.checked = true;
    return {controller, backend, requests, pending, progressError};
}

test('generated media and notes use the same edited profile destination', async ({window}) => {
    const {controller, requests, pending, progressError} = createProfileDestinationGenerator(window);
    await controller._onSendToAnkiConfirm(new window.MouseEvent('click'));
    await pending.shift()?.();

    expect(progressError).not.toHaveBeenCalled();
    const media = requests.find(({body}) => body.action === 'storeMediaFile');
    const notes = requests.find(({body}) => body.action === 'addNotes');
    expect(notes).toMatchObject({url: 'http://localhost:8766', body: {key: 'edited-profile-key', params: {notes: [expect.objectContaining({fields: {Front: `[sound:${String(media?.body.params.filename)}]`, Back: 'definition'}})]}}});
    expect(media).toMatchObject({url: 'http://localhost:8766', body: {key: 'edited-profile-key'}});
});

for (const change of ['default-server', 'edited-server', 'edited-restored', 'edited-key', 'edited-enabled']) {
    test(`batch media keeps its captured destination during ${change} and changed batches require a user retry`, async ({window}) => {
        const {controller, backend, requests, pending, progressError} = createProfileDestinationGenerator(window);
        const audio = /** @type {PromiseWithResolvers<{data: string, contentType: string}>} */ (Promise.withResolvers());
        const entered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
        vi.spyOn(backend._audioDownloader, 'downloadTermAudio').mockImplementationOnce(() => {
            entered.resolve();
            return audio.promise;
        });
        await controller._onSendToAnkiConfirm(new window.MouseEvent('click'));
        const generation = pending.shift()?.();
        await entered.promise;
        const edited = controller._ankiController._ankiConnect;
        switch (change) {
            case 'default-server': backend._anki.server = 'http://localhost:8767'; break;
            case 'edited-key': edited.apiKey = 'new-edited-key'; break;
            case 'edited-enabled': edited.enabled = false; break;
            default:
                edited.server = 'http://localhost:8767';
                if (change === 'edited-restored') { edited.server = 'http://localhost:8766'; }
                break;
        }
        audio.resolve({data: 'YXVkaW8=', contentType: 'audio/mpeg'});
        await generation;

        expect(requests.filter(({body}) => body.action === 'storeMediaFile')).toEqual([
            expect.objectContaining({url: 'http://localhost:8766', body: expect.objectContaining({key: 'edited-profile-key'})}),
        ]);
        if (change === 'default-server') {
            expect(progressError).not.toHaveBeenCalled();
            expect(requests.filter(({body}) => body.action === 'addNotes')).toEqual([expect.objectContaining({url: 'http://localhost:8766'})]);
        } else {
            expect(requests.filter(({body}) => body.action === 'addNotes')).toEqual([]);
            expect(progressError).toHaveBeenCalledWith(expect.stringContaining('Anki connection settings changed'));
            expect(controller._inProgress).toBe(false);

            edited.enabled = true;
            await controller._onSendToAnkiConfirm(new window.MouseEvent('click'));
            await pending.shift()?.();
            const writes = requests.filter(({body}) => body.action === 'addNotes');
            expect(writes).toEqual([expect.objectContaining({url: edited.server, body: expect.objectContaining({key: edited.apiKey})})]);
            expect(requests.filter(({body}) => body.action === 'storeMediaFile')).toMatchObject([
                {url: 'http://localhost:8766'},
                {url: edited.server, body: {key: edited.apiKey}},
            ]);
        }
    });
}

test('a settings client change after one batch dispatch prevents the next batch write', async ({window}) => {
    const {controller, requests, pending, progressError} = createProfileDestinationGenerator(window);
    controller._wordInputTextarea.value = '読む\n書く';
    controller._disallowDuplicatesCheckbox.checked = true;
    const client = controller._ankiController._ankiConnect;
    const addNotes = client.addNotes.bind(client);
    vi.spyOn(client, 'addNotes').mockImplementationOnce(async (notes) => {
        const result = await addNotes(notes);
        client.server = 'http://localhost:8767';
        return result;
    });

    await controller._onSendToAnkiConfirm(new window.MouseEvent('click'));
    await pending.shift()?.();

    expect(requests.filter(({body}) => body.action === 'addNotes')).toEqual([expect.objectContaining({url: 'http://localhost:8766'})]);
    expect(progressError).toHaveBeenCalledWith(expect.stringContaining('Anki connection settings changed'));
    expect(controller._inProgress).toBe(false);
});
