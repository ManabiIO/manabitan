/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, expect, test, vi} from 'vitest'
import {Backend} from '../ext/js/background/backend.js'
import {AnkiConnect} from '../ext/js/comm/anki-connect.js'
import {API} from '../ext/js/comm/api.js'
import {ExtensionError} from '../ext/js/core/extension-error.js'

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

/** @returns {AnkiConnect} */
function createConnection() {
    const client = new AnkiConnect()
    client.enabled = true
    client.server = 'http://localhost:8765'
    client.apiKey = 'first-key'
    return client
}

function setup() {
    const client = createConnection()
    const backend = /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {
        _anki: client,
        _getProfile: () => ({id: 'profile-a', options: {anki: {enable: true}}}),
        _audioDownloader: {downloadTermAudio: vi.fn(async () => ({data: 'YXVkaW8=', contentType: 'audio/mpeg'}))},
        _getNormalizedDictionaryDatabaseMedia: vi.fn(async () => []),
    }))
    const api = /** @type {API} */ (Object.assign(Object.create(API.prototype), {
        async _invoke(/** @type {string} */ action, /** @type {any} */ params) {
            try {
                switch (action) {
                    case 'optionsGetProfile': return backend._onApiOptionsGetProfile(params, {})
                    case 'addAnkiNote': return await backend._onApiAddAnkiNote(params, {})
                    case 'updateAnkiNote': return await backend._onApiUpdateAnkiNote(params, {})
                    case 'getAnkiNotesInfo': return await backend._onApiGetAnkiNotesInfo(params, {})
                    case 'suspendAnkiCardsForNote': return await backend._onApiSuspendAnkiCardsForNote(params, {})
                    case 'injectAnkiNoteMedia': return await backend._onApiInjectAnkiNoteMedia(params, {})
                    default: throw new Error(`Unexpected API action: ${action}`)
                }
            } catch (error) {
                // Preserve the same error metadata as the extension RPC boundary.
                throw ExtensionError.deserialize(ExtensionError.serialize(error))
            }
        },
    }))
    /** @type {{url: string, body: import('anki').MessageBody}[]} */
    const requests = []
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        const body = /** @type {import('anki').MessageBody} */ (JSON.parse(String(options?.body)))
        requests.push({url: String(url), body})
        let result
        switch (body.action) {
            case 'version': result = 6; break
            case 'addNote': result = 123; break
            case 'updateNoteFields': result = null; break
            case 'notesInfo': result = []; break
            case 'findCards': result = [1123]; break
            case 'suspend': result = true; break
            case 'storeMediaFile': result = body.params.filename; break
            default: throw new Error(`Unexpected Anki action: ${body.action}`)
        }
        return new Response(JSON.stringify(result))
    }))
    const note = /** @type {import('anki').Note} */ ({fields: {Front: 'term'}, deckName: 'Deck', modelName: 'Model', tags: [], options: {allowDuplicate: true, duplicateScope: 'collection', duplicateScopeOptions: {deckName: null, checkChildren: false, checkAllModels: false}}})
    return {client, backend, api, requests, note}
}

/**
 * @param {Backend} backend
 * @param {string} change
 */
function changeConnection(backend, change) {
    if (change === 'restart') {
        backend._anki = createConnection()
    } else {
        backend._anki.server = 'http://localhost:8766'
        if (change === 'restore') { backend._anki.server = 'http://localhost:8765' }
    }
}

for (const change of ['server', 'restore', 'restart']) {
    test(`accepted note writes reject a stale destination after ${change}`, async () => {
        const {backend, api, requests, note} = setup()
        const accepted = await api.optionsGetProfile({current: true})
        changeConnection(backend, change)
        const identity = /** @type {string} */ (accepted.ankiConnectionIdentity)

        await expect(api.addAnkiNote(note, identity)).rejects.toMatchObject({data: {code: 'ankiConnectionChanged'}})
        await expect(api.updateAnkiNote({...note, id: 123}, identity)).rejects.toMatchObject({data: {code: 'ankiConnectionChanged'}})
        expect(requests).toEqual([])

        const refreshed = await api.optionsGetProfile({current: true})
        expect(refreshed.ankiConnectionIdentity).not.toBe(accepted.ankiConnectionIdentity)
        await expect(api.addAnkiNote(note, /** @type {string} */ (refreshed.ankiConnectionIdentity))).resolves.toBe(123)
        expect(requests.filter(({body}) => body.action === 'addNote')).toEqual([
            expect.objectContaining({url: change === 'server' ? 'http://localhost:8766' : 'http://localhost:8765'}),
        ])
    })

    test(`suspension does not carry note card IDs across ${change}`, async () => {
        const {client, backend, api, requests} = setup()
        const {ankiConnectionIdentity} = await api.optionsGetProfile({current: true})
        const findCards = client.findCardsForNote.bind(client)
        vi.spyOn(client, 'findCardsForNote').mockImplementation(async (id) => {
            const result = await findCards(id)
            // This boundary is after AnkiConnect's own per-operation guard.
            changeConnection(backend, change)
            return result
        })

        await expect(api.suspendAnkiCardsForNote(123, /** @type {string} */ (ankiConnectionIdentity))).rejects.toMatchObject({data: {code: 'ankiConnectionChanged'}})
        expect(requests.map(({body}) => body.action)).toEqual(['version', 'findCards'])
    })

    test(`audio acquired before ${change} is never stored in the new destination`, async () => {
        const {backend, api, requests} = setup()
        const {ankiConnectionIdentity} = await api.optionsGetProfile({current: true})
        const audio = Promise.withResolvers()
        const download = vi.spyOn(backend._audioDownloader, 'downloadTermAudio').mockImplementation(() => audio.promise)
        const operation = api.injectAnkiNoteMedia(
            1234,
            {type: 'term', term: 'term', reading: 'term'},
            /** @type {import('api').InjectAnkiNoteMediaAudioDetails} */ ({sources: [], preferredAudioIndex: null, idleTimeout: null, enableDefaultAudioSources: false, languageSummary: {name: 'English', iso: 'en', iso639_3: 'eng', exampleText: 'term'}}),
            null,
            null,
            [],
            ankiConnectionIdentity,
        )
        const rejected = expect(operation).rejects.toMatchObject({data: {code: 'ankiConnectionChanged'}})
        expect(download).toHaveBeenCalledOnce()
        changeConnection(backend, change)
        audio.resolve({data: 'YXVkaW8=', contentType: 'audio/mpeg'})

        await rejected
        expect(requests).toEqual([])
    })
}

test('accepted writes require an identity while read-only note inspection remains compatible', async () => {
    const {api, requests, note} = setup()
    await expect(Reflect.apply(api.addAnkiNote, api, [note])).rejects.toMatchObject({data: {code: 'ankiConnectionChanged'}})
    await expect(api.getAnkiNotesInfo([])).resolves.toEqual([])
    expect(requests.map(({body}) => body.action)).toEqual(['version', 'notesInfo'])
})

test('an unchanged destination can store media and suspend the new note', async () => {
    const {api, requests} = setup()
    const {ankiConnectionIdentity} = await api.optionsGetProfile({current: true})
    const result = await api.injectAnkiNoteMedia(
        1234,
        {type: 'term', term: 'term', reading: 'term'},
        /** @type {import('api').InjectAnkiNoteMediaAudioDetails} */ ({sources: [], preferredAudioIndex: null, idleTimeout: null, enableDefaultAudioSources: false, languageSummary: {name: 'English', iso: 'en', iso639_3: 'eng', exampleText: 'term'}}),
        null,
        null,
        [],
        ankiConnectionIdentity,
    )
    expect(result.audioFileName).toEqual(expect.stringMatching(/\.mp3$/))
    expect(result.errors).toEqual([])
    await expect(api.suspendAnkiCardsForNote(123, /** @type {string} */ (ankiConnectionIdentity))).resolves.toBe(1)
    expect(requests.map(({body}) => body.action)).toEqual(['version', 'storeMediaFile', 'findCards', 'suspend'])
})

test('a popup identity cannot be overridden by a separate media configuration', async () => {
    const {api, requests} = setup()
    const {ankiConnectionIdentity} = await api.optionsGetProfile({current: true})
    await expect(api.injectAnkiNoteMedia(
        1234,
        {type: 'term', term: 'term', reading: 'term'},
        null,
        null,
        null,
        [],
        ankiConnectionIdentity,
        {server: 'http://localhost:8766', apiKey: null, enabled: true},
    )).rejects.toThrow('Anki media cannot use two destinations')
    expect(requests).toEqual([])
})
