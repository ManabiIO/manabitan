import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {describe, expect, test} from 'vitest';
import {assertMiningDeliveryOracle, buildOwnedExtensionPageOpenScript, buildOwnedTabCleanupScript, buildRuntimeJobStart, buildSettingsFileImportStartScript, buildVisibleSearchScript, decodeRuntimeEvaluation, evaluateJSON} from './firefox-android-runtime-qualification.js';
import {createAnkiMockState} from '../e2e/anki-mock-state.js';

/**
 * @param {unknown} value
 * @param {string} [resultID]
 * @returns {{acknowledgement: {resultID: string}, result: {type: string, resultID: string, result: {type: string, value: string}}}}
 */
function rdpEntry(value, resultID = 'runtime-job-1') {
    return {
        acknowledgement: {resultID},
        result: {type: 'evaluationResult', resultID, result: {type: 'string', value: JSON.stringify(value)}},
    };
}

function tick() {
    return new Promise((resolve) => { setTimeout(resolve, 0); });
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const displayTemplates = readFileSync(path.join(projectRoot, 'ext/templates-display.html'), 'utf8');

/**
 * @param {{splitIdentity?: boolean}} [options]
 * @returns {{dom: JSDOM, globals: Record<string, unknown>}}
 */
function createSearchDom({splitIdentity = false} = {}) {
    const dom = new JSDOM(`<html><body><textarea id="search-textbox"></textarea><button id="search-button"></button><div id="dictionary-entries"></div>${displayTemplates}</body></html>`, {runScripts: 'outside-only'});
    const {document, HTMLElement, HTMLButtonElement, HTMLTextAreaElement, Event} = dom.window;
    const entry = document.createElement('div');
    entry.className = 'entry';
    const headwordTemplate = document.querySelector('#headword-template');
    const definitionTemplate = document.querySelector('#definition-item-template');
    const glossTemplate = document.querySelector('#gloss-item-template');
    if (!(headwordTemplate instanceof dom.window.HTMLTemplateElement) || !(definitionTemplate instanceof dom.window.HTMLTemplateElement) || !(glossTemplate instanceof dom.window.HTMLTemplateElement)) { throw new Error('Product display templates did not parse as templates'); }
    const headwordElement = headwordTemplate.content.firstElementChild;
    const definitionElement = definitionTemplate.content.firstElementChild;
    const glossElement = glossTemplate.content.firstElementChild;
    if (!headwordElement || !definitionElement || !glossElement) { throw new Error('Product display template has no root element'); }
    const headword = headwordElement.cloneNode(true);
    if (!(headword instanceof dom.window.HTMLElement)) { throw new Error('Product headword template root is not an element'); }
    const term = headword.querySelector('.headword-term');
    if (!(term instanceof dom.window.HTMLElement)) { throw new Error('Product headword template has no term element'); }
    term.append(document.createTextNode('読'));
    const ruby = document.createElement('ruby');
    ruby.append(document.createTextNode('む'));
    const rubyText = document.createElement('rt');
    rubyText.textContent = 'よ';
    ruby.append(rubyText);
    term.append(ruby);
    const reading = headword.querySelector('.headword-reading');
    if (!(reading instanceof dom.window.HTMLElement)) { throw new Error('Product headword template has no reading element'); }
    reading.textContent = 'よむ';
    const definition = definitionElement.cloneNode(true);
    if (!(definition instanceof dom.window.HTMLElement)) { throw new Error('Product definition template has no root element'); }
    definition.dataset.dictionary = 'android-runtime-fixture';
    const gloss = glossElement.cloneNode(true);
    if (!(gloss instanceof dom.window.HTMLElement)) { throw new Error('Product gloss template root is not an element'); }
    const glossContent = gloss.querySelector('.gloss-content');
    if (!(glossContent instanceof dom.window.HTMLElement)) { throw new Error('Product gloss template has no content element'); }
    glossContent.textContent = 'to read revision 2';
    const glossList = definition.querySelector('.gloss-list');
    if (!(glossList instanceof dom.window.HTMLElement)) { throw new Error('Product definition template has no gloss list'); }
    glossList.append(gloss);
    entry.append(headword, definition);
    if (splitIdentity) {
        reading.textContent = 'べつ';
        const second = document.createElement('div');
        second.className = 'entry';
        const otherHeadword = headword.cloneNode(true);
        if (!(otherHeadword instanceof dom.window.HTMLElement)) { throw new Error('Cloned product headword root is not an element'); }
        const otherReading = otherHeadword.querySelector('.headword-reading');
        if (!(otherReading instanceof dom.window.HTMLElement)) { throw new Error('Cloned product headword has no reading element'); }
        otherReading.textContent = 'よむ';
        const otherDefinition = definition.cloneNode(true);
        if (!(otherDefinition instanceof dom.window.HTMLElement)) { throw new Error('Cloned product definition has no root element'); }
        otherDefinition.dataset.dictionary = 'other-dictionary';
        second.append(otherHeadword, otherDefinition);
        const entries = document.querySelector('#dictionary-entries');
        if (!(entries instanceof dom.window.HTMLElement)) { throw new Error('Search results container is unavailable'); }
        entries.append(entry, second);
    } else {
        const entries = document.querySelector('#dictionary-entries');
        if (!(entries instanceof dom.window.HTMLElement)) { throw new Error('Search results container is unavailable'); }
        entries.append(entry);
    }
    return {dom, globals: {document, HTMLElement, HTMLButtonElement, HTMLTextAreaElement, Event}};
}

describe('Android runtime qualification emitted scripts', () => {
    test('mining oracle requires a successful reply and the exact persisted note from the real mock state', () => {
        const mock = createAnkiMockState();
        mock.beginScenario('delivery-oracle-test', [{noteId: 91_001, cardId: 92_001, deckName: 'Android Capability Deck', modelName: 'Android Capability Model', fields: {Front: 'seed', Back: 'seed'}, tags: [], queue: 0, flags: 0, findable: true}]);
        const delivered = mock.handleRequestBody({action: 'addNote', params: {note: {deckName: 'Android Capability Deck', modelName: 'Android Capability Model', fields: {Front: '読む', Back: 'よむ / to read revision 2'}, tags: []}}});
        expect(delivered.error).toBeNull();
        const state = mock.getScenarioState();
        expect(assertMiningDeliveryOracle(state, state.actions[0])).toBe(delivered.result);

        const failedMock = createAnkiMockState();
        failedMock.beginScenario('delivery-oracle-failure-test', [{noteId: 91_001, cardId: 92_001, deckName: 'Android Capability Deck', modelName: 'Android Capability Model', fields: {Front: 'seed', Back: 'seed'}, tags: [], queue: 0, flags: 0, findable: true}]);
        failedMock.handleRequestBody({action: 'addNote', params: {note: {deckName: 'Android Capability Deck', modelName: 'Android Capability Model', fields: null}}});
        const failedState = failedMock.getScenarioState();
        expect(failedState.actions[0].error).not.toBeNull();
        expect(() => assertMiningDeliveryOracle(failedState, failedState.actions[0])).toThrow(/returned an error/);
        expect(() => assertMiningDeliveryOracle(state, {...state.actions[0], result: null})).toThrow(/positive note ID/);
        expect(() => assertMiningDeliveryOracle({...state, snapshots: [state.snapshots[0]]}, state.actions[0])).toThrow(/Latest mock snapshot does not record addNote/);
        const finalSnapshot = state.snapshots.at(-1);
        expect(typeof finalSnapshot).toBe('object');
        const snapshotRecord = /** @type {Record<string, unknown>} */ (finalSnapshot);
        expect(Array.isArray(snapshotRecord.notes)).toBe(true);
        const finalNotes = /** @type {unknown[]} */ (snapshotRecord.notes);
        const withoutStoredCreatedNote = {...snapshotRecord, notes: finalNotes.filter((note) => typeof note === 'object' && note !== null && Reflect.get(note, 'noteId') === 91_001), noteCount: 1};
        expect(() => assertMiningDeliveryOracle({...state, snapshots: [...state.snapshots.slice(0, -1), withoutStoredCreatedNote]}, state.actions[0])).toThrow(/exactly the seed note plus one created note/);
    });

    test('owned start script executes its async expression and records fulfillment for polling', async () => {
        const key = '__owned_job_fixture';
        const context = vm.createContext({});
        const start = buildRuntimeJobStart(key, 'Promise.resolve({ready:true, count:38})');
        const acknowledgement = vm.runInContext(start, context);
        expect(JSON.parse(acknowledgement)).toEqual({started: true, key});
        await tick();
        expect(JSON.parse(vm.runInContext(`JSON.stringify(globalThis[${JSON.stringify(key)}])`, context))).toEqual({status: 'fulfilled', value: {ready: true, count: 38}});
        expect(JSON.parse(vm.runInContext(`(() => { delete globalThis[${JSON.stringify(key)}]; return JSON.stringify({cleaned:!Object.hasOwn(globalThis,${JSON.stringify(key)})}); })()`, context))).toEqual({cleaned: true});
    });

    test('owned start script records rejection without creating an unhandled rejected job promise', async () => {
        const context = vm.createContext({});
        vm.runInContext(buildRuntimeJobStart('__rejected_job_fixture', "Promise.reject(new Error('fixture failure'))"), context);
        await tick();
        const state = JSON.parse(vm.runInContext('JSON.stringify(globalThis.__rejected_job_fixture)', context));
        expect(state.status).toBe('rejected');
        expect(state.error).toContain('fixture failure');
    });

    test('background ownership records both extension pages and closes the exact owned tabs', async () => {
        /** @type {{id: number, url: string}[]} */
        const created = [];
        /** @type {number[]} */
        const removed = [];
        /** @type {(page: string) => string} */
        const getURL = (page) => `moz-extension://fixture/${page}`;
        const context = vm.createContext({
            browser: {
                runtime: {getURL},
                tabs: {
                    /**
                     * @param {{url: string}} options
                     * @returns {Promise<{id: number, url: string}>}
                     */
                    create: async ({url}) => {
                        const tab = {id: created.length + 1, url};
                        created.push(tab);
                        return tab;
                    },
                    /** @param {number} tabId @returns {Promise<void>} */
                    remove: async (tabId) => { removed.push(/** @type {number} */ (tabId)); },
                },
            },
        });
        vm.runInContext('globalThis.__manabitanAndroidRuntimeQualification={ownedExtensionPageTabs:[]}', context);
        expect(JSON.parse(vm.runInContext(buildOwnedExtensionPageOpenScript('settings.html'), context))).toEqual({started: true, page: 'settings.html'});
        await tick();
        expect(JSON.parse(vm.runInContext('JSON.stringify({phase:globalThis.__manabitanAndroidRuntimeQualification.phase,lastOpenedPage:globalThis.__manabitanAndroidRuntimeQualification.lastOpenedPage})', context))).toEqual({phase: 'page-open', lastOpenedPage: 'settings.html'});
        expect(JSON.parse(vm.runInContext(buildOwnedExtensionPageOpenScript('search.html'), context))).toEqual({started: true, page: 'search.html'});
        await tick();
        expect(created.map(({url}) => url)).toEqual(['moz-extension://fixture/settings.html', 'moz-extension://fixture/search.html']);
        expect(JSON.parse(vm.runInContext('JSON.stringify(globalThis.__manabitanAndroidRuntimeQualification.ownedExtensionPageTabs)', context))).toEqual([1, 2]);
        await expect(vm.runInContext(buildOwnedTabCleanupScript(), context)).resolves.toEqual({ownedIds: [1, 2], removed: [1, 2], failures: []});
        expect(removed).toEqual([1, 2]);
    });

    test('evaluation decoder requires correlated actual evaluationResult packets and parses string grips', () => {
        expect(decodeRuntimeEvaluation(rdpEntry({value: 9}), 'decoder-fixture')).toEqual({value: 9});
        expect(decodeRuntimeEvaluation({...rdpEntry({value: 9}), result: {...rdpEntry({value: 9}).result, exception: null}}, 'nullable-exception-fixture')).toEqual({value: 9});
        expect(() => decodeRuntimeEvaluation({...rdpEntry({}), acknowledgement: {resultID: 'other'}}, 'mismatch')).toThrow(/resultID mismatch/);
        expect(() => decodeRuntimeEvaluation({acknowledgement: {resultID: 'runtime-job-1'}, result: {type: 'evaluationResult', resultID: 'runtime-job-1', hasException: true}}, 'exception')).toThrow(/RDP evaluation failed/);
    });

    test('evaluateJSON polls fulfilled values and preserves primary rejection when cleanup fails', async () => {
        const context = vm.createContext({});
        /** @type {(actor: string, script: string) => Promise<Record<string, unknown>>} */
        const evaluate = async (_actor, script) => {
            const result = vm.runInContext(script, context);
            await tick();
            if (typeof result === 'string') {
                try {
                    return rdpEntry(JSON.parse(result));
                } catch {
                    return rdpEntry(result);
                }
            }
            return rdpEntry({});
        };
        await expect(evaluateJSON(evaluate, 'fixture-actor', 'Promise.resolve({answer:42})', 'fulfilled-fixture')).resolves.toEqual({answer: 42});

        /** @type {(actor: string, script: string, stage: string) => Promise<Record<string, unknown>>} */
        const failingEvaluate = async (_actor, script, stage) => {
            if (stage.endsWith(':cleanup')) { throw new Error('cleanup transport failure'); }
            const result = vm.runInContext(script, context);
            await tick();
            return rdpEntry(typeof result === 'string' ? JSON.parse(result) : {});
        };
        /** @type {Error|null} */
        let failure = null;
        try {
            await evaluateJSON(failingEvaluate, 'fixture-actor', "Promise.reject(new Error('primary operation failure'))", 'rejected-fixture');
        } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
        }
        if (failure === null) { throw new Error('Expected operation failure'); }
        expect(failure.message).toContain('primary operation failure');
        expect(/** @type {Error & {cleanupError?: string}} */ (failure).cleanupError).toContain('cleanup transport failure');
        /** @type {(actor: string, script: string, stage: string) => Promise<Record<string, unknown>>} */
        const cleanupFailEvaluate = async (_actor, script, stage) => {
            if (stage.endsWith(':cleanup')) { throw new Error('successful operation cleanup failure'); }
            const result = vm.runInContext(script, context);
            await tick();
            return rdpEntry(typeof result === 'string' ? JSON.parse(result) : {});
        };
        await expect(evaluateJSON(cleanupFailEvaluate, 'fixture-actor', 'Promise.resolve({answer:43})', 'fulfilled-cleanup-failure')).rejects.toThrow(/successful operation cleanup failure/);

        /** @type {(actor: string, script: string, stage: string) => Promise<Record<string, unknown>>} */
        const unclearedEvaluate = async (_actor, script, stage) => {
            if (stage.endsWith(':cleanup')) { return rdpEntry({cleaned: false}); }
            const result = vm.runInContext(script, context);
            await tick();
            return rdpEntry(typeof result === 'string' ? JSON.parse(result) : {});
        };
        /** @type {Error|null} */
        let primaryWithUnclearedState = null;
        try {
            await evaluateJSON(unclearedEvaluate, 'fixture-actor', "Promise.reject(new Error('primary with incomplete cleanup'))", 'rejected-incomplete-cleanup-fixture');
        } catch (error) {
            primaryWithUnclearedState = error instanceof Error ? error : new Error(String(error));
        }
        expect(primaryWithUnclearedState?.message).toContain('primary with incomplete cleanup');
        expect(/** @type {Error & {cleanupError?: string}} */ (primaryWithUnclearedState).cleanupError).toContain('cleanup did not remove');
    });

    test('real emitted Settings import script uses file controls and records product import result in scope', async () => {
        class MockHTMLElement {
            /** @type {string} */
            textContent;
            /** @type {boolean} */
            hidden;
            /** @param {string} [textContent] */
            constructor(textContent = '') {
                this.textContent = textContent;
                this.hidden = true;
            }
        }
        class MockInput extends MockHTMLElement {
            /** @type {MockFile[]} */
            files = [];
            /** @type {unknown} */
            event;
            /**
             * @param {unknown} event
             * @returns {boolean}
             */
            dispatchEvent(event) {
                this.event = event;
                return true;
            }
        }
        class MockFile {
            /** @type {unknown[]} */
            parts;
            /** @type {string} */
            name;
            /** @type {string} */
            type;
            /**
             * @param {unknown[]} parts
             * @param {string} name
             * @param {{type: string}} options
             */
            constructor(parts, name, options) {
                this.parts = parts;
                this.name = name;
                this.type = options.type;
            }
        }
        class MockDataTransfer {
            /** @type {MockFile[]} */
            files = [];
            /** @type {{add: (file: MockFile) => number}} */
            items = {add: (file) => this.files.push(file)};
        }
        class MockEvent {
            /** @type {string} */
            type;
            /** @type {unknown} */
            options;
            /**
             * @param {string} type
             * @param {unknown} options
             */
            constructor(type, options) { this.type = type; this.options = options; }
        }
        const input = new MockInput();
        const errorNode = new MockHTMLElement();
        const context = vm.createContext({
            Date,
            Promise,
            Uint8Array,
            JSON,
            Object,
            Error,
            HTMLInputElement: MockInput,
            HTMLElement: MockHTMLElement,
            File: MockFile,
            DataTransfer: MockDataTransfer,
            Event: MockEvent,
            atob: /**
                   * @param {string} text
                   * @returns {string}
                   */ (text) => Buffer.from(text, 'base64').toString('binary'),
            document: {
                documentElement: {dataset: {loaded: 'true'}},
                querySelector: /**
                                * @param {string} selector
                                * @returns {MockInput|MockHTMLElement|null}
                                */ (selector) => (selector === '#dictionary-import-file-input' ? input : (selector === '#dictionary-error' ? errorNode : null)),
            },
            browser: {runtime: {lastError: null,
                sendMessage: /**
                              * @param {unknown} _message
                              * @param {(response: unknown) => void} callback
                              * @returns {void}
                              */ (_message, callback) => callback([{title: 'android-runtime-fixture', revision: 'r1'}])}},
            setTimeout,
        });
        const ack = JSON.parse(vm.runInContext(buildSettingsFileImportStartScript('Wg=='), context));
        expect(ack).toEqual({started: true});
        await context.__manabitanAndroidRuntimeQualification.promise;
        expect(input.files[0]).toMatchObject({name: 'android-runtime-fixture.zip', type: 'application/zip'});
        expect(input.event).toMatchObject({type: 'change', options: {bubbles: true}});
        expect(context.__manabitanAndroidRuntimeQualification).toMatchObject({phase: 'import-visible', imported: {title: 'android-runtime-fixture', revision: 'r1'}});
    });

    test('real emitted Search script reads the term/reading pair and definition dictionary from product template DOM', async () => {
        const {dom, globals} = createSearchDom();
        try {
            dom.window.document.documentElement.dataset.loaded = 'true';
            const resultEntry = dom.window.document.querySelector('#dictionary-entries .entry');
            if (!(resultEntry instanceof dom.window.HTMLElement)) { throw new Error('Search result fixture entry is missing'); }
            resultEntry.getBoundingClientRect = () => ({width: 20, height: 10, top: 0, right: 20, bottom: 10, left: 0, x: 0, y: 0, toJSON: () => ({})});
            const context = vm.createContext({...globals, Date, Promise, String, JSON, Error, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), setTimeout});
            const result = await vm.runInContext(buildVisibleSearchScript({expression: '読む', reading: 'よむ', glossary: 'to read revision 2', dictionaryTitle: 'android-runtime-fixture'}), context);
            expect(result).toEqual({expression: '読む', reading: 'よむ', glossary: ['to read revision 2'], dictionary: 'android-runtime-fixture', entryCount: 1, render: {visible: true, width: 20, height: 10, display: 'block', visibility: 'visible', consentModalVisible: false}});
            const searchInput = dom.window.document.querySelector('#search-textbox');
            if (!(searchInput instanceof dom.window.HTMLTextAreaElement)) { throw new Error('Shipped search input template is unavailable'); }
            expect(searchInput.value).toBe('読む');
        } finally {
            dom.window.close();
        }
    });

    test('real emitted Search script rejects split term/reading and dictionary glossary identity', async () => {
        const {dom, globals} = createSearchDom({splitIdentity: true});
        try {
            dom.window.document.documentElement.dataset.loaded = 'true';
            const context = vm.createContext({...globals, Date, Promise, String, JSON, Error, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), setTimeout});
            await expect(vm.runInContext(buildVisibleSearchScript({expression: '読む', reading: 'よむ', glossary: 'to read revision 2', dictionaryTitle: 'android-runtime-fixture'}, {timeoutMs: 50, pollIntervalMs: 5}), context)).rejects.toThrow(/No single visible Search entry/);
        } finally {
            dom.window.close();
        }
    });
});
