import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {describe, expect, test, vi} from 'vitest';
import {SettingsDisplayController} from '../../ext/js/pages/settings/settings-display-controller.js';
import {ModalController} from '../../ext/js/pages/settings/modal-controller.js';
import {assertMiningDeliveryOracle, buildDictionaryModalOpenScript, buildDocumentVisibilityWaitScript, buildOwnedExtensionPageOpenScript, buildOwnedPageActivationScript, buildOwnedPageReloadScript, buildOwnedTabCleanupScript, buildRuntimeJobStart, buildSettingsFileImportStartScript, buildVisibleSearchScript, decodeRuntimeEvaluation, evaluateJSON, qualifyAndroidDictionaryRuntime} from './firefox-android-runtime-qualification.js';
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
const settingsHtml = readFileSync(path.join(projectRoot, 'ext/settings.html'), 'utf8');
const modalTemplates = readFileSync(path.join(projectRoot, 'ext/templates-modals.html'), 'utf8');

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
    test('native readiness runs before the first owned extension page is opened', async () => {
        /** @type {string[]} */
        const events = [];
        const failure = await qualifyAndroidDictionaryRuntime({
            extensionId: 'expected-addon',
            backgroundTarget: {addonId: 'expected-addon', isFallbackExtensionDocument: false},
            evaluate: async (_actor, _script, stage) => { events.push(`evaluate:${stage}`); return rdpEntry({cleaned: true}); },
            waitForTarget: async () => { throw new Error('unexpected target wait'); },
            fixtureDirectory: '',
            adbDevice: 'emulator-test',
            runtimeQualificationTimeoutMs: 1000,
            prepareNativeReadiness: async () => { events.push('native-readiness'); throw new Error('stop after native readiness'); },
        }).catch((error) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(events[0]).toBe('native-readiness');
        expect(failure.message).toBe('stop after native readiness');
        expect(events.some((event) => event.includes('open-settings-page'))).toBe(false);
        expect(failure.runtimeQualification.errors).toContain('Error: stop after native readiness');
    });

    test('owned page visibility requires a nonzero actual page viewport and waits for delayed dimensions', async () => {
        const page = 'search.html';
        const context = vm.createContext({
            browser: {runtime: {getURL: /** @type {(value: string) => string} */ ((value) => `moz-extension://fixture/${value}`)}},
            location: {href: `moz-extension://fixture/${page}`},
            document: {visibilityState: 'visible', documentElement: {clientWidth: 0, clientHeight: 0}},
            innerWidth: 0,
            innerHeight: 0,
            outerWidth: 0,
            outerHeight: 0,
            Date: {now: () => 0},
            setTimeout: /** @type {(callback: () => void) => void} */ ((callback) => {
                context.innerWidth = 320;
                context.innerHeight = 640;
                context.document.documentElement.clientWidth = 320;
                context.document.documentElement.clientHeight = 640;
                callback();
            }),
        });
        const visible = await vm.runInContext(buildDocumentVisibilityWaitScript(page), context);
        expect(visible).toEqual({page, url: `moz-extension://fixture/${page}`, visibilityState: 'visible', viewport: {innerWidth: 320, innerHeight: 640, outerWidth: 0, outerHeight: 0, documentElementWidth: 320, documentElementHeight: 640}});

        const emptyContext = vm.createContext({
            browser: {runtime: {getURL: /** @type {(value: string) => string} */ ((value) => `moz-extension://fixture/${value}`)}},
            location: {href: `moz-extension://fixture/${page}`},
            document: {visibilityState: 'visible', documentElement: {clientWidth: 0, clientHeight: 0}},
            innerWidth: 0,
            innerHeight: 0,
            outerWidth: 0,
            outerHeight: 0,
            Date: {now: (() => { let time = 0; return () => (time += 20_000); })()},
            setTimeout: /** @type {(callback: () => void) => void} */ ((callback) => callback()),
        });
        await expect(vm.runInContext(buildDocumentVisibilityWaitScript(page), emptyContext)).rejects.toThrow(/nonzero page viewport/);
    });

    test('visible Search URL accepts only the explicitly expected query', async () => {
        const searchQuery = '読む';
        const expectedUrl = `moz-extension://fixture/search.html?${new URLSearchParams({query: searchQuery, type: 'terms'})}`;
        const context = vm.createContext({
            browser: {runtime: {getURL: (/** @type {string} */ page) => `moz-extension://fixture/${page}`}},
            location: {href: expectedUrl},
            document: {visibilityState: 'visible', documentElement: {clientWidth: 414, clientHeight: 758}},
            innerWidth: 414,
            innerHeight: 758,
            outerWidth: 414,
            outerHeight: 758,
            Date,
            setTimeout,
        });
        await expect(vm.runInContext(buildDocumentVisibilityWaitScript('search.html', {searchQuery}), context)).resolves.toMatchObject({page: 'search.html', url: expectedUrl, visibilityState: 'visible'});
        await expect(vm.runInContext(buildDocumentVisibilityWaitScript('search.html'), context)).rejects.toThrow(/URL changed/);
    });

    test('captures failure evidence before owned tab cleanup and preserves the runtime failure', async () => {
        /** @type {string[]} */
        const events = [];
        const failure = await qualifyAndroidDictionaryRuntime({
            extensionId: 'expected-addon',
            backgroundTarget: {addonId: 'different-addon', consoleActor: 'background-console'},
            evaluate: async (_actor, _script, stage) => {
                events.push(`evaluate:${stage}`);
                if (stage.endsWith(':start')) { return rdpEntry({started: true}); }
                if (stage.endsWith(':poll')) { return rdpEntry({status: 'fulfilled', value: {ownedIds: [71], removed: [71], failures: []}}); }
                return rdpEntry({cleaned: true});
            },
            waitForTarget: async () => { throw new Error('unexpected target wait'); },
            fixtureDirectory: '',
            adbDevice: 'emulator-test',
            runtimeQualificationTimeoutMs: 1000,
            onFailureEvidence: async (stage) => {
                events.push(`evidence:${stage}`);
                return {artifacts: {screenshot: {status: 'error', error: 'adb unavailable'}}};
            },
        }).catch((error) => error);

        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).toMatch(/belongs to another add-on/);
        expect(events[0]).toBe('evidence:runtime-failure-before-owned-tab-cleanup');
        expect(events[1]).toBe('evaluate:cleanup-owned-extension-tabs:start');
        expect(failure.runtimeQualification.stages).toContainEqual(expect.objectContaining({name: 'native-failure-evidence', value: expect.objectContaining({evidence: expect.objectContaining({artifacts: {screenshot: {status: 'error', error: 'adb unavailable'}}})})}));
    });

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
        expect(state.error).toMatchObject({name: 'Error', message: 'fixture failure'});
        expect(state.error.stack).toContain('fixture failure');
    });

    test('owned rejection preserves message when the remote stack does not contain it', async () => {
        const context = vm.createContext({});
        vm.runInContext(buildRuntimeJobStart('__stack_only_rejection', "Promise.reject(Object.assign(new Error('actionable failure message'), {stack:'at debugger eval code:1:1'}))"), context);
        await tick();
        const state = JSON.parse(vm.runInContext('JSON.stringify(globalThis.__stack_only_rejection)', context));
        expect(state.error).toEqual({name: 'Error', message: 'actionable failure message', stack: 'at debugger eval code:1:1', diagnostic: null});
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
        vm.runInContext('globalThis.__manabitanAndroidRuntimeQualification={ownedExtensionPageTabs:[],ownedExtensionPageTabIds:{}}', context);
        expect(JSON.parse(vm.runInContext(buildOwnedExtensionPageOpenScript('settings.html'), context))).toEqual({started: true, page: 'settings.html'});
        await tick();
        expect(JSON.parse(vm.runInContext('JSON.stringify({phase:globalThis.__manabitanAndroidRuntimeQualification.phase,lastOpenedPage:globalThis.__manabitanAndroidRuntimeQualification.lastOpenedPage})', context))).toEqual({phase: 'page-open', lastOpenedPage: 'settings.html'});
        expect(JSON.parse(vm.runInContext(buildOwnedExtensionPageOpenScript('search.html'), context))).toEqual({started: true, page: 'search.html'});
        await tick();
        expect(created.map(({url}) => url)).toEqual(['moz-extension://fixture/settings.html', 'moz-extension://fixture/search.html']);
        expect(JSON.parse(vm.runInContext('JSON.stringify(globalThis.__manabitanAndroidRuntimeQualification.ownedExtensionPageTabs)', context))).toEqual([1, 2]);
        expect(JSON.parse(vm.runInContext('JSON.stringify(globalThis.__manabitanAndroidRuntimeQualification.ownedExtensionPageTabIds)', context))).toEqual({'settings.html': 1, 'search.html': 2});
        await expect(vm.runInContext(buildOwnedTabCleanupScript(), context)).resolves.toEqual({ownedIds: [1, 2], removed: [1, 2], failures: []});
        expect(removed).toEqual([1, 2]);
        expect(JSON.parse(vm.runInContext('JSON.stringify(globalThis.__manabitanAndroidRuntimeQualification.ownedExtensionPageTabIds)', context))).toEqual({});
    });

    test('owned page activation and reload require the mapped owned ID and its exact expected URL', async () => {
        let activeTabId = 14;
        const tabs = new Map([[14, {id: 14, url: 'moz-extension://fixture/settings.html'}], [15, {id: 15, url: 'moz-extension://fixture/search.html'}], [99, {id: 99, url: 'https://example.org/'}]]);
        /** @type {number[]} */
        const reloaded = [];
        const context = vm.createContext({browser: {
            runtime: {getURL: (/** @type {string} */ page) => `moz-extension://fixture/${page}`},
            tabs: {
                get: async (/** @type {number} */ id) => tabs.get(id),
                update: async (/** @type {number} */ id, /** @type {{active?: boolean}} */ update) => {
                    if (update.active) { activeTabId = id; }
                    return tabs.get(id);
                },
                query: async () => [{...tabs.get(activeTabId), active: true}],
                reload: async (/** @type {number} */ id) => { reloaded.push(id); },
            },
        }});
        vm.runInContext('globalThis.__manabitanAndroidRuntimeQualification={ownedExtensionPageTabs:[14,15],ownedExtensionPageTabIds:{"settings.html":14,"search.html":15}}', context);
        await expect(vm.runInContext(buildOwnedPageActivationScript('settings.html'), context)).resolves.toEqual({page: 'settings.html', tabId: 14, activeTabId: 14, url: 'moz-extension://fixture/settings.html'});
        await expect(vm.runInContext(buildOwnedPageActivationScript('search.html'), context)).resolves.toEqual({page: 'search.html', tabId: 15, activeTabId: 15, url: 'moz-extension://fixture/search.html'});
        await expect(vm.runInContext(buildOwnedPageReloadScript('settings.html'), context)).resolves.toMatchObject({reloaded: true, page: 'settings.html', tabId: 14});
        expect(reloaded).toEqual([14]);
        await expect(vm.runInContext(buildOwnedPageActivationScript('other.html'), context)).rejects.toThrow(/unavailable or not in the owned tab list/);
        vm.runInContext('globalThis.__manabitanAndroidRuntimeQualification.ownedExtensionPageTabs.push(99);globalThis.__manabitanAndroidRuntimeQualification.ownedExtensionPageTabIds["settings.html"]=99', context);
        await expect(vm.runInContext(buildOwnedPageReloadScript('settings.html'), context)).rejects.toThrow(/URL mismatch/);
        expect(activeTabId).toBe(15);
        expect(reloaded).toEqual([14]);
    });

    test('queried Search activation requires the owned ID and exact expected Search URL before activation', async () => {
        const searchQuery = '読む';
        const expectedUrl = `moz-extension://fixture/search.html?${new URLSearchParams({query: searchQuery, type: 'terms'})}`;
        let activeTabId = 14;
        let updateCount = 0;
        const tabs = new Map([[14, {id: 14, url: 'moz-extension://fixture/settings.html'}], [15, {id: 15, url: expectedUrl}]]);
        const context = vm.createContext({browser: {
            runtime: {getURL: (/** @type {string} */ page) => `moz-extension://fixture/${page}`},
            tabs: {
                get: async (/** @type {number} */ id) => tabs.get(id),
                update: async (/** @type {number} */ id, /** @type {{active?: boolean}} */ update) => {
                    updateCount++;
                    if (update.active) { activeTabId = id; }
                    return tabs.get(id);
                },
                query: async () => [{...tabs.get(activeTabId), active: true}],
            },
        }});
        vm.runInContext('globalThis.__manabitanAndroidRuntimeQualification={ownedExtensionPageTabs:[14,15],ownedExtensionPageTabIds:{"settings.html":14,"search.html":15}}', context);
        await expect(vm.runInContext(buildOwnedPageActivationScript('search.html', {searchQuery}), context)).resolves.toEqual({page: 'search.html', tabId: 15, activeTabId: 15, url: expectedUrl});
        expect(activeTabId).toBe(15);
        expect(updateCount).toBe(1);

        activeTabId = 14;
        updateCount = 0;
        const invalidUrls = [
            `moz-extension://fixture/search.html?${new URLSearchParams({query: '読', type: 'terms'})}`,
            `moz-extension://fixture/search.html?${new URLSearchParams({query: searchQuery, type: 'kanji'})}`,
            `${expectedUrl}&query=${encodeURIComponent(searchQuery)}`,
            expectedUrl.replace('moz-extension://fixture/', 'moz-extension://foreign/'),
            expectedUrl.replace('/search.html?', '/settings.html?'),
        ];
        for (const url of invalidUrls) {
            tabs.set(15, {id: 15, url});
            await expect(vm.runInContext(buildOwnedPageActivationScript('search.html', {searchQuery}), context)).rejects.toThrow(/URL mismatch/);
            expect(activeTabId).toBe(14);
            expect(updateCount).toBe(0);

            const visibilityContext = vm.createContext({
                browser: {runtime: {getURL: (/** @type {string} */ page) => `moz-extension://fixture/${page}`}},
                location: {href: url},
                document: {visibilityState: 'visible', documentElement: {clientWidth: 414, clientHeight: 758}},
                innerWidth: 414,
                innerHeight: 758,
                outerWidth: 414,
                outerHeight: 758,
                Date,
                setTimeout,
            });
            await expect(vm.runInContext(buildDocumentVisibilityWaitScript('search.html', {searchQuery}), visibilityContext)).rejects.toThrow(/URL changed/);
        }
    });

    test('Dictionaries modal failure captures actual trigger and modal DOM diagnostics', async () => {
        const dom = new JSDOM(`<!doctype html><html><body>${settingsHtml}${modalTemplates}</body></html>`, {runScripts: 'outside-only', url: 'moz-extension://fixture/settings.html'});
        const {document, HTMLElement, HTMLButtonElement, location, getComputedStyle} = dom.window;
        const trigger = document.querySelector('.settings-item-button[data-modal-action="show,dictionaries"]');
        if (!(trigger instanceof HTMLElement)) { throw new Error('Modal test trigger is missing'); }
        const modalTemplate = document.querySelector('#shared-modals-template');
        if (!(modalTemplate instanceof dom.window.HTMLTemplateElement)) { throw new Error('Product modal template is missing'); }
        document.body.append(modalTemplate.content.cloneNode(true));
        document.body.hidden = false;
        const modal = document.querySelector('#dictionaries-modal');
        Object.defineProperty(trigger, 'getBoundingClientRect', {value: () => ({x: 1, y: 2, width: 80, height: 24})});
        Object.defineProperty(trigger, 'scrollIntoView', {value: () => {}});
        Object.defineProperty(modal, 'getBoundingClientRect', {value: () => ({x: 0, y: 0, width: 0, height: 0})});
        document.elementFromPoint = vi.fn(() => document.body);
        let now = 0;
        const context = vm.createContext({
            document,
            HTMLElement,
            HTMLButtonElement,
            location,
            getComputedStyle,
            innerWidth: 320,
            innerHeight: 640,
            outerWidth: 360,
            outerHeight: 720,
            devicePixelRatio: 2,
            setTimeout,
            Error,
            Date: {now: () => { now += 20_000; return now; }},
        });
        let clicks = 0;
        trigger.addEventListener('click', () => { clicks += 1; });
        /** @type {Error & {diagnostic?: Record<string, unknown>}|null} */
        let modalFailure = null;
        try {
            await vm.runInContext(buildDictionaryModalOpenScript({id: 77, url: 'moz-extension://fixture/settings.html'}), context);
        } catch (error) {
            modalFailure = error instanceof Error ? /** @type {Error & {diagnostic?: Record<string, unknown>}} */ (error) : new Error(String(error));
        }
        expect(modalFailure).toBeInstanceOf(Error);
        if (modalFailure === null) { throw new Error('Expected the modal probe to reject'); }
        expect(modalFailure.message).toBe('Shipped Dictionaries modal did not become visible');
        expect(modalFailure.diagnostic).toMatchObject({
            documentReadyState: 'loading',
            documentVisibilityState: 'prerender',
            documentUrl: 'moz-extension://fixture/settings.html',
            triggerSelector: '.settings-item-button[data-modal-action="show,dictionaries"]',
            modalSelector: '#dictionaries-modal',
            activeOwnedTab: {id: 77, url: 'moz-extension://fixture/settings.html'},
            viewport: expect.objectContaining({innerWidth: 320, innerHeight: 640, outerWidth: 360, outerHeight: 720, devicePixelRatio: 2}),
            trigger: expect.objectContaining({tag: 'DIV', disabled: null, rect: {x: 1, y: 2, width: 80, height: 24}}),
            modal: expect.objectContaining({tag: 'DIV', hidden: true, rect: {x: 0, y: 0, width: 0, height: 0}}),
            triggerAncestors: expect.arrayContaining([expect.objectContaining({tag: 'DIV'}), expect.objectContaining({tag: 'BODY'}), expect.objectContaining({tag: 'HTML'})]),
            modalAncestors: expect.arrayContaining([expect.objectContaining({id: 'dictionaries-modal'}), expect.objectContaining({tag: 'BODY'})]),
            viewportCenterHit: expect.objectContaining({tag: 'BODY'}),
        });
        expect(document.elementFromPoint).toHaveBeenCalledWith(160, 320);
        expect(clicks).toBe(1);
    });

    test('Dictionaries modal helper opens the shipped modal through the real settings controllers', async () => {
        const dom = new JSDOM(`<!doctype html><html><body>${settingsHtml}${modalTemplates}</body></html>`, {runScripts: 'outside-only', url: 'moz-extension://fixture/settings.html'});
        const {document, HTMLElement, HTMLButtonElement, location, getComputedStyle} = dom.window;
        const trigger = document.querySelector('.settings-item-button[data-modal-action="show,dictionaries"]');
        const modalTemplate = document.querySelector('#shared-modals-template');
        if (!(trigger instanceof HTMLElement) || !(modalTemplate instanceof dom.window.HTMLTemplateElement)) { throw new Error('Shipped Dictionaries trigger or modal template is missing'); }
        document.body.append(modalTemplate.content.cloneNode(true));
        document.body.hidden = false;
        document.body.hidden = false;
        const modal = document.querySelector('#dictionaries-modal');
        if (!(modal instanceof HTMLElement)) { throw new Error('Shipped Dictionaries modal is missing'); }
        Object.defineProperty(trigger, 'getBoundingClientRect', {value: () => ({x: 1, y: 2, width: 80, height: 24})});
        Object.defineProperty(modal, 'getBoundingClientRect', {value: () => ({x: 0, y: 0, width: 480, height: 320})});
        Object.defineProperty(trigger, 'scrollIntoView', {value: vi.fn()});
        vi.stubGlobal('document', document);
        vi.stubGlobal('window', dom.window);
        vi.stubGlobal('window', Object.assign(dom.window, {matchMedia: () => ({matches: false, addEventListener: () => {}})}));
        vi.stubGlobal('HTMLElement', HTMLElement);
        vi.stubGlobal('Node', dom.window.Node);
        vi.stubGlobal('HTMLButtonElement', HTMLButtonElement);
        vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
        vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
        vi.stubGlobal('getComputedStyle', getComputedStyle);
        try {
            const modalController = new ModalController([]);
            await modalController.prepare();
            const settingsController = {getPreparedProfileOptions: () => ({general: {popupTheme: 'light', popupThemePreset: 'default'}})};
            const displayController = new SettingsDisplayController(/** @type {import('../../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ (settingsController)), modalController);
            await displayController.prepare();
            document.elementFromPoint = vi.fn(() => modal);
            const result = await vm.runInContext(buildDictionaryModalOpenScript({id: 77, url: 'moz-extension://fixture/settings.html'}), vm.createContext({document, HTMLElement, HTMLButtonElement, location, getComputedStyle, innerWidth: 320, innerHeight: 640, outerWidth: 360, outerHeight: 720, devicePixelRatio: 2, setTimeout, Error, Date}));
            expect(result).toMatchObject({openedThroughProductTrigger: true, modalVisible: true, render: {shown: true}});
            expect(result.diagnostic).toMatchObject({viewport: expect.objectContaining({innerWidth: 320, innerHeight: 640}), modalAncestors: expect.arrayContaining([expect.objectContaining({id: 'dictionaries-modal'})])});
            expect(modal.hidden).toBe(false);
            expect(trigger.scrollIntoView).toHaveBeenCalledWith({block: 'center', inline: 'nearest'});
        } finally {
            dom.window.close();
            await tick();
            vi.unstubAllGlobals();
        }
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
