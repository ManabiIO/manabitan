/* Integration coverage for the shipped dictionary settings renderers. */
import {describe, expect, vi} from 'vitest';
import {createDomTest} from './fixtures/dom-test.js';
import {createDictionarySettingsHarness, dictionaryRow} from './fixtures/dictionary-settings-harness.js';

const domTest = createDomTest();

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {Element} element
 */
function change(window, element) {
    element.dispatchEvent(new window.Event('change', {bubbles: true}));
}

describe('real dictionary settings controls', () => {
    domTest('a stale main checkbox cannot change either row after a queued reorder', async ({window}) => {
        const h = await createDictionarySettingsHarness(window, [dictionaryRow('A'), dictionaryRow('B')]);
        try {
            const stale = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-enabled'));
            const reorder = h.settings.modifyProfileSettings([{action: 'moveDictionary', path: 'dictionaries', currentIndex: 0, targetIndex: 1, expectedNames: ['A', 'B'], expectedEntries: h.getRows()}]);
            stale.checked = false;
            change(window, stale);
            await reorder;
            await vi.waitFor(() => expect(h.modifySettings.mock.calls.length).toBeGreaterThan(1));
            await h.modifySettings.mock.results[1].value;
            expect(h.getRows().map(({name, enabled}) => [name, enabled])).toEqual([['B', true], ['A', true]]);
        } finally { h.cleanup(); }
    });

    domTest('main, secondary, and collapsible controls update on first try across independent renders', async ({window}) => {
        const h = await createDictionarySettingsHarness(window, [dictionaryRow('A')]);
        try {
            const main = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-enabled'));
            main.checked = false; change(window, main);
            await vi.waitFor(() => expect(h.getRows()[0]?.enabled).toBe(false));
            const secondary = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-allow-secondary-searches'));
            secondary.checked = true; change(window, secondary);
            await vi.waitFor(() => expect(h.getRows()[0]?.allowSecondarySearches).toBe(true));
            const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('.definitions-collapsible'));
            select.value = 'expanded'; change(window, select);
            await vi.waitFor(() => expect(h.getRows()[0]?.definitionsCollapsible).toBe('expanded'));
            main.checked = true; change(window, main);
            await vi.waitFor(() => expect(h.getRows()[0]?.enabled).toBe(true));
        } finally { h.cleanup(); }
    });

    domTest('same event loop main and secondary changes publish evolving row snapshots', async ({window}) => {
        const h = await createDictionarySettingsHarness(window, [dictionaryRow('A')]);
        try {
            const main = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-enabled'));
            const secondary = /** @type {HTMLInputElement} */ (window.document.querySelector('.dictionary-allow-secondary-searches'));
            main.checked = false; change(window, main);
            secondary.checked = true; change(window, secondary);
            await vi.waitFor(() => expect(h.getRows()[0]).toMatchObject({enabled: false, allowSecondarySearches: true}));
            const select = /** @type {HTMLSelectElement} */ (window.document.querySelector('.definitions-collapsible'));
            select.value = 'expanded'; change(window, select);
            await vi.waitFor(() => expect(h.getRows()[0]).toMatchObject({enabled: false, allowSecondarySearches: true, definitionsCollapsible: 'expanded'}));
        } finally { h.cleanup(); }
    });

    domTest('two same-name rows keep distinct settings and support repeated toggles and edits', async ({window}) => {
        const h = await createDictionarySettingsHarness(window, [dictionaryRow('A', {alias: 'one'}), dictionaryRow('A', {alias: 'two', enabled: false})]);
        try {
            const toggles = window.document.querySelectorAll('.dictionary-allow-secondary-searches');
            expect(toggles).toHaveLength(2);
            const desired = /** @type {HTMLInputElement} */ (toggles[1]);
            desired.checked = true; change(window, desired);
            await vi.waitFor(() => expect(h.getRows()[1]?.allowSecondarySearches).toBe(true));
            desired.checked = false; change(window, desired);
            await vi.waitFor(() => expect(h.getRows()[1]?.allowSecondarySearches).toBe(false));
            const mainRows = window.document.querySelectorAll('.dictionary-enabled');
            const selectedMain = /** @type {HTMLInputElement} */ (mainRows[1]);
            selectedMain.checked = true; change(window, selectedMain);
            await vi.waitFor(() => expect(h.getRows()[1]?.enabled).toBe(true));
            await h.dictionary._dictionaryEntries[1]._move(-1);
            await vi.waitFor(() => expect(h.getRows().map(({alias}) => alias)).toEqual(['two', 'one']));
        } finally { h.cleanup(); }
    });

    domTest('modal delayed save and reset cannot consume a reopened row draft', async ({window}) => {
        const h = await createDictionarySettingsHarness(window, [dictionaryRow('A'), dictionaryRow('A', {alias: 'second'})]);
        try {
            const row0 = h.dictionary._dictionaryEntries[0];
            const row1 = h.dictionary._dictionaryEntries[1];
            const modal = h.modals.get('dictionary-set-alias')?.node;
            expect(modal).toBeDefined();
            const input = /** @type {HTMLInputElement} */ (modal?.querySelector('#dictionary-alias-input'));
            row0._showRenameModal();
            input.value = 'first draft';
            /** @type {(value: import('settings').ProfileOptions) => void} */
            let resolveRead = () => {};
            const pending = new Promise((resolve) => { resolveRead = resolve; });
            const getOptions = h.settings.getOptions.bind(h.settings);
            const spy = vi.spyOn(h.settings, 'getOptions').mockImplementationOnce(() => pending);
            const save = h.dictionary._onDictionarySetAliasButtonClick();
            await vi.waitFor(() => expect(spy).toHaveBeenCalled());
            row1._showRenameModal();
            input.value = 'second draft';
            resolveRead(await getOptions());
            await save;
            expect(input.value).toBe('second draft');
            expect(h.getRows().map(({alias}) => alias)).toEqual(['A', 'second']);
            await h.dictionary._onDictionaryResetAliasButtonClick();
            expect(input.value).toBe('A');
            input.value = 'ordinary save';
            await h.dictionary._onDictionarySetAliasButtonClick();
            await vi.waitFor(() => expect(h.getRows()[1]?.alias).toBe('ordinary save'));
        } finally { h.cleanup(); }
    });

    domTest('recovery-required dictionary without a download URL opens local file selection', async ({window}) => {
        for (const downloadUrl of [undefined, null, '', 'undefined']) {
            const h = await createDictionarySettingsHarness(window, [dictionaryRow('JMdict')]);
            try {
                const dictionaries = /** @type {import('dictionary-importer').Summary[]} */ (/** @type {unknown} */ (Reflect.get(h.dictionary, '_dictionaries')));
                const info = dictionaries[0];
                if (!info) { throw new Error('Expected installed dictionary info'); }
                info.storageHealth = 'reimportRequired';
                if (downloadUrl === undefined) {
                    delete info.downloadUrl;
                } else {
                    Reflect.set(info, 'downloadUrl', downloadUrl);
                }
                const entry = h.dictionary._dictionaryEntries[0];
                const detailsModal = h.modals.get('dictionary-details');
                if (!detailsModal) { throw new Error('Expected dictionary details modal'); }
                const originalCreateElement = window.document.createElement.bind(window.document);
                const fileInputState = /** @type {{value: HTMLInputElement|null, clickCount: number}} */ ({value: null, clickCount: 0});
                vi.spyOn(window.document, 'createElement').mockImplementation((name, options) => {
                    const element = originalCreateElement(name, options);
                    if (name === 'input') {
                        fileInputState.value = /** @type {HTMLInputElement} */ (element);
                        vi.spyOn(element, 'click').mockImplementation(() => { ++fileInputState.clickCount; });
                    }
                    return element;
                });
                const enqueue = vi.spyOn(h.dictionary, '_enqueueTask').mockImplementation(() => {});
                const update = vi.spyOn(h.dictionary, 'updateDictionary').mockImplementation(() => {});

                entry._showDetails();
                const buttonNode = detailsModal.node.querySelector('.dictionary-reimport-button');
                if (!(buttonNode instanceof window.HTMLButtonElement)) { throw new Error('Expected recovery button'); }
                buttonNode.click();
                const fileInput = fileInputState.value;
                if (fileInput === null) { throw new Error('Expected file picker input'); }
                expect(fileInputState.clickCount).toBe(1);
                expect(fileInput.type).toBe('file');
                expect(fileInput.multiple).toBe(true);
                expect(enqueue).not.toHaveBeenCalled();
                expect(update).not.toHaveBeenCalled();
                const file = new window.File(['dictionary'], 'jmdict.zip', {type: 'application/zip'});
                Object.defineProperty(fileInput, 'files', {configurable: true, value: [file]});
                fileInput.dispatchEvent(new window.Event('change'));
                expect(enqueue).toHaveBeenCalledWith({type: 'replaceFromFiles', dictionaryTitle: 'JMdict', files: [file]});
                expect(update).not.toHaveBeenCalled();
                expect(buttonNode.textContent).toBe('Choose file...');
            } finally {
                vi.restoreAllMocks();
                h.cleanup();
            }
        }
    });

    domTest('recovery-required dictionary prefers its available update URL and ordinary dictionaries hide recovery action', async ({window}) => {
        const h = await createDictionarySettingsHarness(window, [dictionaryRow('JMdict')]);
        try {
            const dictionaries = /** @type {import('dictionary-importer').Summary[]} */ (/** @type {unknown} */ (Reflect.get(h.dictionary, '_dictionaries')));
            const info = dictionaries[0];
            if (!info) { throw new Error('Expected installed dictionary info'); }
            info.storageHealth = 'reimportRequired';
            info.downloadUrl = 'https://example.invalid/current.zip';
            const entry = h.dictionary._dictionaryEntries[0];
            const detailsModal = h.modals.get('dictionary-details');
            if (!detailsModal) { throw new Error('Expected dictionary details modal'); }
            const update = vi.spyOn(h.dictionary, 'updateDictionary').mockImplementation(() => {});
            const reimport = vi.spyOn(h.dictionary, 'reimportDictionaryFromFile');

            Reflect.set(entry, '_updateDownloadUrl', 'https://example.invalid/newer.zip');
            entry._showDetails();
            const button = detailsModal.node.querySelector('.dictionary-reimport-button');
            if (!(button instanceof window.HTMLButtonElement)) { throw new Error('Expected recovery button'); }
            expect(button.textContent).toBe('Download again');
            button.click();
            expect(update).toHaveBeenCalledWith('JMdict', 'https://example.invalid/newer.zip');
            expect(reimport).not.toHaveBeenCalled();

            update.mockClear();
            Reflect.set(entry, '_updateDownloadUrl', null);
            entry._showDetails();
            button.click();
            expect(update).toHaveBeenCalledWith('JMdict', 'https://example.invalid/current.zip');

            info.storageHealth = 'available';
            entry._showDetails();
            expect(button.hidden).toBe(true);
            expect(button.onclick).toBeNull();
        } finally {
            vi.restoreAllMocks();
            h.cleanup();
        }
    });
});
