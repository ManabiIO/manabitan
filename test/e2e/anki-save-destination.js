/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {startAnkiMockHttpServer} from './anki-mock-http-server.js'
import {createAnkiMockState} from './anki-mock-state.js'
import {runWithReaderFinalization} from './reader-finalization.js'

/**
 * A real installed search page, save buttons, extension RPC, and two HTTP Anki
 * destinations. Only the first completed note render is paused to expose the
 * accepted-save boundary deterministically; no transport or write is replaced.
 * @param {import('@playwright/test').Page} controlPage
 * @param {string} extensionBaseUrl
 * @param {string} query
 * @returns {Promise<{staleSaveWrites: number, retriedNoteId: number, restartRecovered: boolean}>}
 */
export async function verifyAnkiSaveDestination(controlPage, extensionBaseUrl, query) {
    const context = controlPage.context()
    const savedOptions = /** @type {import('settings').Options} */ (await send(controlPage, 'optionsGetFull'))
    const firstState = createAnkiMockState()
    const secondState = createAnkiMockState()
    const seed = (/** @type {number} */ id, /** @type {string} */ front, /** @type {string} */ back) => ({
        noteId: id, cardId: id + 100, deckName: 'Default', modelName: 'Basic', fields: {Front: front, Back: back},
    })
    firstState.beginScenario('accepted-source', [seed(1, 'ownership-control', 'original source')])
    secondState.beginScenario('replacement-destination', [seed(1, 'unrelated-note', 'must remain unchanged'), seed(2, 'ownership-control', 'matching replacement')])
    /** @type {Array<() => Promise<void>>} */
    const cleanup = []
    /** @type {import('@playwright/test').Page|null} */
    let activePage = null
    const writes = (/** @type {ReturnType<typeof createAnkiMockState>} */ state) => state.getScenarioState().actions.filter(({action}) => (
        /^(?:addNote|addNotes|updateNoteFields|storeMediaFile|deleteNotes|suspend)$/.test(action)
    ))
    return /** @type {{staleSaveWrites: number, retriedNoteId: number, restartRecovered: boolean}} */ (await runWithReaderFinalization(async () => {
        const firstServer = await startAnkiMockHttpServer(firstState)
        cleanup.push(firstServer.close)
        const secondServer = await startAnkiMockHttpServer(secondState)
        cleanup.push(secondServer.close)
        const page = await context.newPage()
        activePage = page
        cleanup.push(async () => { await page.close() })
        const options = structuredClone(savedOptions)
        for (const {options: profile} of options.profiles) {
            profile.anki.enable = true
            profile.anki.server = firstServer.ankiConnectUrl
            profile.anki.apiKey = ''
            profile.anki.displayTagsAndFlags = 'never'
            profile.anki.checkForDuplicates = true
            profile.anki.duplicateBehavior = 'overwrite'
            profile.anki.duplicateScope = 'collection'
            profile.anki.suspendNewCards = false
            profile.anki.forceSync = false
            profile.anki.cardFormats = [{
                type: 'term',
                name: 'Destination witness',
                deck: 'Default',
                model: 'Basic',
                icon: 'big-circle',
                fields: {
                    Front: {value: 'ownership-control', overwriteMode: 'overwrite'},
                    Back: {value: 'explicit replacement', overwriteMode: 'overwrite'},
                },
            }]
        }
        await send(controlPage, 'setAllSettings', {value: options, source: 'chromium-e2e-anki-destination'})
        await page.goto(`${extensionBaseUrl}/search.html`, {waitUntil: 'domcontentloaded'})
        await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true', null, {timeout: 30000})
        await page.evaluate(async (query) => {
            // @ts-expect-error - Browser resolves this URL inside the installed extension.
            const {DisplayAnki} = /** @type {typeof import('../../ext/js/display/display-anki.js')} */ (await import('/js/display/display-anki.js'))
            const witness = {paused: false, released: false, settled: 0, release: () => {}}
            const gate = new Promise((resolve) => {
                witness.release = () => {
                    witness.released = true
                    resolve(void 0)
                }
            })
            const createNote = DisplayAnki.prototype._createNote
            /** @type {(this: InstanceType<typeof DisplayAnki>, ...args: Parameters<typeof createNote>) => ReturnType<typeof createNote>} */
            const pausedCreateNote = async function pauseAcceptedRender(...args) {
                const result = await createNote.apply(this, args)
                if (typeof args[3] !== 'undefined' && !witness.paused) {
                    witness.paused = true
                    await gate
                }
                return result
            }
            DisplayAnki.prototype._createNote = pausedCreateNote
            const save = DisplayAnki.prototype._saveAnkiNote
            /** @type {(this: InstanceType<typeof DisplayAnki>, ...args: Parameters<typeof save>) => ReturnType<typeof save>} */
            const trackedSave = async function trackAcceptedSave(...args) {
                try {
                    return await save.apply(this, args)
                } finally {
                    ++witness.settled
                }
            }
            DisplayAnki.prototype._saveAnkiNote = trackedSave
            Reflect.set(globalThis, '__ankiDestinationWitness', witness)
            const result = Reflect.get(globalThis, '__manabitanSearchDebugApi').triggerSearch(query, {animate: false})
            if (!result.ok) { throw new Error(`Destination lookup failed: ${result.error}`) }
        }, query)
        await waitForOverwriteTarget(page, 1)
        const saveButton = () => page.locator('.entry .action-button[data-action="save-note"]').first()
        await saveButton().click({timeout: 10000})
        await page.waitForFunction(() => Reflect.get(globalThis, '__ankiDestinationWitness')?.paused === true)

        for (const {options: profile} of options.profiles) { profile.anki.server = secondServer.ankiConnectUrl }
        await send(controlPage, 'setAllSettings', {value: options, source: 'chromium-e2e-anki-destination-switch'})
        await page.evaluate(() => { Reflect.get(globalThis, '__ankiDestinationWitness').release() })
        await page.waitForFunction(() => Reflect.get(globalThis, '__ankiDestinationWitness')?.settled === 1)
        assert.deepEqual(writes(firstState), [], 'The retired accepted save must not write to its old destination')
        assert.deepEqual(writes(secondState), [], 'The old note ID must never be written into the replacement destination')
        await waitForOverwriteTarget(page, 2)
        await saveButton().click({timeout: 10000})
        await page.waitForFunction(() => Reflect.get(globalThis, '__ankiDestinationWitness')?.settled === 2)
        const [write] = writes(secondState)
        assert.equal(writes(secondState).length, 1, 'Only the explicit retry may write a note')
        assert.equal(write.action, 'updateNoteFields')
        assert.equal(/** @type {{id: number}} */ (write.params.note).id, 2, 'Retry must use freshly resolved duplicate metadata')
        const protectedNote = /** @type {import('anki').NoteInfo[]} */ (secondState.handleRequestBody({action: 'notesInfo', params: {notes: [1]}}).result)
        assert.equal(protectedNote[0].fields.Back.value, 'must remain unchanged')

        // Restart the actual worker while keeping this document and its accepted
        // identity alive. A failed stale save refreshes read state, never retries
        // an ambiguous mutation automatically.
        await waitForOverwriteTarget(page, 2)
        const before = /** @type {{ankiConnectionIdentity: string}} */ (await send(controlPage, 'optionsGetProfile', {optionsContext: {current: true}}))
        const session = await context.newCDPSession(page)
        try {
            await session.send('ServiceWorker.stopAllWorkers')
        } finally {
            await session.detach()
        }
        const after = /** @type {{ankiConnectionIdentity: string}} */ (await send(controlPage, 'optionsGetProfile', {optionsContext: {current: true}}))
        assert.notEqual(after.ankiConnectionIdentity, before.ankiConnectionIdentity, 'The browser must actually replace the backend connection owner')
        await saveButton().click({timeout: 10000})
        await page.waitForFunction(() => Reflect.get(globalThis, '__ankiDestinationWitness')?.settled === 3)
        assert.equal(writes(secondState).length, 1, 'A stale worker identity must not cause a write or an automatic retry')
        await waitForOverwriteTarget(page, 2)
        await saveButton().click({timeout: 10000})
        await page.waitForFunction(() => Reflect.get(globalThis, '__ankiDestinationWitness')?.settled === 4)
        assert.equal(writes(secondState).length, 2, 'An explicit retry after restart must work without reloading the document')
        assert.equal(/** @type {{id: number}} */ (writes(secondState)[1].params.note).id, 2)
        return {staleSaveWrites: 0, retriedNoteId: 2, restartRecovered: true}
    }, [], [async (signal) => {
        // Release the deterministic pause even when an assertion fails.
        await activePage?.evaluate(() => { Reflect.get(globalThis, '__ankiDestinationWitness')?.release() }).catch(() => {})
        signal.throwIfAborted()
        await send(controlPage, 'setAllSettings', {value: savedOptions, source: 'chromium-e2e-anki-destination-restore'})
    }, async () => {
        const results = await Promise.allSettled(cleanup.map(async (close) => { await close() }))
        const errors = results.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []))
        if (errors.length > 0) { throw new AggregateError(errors, 'Failed to close Anki destination witness resources') }
    }], (error, diagnostics) => {
        if (diagnostics === null) { error.message = `Anki destination witness: ${error.message}` }
    }))
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} noteId
 */
async function waitForOverwriteTarget(page, noteId) {
    await page.waitForFunction((id) => {
        const entry = document.querySelector('.entry')
        const save = entry?.querySelector('.action-button[data-action="save-note"]')
        const view = entry?.querySelector('.action-button[data-action="view-note"]')
        return save instanceof HTMLButtonElement && !save.disabled && save.dataset.overwrite === 'true' &&
        view instanceof HTMLButtonElement && view.dataset.noteIds?.split(/\s+/).includes(String(id))
    }, noteId, {timeout: 15000})
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} action
 * @param {unknown} [params]
 * @returns {Promise<unknown>}
 */
async function send(page, action, params) {
    return await page.evaluate(({action, params}) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({action, params}, (response) => {
            const error = chrome.runtime.lastError
            if (error) {
                reject(new Error(error.message))
                return
            }
            if (response?.error) {
                reject(new Error(JSON.stringify(response.error)))
                return
            }
            resolve(response?.result)
        })
    }), {action, params})
}
