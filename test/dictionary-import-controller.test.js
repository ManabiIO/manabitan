/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {DictionaryImportController, ImportProgressTracker} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();
afterAll(async () => {
    await testEnv.teardown(global);
});

/**
 * @param {Document} document
 * @returns {HTMLElement}
 * @throws {Error}
 */
function setupProgressDom(document) {
    document.body.innerHTML = `
        <div class="dictionary-import-progress">
            <div class="progress-info"></div>
            <div class="progress-bar"></div>
            <div class="progress-status"></div>
        </div>
    `;
    const info = document.querySelector('.dictionary-import-progress .progress-info');
    if (!(info instanceof HTMLElement)) {
        throw new Error('Expected progress info element');
    }
    return info;
}

/**
 * @returns {import('dictionary-importer').ImportSteps}
 * @throws {Error}
 */
function getFileImportSteps() {
    const getFileImportStepsMethod = Reflect.get(DictionaryImportController.prototype, '_getFileImportSteps');
    if (typeof getFileImportStepsMethod !== 'function') {
        throw new Error('Expected _getFileImportSteps method');
    }
    return getFileImportStepsMethod.call({});
}

/**
 * @returns {import('dictionary-importer').ImportSteps}
 * @throws {Error}
 */
function getUrlImportSteps() {
    const getUrlImportStepsMethod = Reflect.get(DictionaryImportController.prototype, '_getUrlImportSteps');
    if (typeof getUrlImportStepsMethod !== 'function') {
        throw new Error('Expected _getUrlImportSteps method');
    }
    /** @type {Record<string, unknown>} */
    const context = {};
    Reflect.set(context, '_getFileImportSteps', () => getFileImportSteps());
    return getUrlImportStepsMethod.call(context);
}

/**
 * @param {Partial<import('dictionary-recommended.js').LanguageRecommendedDictionaries>} [overrides]
 * @returns {import('dictionary-recommended.js').LanguageRecommendedDictionaries}
 */
function createLanguageRecommendations(overrides = {}) {
    return {
        terms: [],
        kanji: [],
        frequency: [],
        grammar: [],
        pronunciation: [],
        ...overrides,
    };
}

/**
 * @returns {DictionaryImportController}
 */
function createControllerForInternalTests() {
    return /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
}

/**
 * @param {Document} document
 * @param {string} value
 * @returns {HTMLSelectElement}
 */
function createLanguageSelect(document, value) {
    const select = document.createElement('select');
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
    select.value = value;
    return select;
}

/**
 * @param {string} name
 * @returns {File}
 */
function createFile(name) {
    const file = new File(['test'], name);
    if (typeof file.arrayBuffer !== 'function') {
        Reflect.set(file, 'arrayBuffer', async () => new TextEncoder().encode('test').buffer);
    }
    return file;
}

/**
 * @param {File} file
 * @returns {FileSystemFileEntry}
 */
function createFileEntry(file) {
    /** @type {FileSystemFileEntry['file']} */
    const fileCallback = (resolve, _reject) => {
        resolve(file);
    };
    return /** @type {FileSystemFileEntry} */ (/** @type {unknown} */ ({
        isFile: true,
        isDirectory: false,
        name: file.name,
        file: fileCallback,
    }));
}

/**
 * @param {Document} document
 * @returns {void}
 */
function setupImportFlowDom(document) {
    document.body.innerHTML = `
        <div id="dictionaries-modal">
            <div class="dictionary-import-progress">
                <div class="progress-info"></div>
                <div class="progress-bar"></div>
                <div class="progress-status"></div>
            </div>
        </div>
        <div id="recommended-dictionaries-modal">
            <div class="dictionary-import-progress">
                <div class="progress-info"></div>
                <div class="progress-bar"></div>
                <div class="progress-status"></div>
            </div>
        </div>
    `;
}

/**
 * @param {Document} document
 * @returns {{sourceList: HTMLElement, sourceEmpty: HTMLElement, importConfirmButton: HTMLButtonElement, showErrors: ReturnType<typeof vi.fn>}}
 */
function setupPendingImportDom(document) {
    document.body.innerHTML = `
        <div id="dictionary-import-source-list"></div>
        <p id="dictionary-import-source-empty"></p>
        <button id="dictionary-import-confirm-button"></button>
    `;
    const sourceList = /** @type {HTMLElement} */ (document.querySelector('#dictionary-import-source-list'));
    const sourceEmpty = /** @type {HTMLElement} */ (document.querySelector('#dictionary-import-source-empty'));
    const importConfirmButton = /** @type {HTMLButtonElement} */ (document.querySelector('#dictionary-import-confirm-button'));
    if (!(sourceList instanceof HTMLElement) || !(sourceEmpty instanceof HTMLElement) || !(importConfirmButton instanceof HTMLButtonElement)) {
        throw new Error('Expected pending import UI nodes');
    }
    return {
        sourceList,
        sourceEmpty,
        importConfirmButton,
        showErrors: vi.fn(),
    };
}

/**
 * @returns {import('settings').Options}
 */
function createOptionsFull() {
    return /** @type {import('settings').Options} */ (/** @type {unknown} */ ({
        global: {
            database: {
                prefixWildcardsSupported: true,
            },
        },
        profiles: [],
        profileCurrent: 0,
    }));
}

/**
 * @param {DictionaryImportController} controller
 * @returns {{showErrors: ReturnType<typeof vi.fn>, triggerStorageChanged: ReturnType<typeof vi.fn>, releaseDictionaryWorker: ReturnType<typeof vi.fn>, setDictionaryImportMode: ReturnType<typeof vi.fn>, triggerDatabaseUpdated: ReturnType<typeof vi.fn>}}
 */
function setupControllerImportHarness(controller) {
    const triggerDatabaseUpdated = vi.fn().mockResolvedValue(void 0);
    const setDictionaryImportMode = vi.fn().mockResolvedValue(void 0);
    const showErrors = vi.fn();
    const triggerStorageChanged = vi.fn();
    const releaseDictionaryWorker = vi.fn();

    Reflect.set(controller, '_modifying', false);
    Reflect.set(controller, '_statusFooter', {setTaskActive: vi.fn()});
    Reflect.set(controller, '_preventPageExit', vi.fn(() => ({end: vi.fn()})));
    Reflect.set(controller, '_setModifying', vi.fn((value) => { Reflect.set(controller, '_modifying', value); }));
    Reflect.set(controller, '_hideErrors', vi.fn());
    Reflect.set(controller, '_showErrors', showErrors);
    Reflect.set(controller, '_triggerStorageChanged', triggerStorageChanged);
    Reflect.set(controller, '_releaseDictionaryWorker', releaseDictionaryWorker);
    Reflect.set(controller, '_settingsController', {
        application: {
            api: {
                setDictionaryImportMode,
                triggerDatabaseUpdated,
            },
        },
        getOptionsFull: vi.fn().mockResolvedValue(createOptionsFull()),
    });

    return {
        showErrors,
        triggerStorageChanged,
        releaseDictionaryWorker,
        setDictionaryImportMode,
        triggerDatabaseUpdated,
    };
}

/**
 * @param {string} name
 * @returns {Function}
 * @throws {Error}
 */
function getDictionaryImportControllerMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryImportController.prototype, name));
    if (typeof method !== 'function') {
        throw new Error(`Expected DictionaryImportController.${name} to be a function`);
    }
    return method;
}

describe('Dictionary import progress steps', () => {
    const {window} = testEnv;

    test('File and URL import steps exclude validation phase', () => {
        const fileImportSteps = getFileImportSteps();
        expect(fileImportSteps.map(({label}) => label)).toStrictEqual([
            '',
            'Initializing import',
            'Preparing dictionary',
            'Loading dictionary',
            'Importing data',
            'Finalizing import',
        ]);

        const urlImportSteps = getUrlImportSteps();
        expect(urlImportSteps.map(({label}) => label)).toStrictEqual([
            '',
            'Initializing import',
            'Downloading dictionary',
            'Preparing dictionary',
            'Loading dictionary',
            'Importing data',
            'Finalizing import',
        ]);

        for (const label of [...fileImportSteps, ...urlImportSteps].map(({label: stepLabel}) => stepLabel.toLowerCase())) {
            expect(label.includes('validat')).toBe(false);
        }
    });

    test('ImportProgressTracker keeps step numbering stable without validation', () => {
        const infoLabel = setupProgressDom(window.document);
        const steps = getFileImportSteps();
        const tracker = new ImportProgressTracker(steps, 1);

        expect(infoLabel.textContent).toBe('Importing dictionary - Step 1 of 6: ...');

        tracker.onNextDictionary();
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 2 of 6: Initializing import...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 3 of 6: Preparing dictionary...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 4 of 6: Loading dictionary...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 5 of 6: Importing data...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 6 of 6: Finalizing import...');
    });
});

describe('Local dictionary source grouping', () => {
    const createImportSourcesFromFiles = /** @type {(files: File[]) => {sources: Array<{type: string, file?: File, mdxFile?: File, mddFiles?: File[]}>, errors: Error[], hasMdx: boolean}} */ (getDictionaryImportControllerMethod('_createImportSourcesFromFiles'));

    test('groups MDX files with ordered MDD companions and preserves selection order', () => {
        const controller = createControllerForInternalTests();
        const result = createImportSourcesFromFiles.call(controller, [
            createFile('zipped.zip'),
            createFile('Alpha.2.mdd'),
            createFile('Alpha.mdx'),
            createFile('Alpha.mdd'),
            createFile('Beta.mdx'),
            createFile('Beta.1.mdd'),
        ]);

        expect(result.errors).toHaveLength(0);
        expect(result.hasMdx).toBe(true);
        expect(result.sources).toHaveLength(3);
        expect(result.sources[0]).toMatchObject({type: 'zip'});
        expect(result.sources[1]).toMatchObject({type: 'mdx', mdxFile: expect.objectContaining({name: 'Alpha.mdx'})});
        expect(result.sources[2]).toMatchObject({type: 'mdx', mdxFile: expect.objectContaining({name: 'Beta.mdx'})});
        expect(result.sources[1]?.type === 'mdx' ? result.sources[1].mddFiles?.map(({name}) => name) : []).toStrictEqual(['Alpha.mdd', 'Alpha.2.mdd']);
        expect(result.sources[2]?.type === 'mdx' ? result.sources[2].mddFiles?.map(({name}) => name) : []).toStrictEqual(['Beta.1.mdd']);
    });

    test('reports orphan MDD files and duplicate MDX entries', () => {
        const controller = createControllerForInternalTests();
        const result = createImportSourcesFromFiles.call(controller, [
            createFile('Gamma.mdd'),
            createFile('Dup.mdx'),
            createFile('Dup.mdx'),
        ]);

        expect(result.sources).toHaveLength(1);
        expect(result.errors.map((error) => error.message)).toStrictEqual([
            'Multiple MDX files matched the same dictionary group: Dup.mdx',
            'Found MDD resources without a matching MDX file: Gamma.mdd',
        ]);
    });
});

describe('MDX import readiness', () => {
    const ensureMdxImportReady = /** @type {(this: DictionaryImportController) => Promise<void>} */ (getDictionaryImportControllerMethod('_ensureMdxImportReady'));

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('checks MDX converter availability through the browser client', async () => {
        const controller = createControllerForInternalTests();
        const getMdxVersion = vi.fn().mockResolvedValue(2);

        Reflect.set(controller, '_getMdxVersion', getMdxVersion);

        await expect(ensureMdxImportReady.call(controller)).resolves.toBeUndefined();
        expect(getMdxVersion).toHaveBeenCalledTimes(1);
    });

    test('surfaces browser-side converter readiness errors unchanged', async () => {
        const controller = createControllerForInternalTests();
        const getMdxVersion = vi.fn().mockRejectedValue(new Error('MDX worker bootstrap failed'));

        Reflect.set(controller, '_getMdxVersion', getMdxVersion);

        await expect(ensureMdxImportReady.call(controller)).rejects.toThrow('MDX worker bootstrap failed');
        expect(getMdxVersion).toHaveBeenCalledTimes(1);
    });
});

describe('MDX companion discovery and URL resolution', () => {
    const createImportSourceFromUrl = /** @type {(this: DictionaryImportController, url: string, onProgress: import('dictionary-worker').ImportProgressCallback) => Promise<{type: string, file?: File, mdxFile?: File, mddFiles?: File[]}>} */ (getDictionaryImportControllerMethod('_createImportSourceFromUrl'));
    const generateFilesFromUrls = /** @type {(this: DictionaryImportController, urls: string[], onProgress: import('dictionary-worker').ImportProgressCallback) => AsyncGenerator<{type: string, file?: File, mdxFile?: File, mddFiles?: File[]}, void, void>} */ (getDictionaryImportControllerMethod('_generateFilesFromUrls'));

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test('parses a simple MDX directory listing URL into one MDX source with companions', async () => {
        const controller = createControllerForInternalTests();
        const downloadMdxImportSourceFromListing = vi.fn().mockResolvedValue({
            type: 'mdx',
            mdxFile: createFile('OED2e.mdx'),
            mddFiles: [createFile('OED2e.mdd')],
        });
        Reflect.set(controller, '_downloadBlobResponseFromUrl', vi.fn().mockResolvedValue({
            blob: /** @type {Blob} */ (/** @type {unknown} */ ({text: vi.fn().mockResolvedValue(`
                <html><body>
                    <a href="./OED2e.mdx">OED2e.mdx</a>
                    <a href="./OED2e.mdd">OED2e.mdd</a>
                    <a href="./OED2e.css">OED2e.css</a>
                </body></html>
            `)})),
            fileName: 'index.html',
            contentType: 'text/html',
        }));
        Reflect.set(controller, '_downloadMdxImportSourceFromListing', downloadMdxImportSourceFromListing);

        const source = await createImportSourceFromUrl.call(
            controller,
            'https://mdx.mdict.org/%E5%85%AD%E5%A4%A7%E7%9F%A5%E5%90%8D%E8%AF%8D%E5%85%B8/%E7%89%9B%E6%B4%A5_Oxford/Oxford%20English%20Dictionary%202nd%20v4_%2014-10-9/?sort=size&order=desc',
            vi.fn(),
        );

        expect(source).toMatchObject({type: 'mdx', mdxFile: expect.objectContaining({name: 'OED2e.mdx'})});
        expect(downloadMdxImportSourceFromListing).toHaveBeenCalledWith({
            mdxLink: {
                url: 'https://mdx.mdict.org/%E5%85%AD%E5%A4%A7%E7%9F%A5%E5%90%8D%E8%AF%8D%E5%85%B8/%E7%89%9B%E6%B4%A5_Oxford/Oxford%20English%20Dictionary%202nd%20v4_%2014-10-9/OED2e.mdx',
                fileName: 'OED2e.mdx',
            },
            mddLinks: [{
                url: 'https://mdx.mdict.org/%E5%85%AD%E5%A4%A7%E7%9F%A5%E5%90%8D%E8%AF%8D%E5%85%B8/%E7%89%9B%E6%B4%A5_Oxford/Oxford%20English%20Dictionary%202nd%20v4_%2014-10-9/OED2e.mdd',
                fileName: 'OED2e.mdd',
            }],
        }, expect.any(Function));
    });

    test('ensures MDX readiness only once for multiple MDX URL imports', async () => {
        const controller = createControllerForInternalTests();
        const ensureMdxImportReady = vi.fn().mockResolvedValue(void 0);
        const createImportSource = vi.fn()
            .mockResolvedValueOnce({type: 'mdx', mdxFile: createFile('Alpha.mdx'), mddFiles: []})
            .mockResolvedValueOnce({type: 'mdx', mdxFile: createFile('Beta.mdx'), mddFiles: []});
        Reflect.set(controller, '_ensureMdxImportReady', ensureMdxImportReady);
        Reflect.set(controller, '_createImportSourceFromUrl', createImportSource);

        const results = [];
        for await (const source of generateFilesFromUrls.call(controller, [
            'https://example.invalid/Alpha.mdx',
            'https://example.invalid/Beta.mdx',
        ], vi.fn())) {
            results.push(source);
        }

        expect(results).toHaveLength(2);
        expect(ensureMdxImportReady).toHaveBeenCalledTimes(1);
        expect(ensureMdxImportReady.mock.invocationCallOrder[0]).toBeLessThan(createImportSource.mock.invocationCallOrder[0]);
    });
});

describe('MDX file picker flow', () => {
    const onImportFileChange = /** @type {(this: DictionaryImportController, e: Event) => Promise<void>} */ (getDictionaryImportControllerMethod('_onImportFileChange'));

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test('starts importing MDX files without prompting for missing companions', async () => {
        const controller = createControllerForInternalTests();
        const source = /** @type {{type: 'mdx', mdxFile: File, mddFiles: File[]}} */ ({
            type: 'mdx',
            mdxFile: createFile('Alpha.mdx'),
            mddFiles: [],
        });
        const createImportSourcesFromFiles = vi.fn().mockReturnValue({sources: [source], errors: [], hasMdx: true});
        const ensureMdxImportReady = vi.fn().mockResolvedValue(void 0);
        const importSelectedSources = vi.fn();

        vi.stubGlobal('showDirectoryPicker', vi.fn());

        Reflect.set(controller, '_createImportSourcesFromFiles', createImportSourcesFromFiles);
        Reflect.set(controller, '_ensureMdxImportReady', ensureMdxImportReady);
        Reflect.set(controller, '_importSelectedSources', importSelectedSources);
        Reflect.set(controller, '_showErrors', vi.fn());

        const input = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ({
            files: [createFile('Alpha.mdx')],
            value: 'picked',
        }));

        await onImportFileChange.call(
            controller,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: input})),
        );

        expect(input.value).toBe('');
        expect(createImportSourcesFromFiles).toHaveBeenCalledWith([expect.objectContaining({name: 'Alpha.mdx'})]);
        expect(ensureMdxImportReady).toHaveBeenCalledOnce();
        expect(importSelectedSources).toHaveBeenCalledWith([source], []);
    });

    test('starts one import batch when multiple valid local dictionaries are selected', async () => {
        const controller = createControllerForInternalTests();
        const sources = [
            /** @type {{type: 'mdx', mdxFile: File, mddFiles: File[]}} */ ({
                type: 'mdx',
                mdxFile: createFile('Alpha.mdx'),
                mddFiles: [],
            }),
            /** @type {{type: 'mdx', mdxFile: File, mddFiles: File[]}} */ ({
                type: 'mdx',
                mdxFile: createFile('Beta.mdx'),
                mddFiles: [],
            }),
        ];
        const ensureMdxImportReady = vi.fn().mockResolvedValue(void 0);
        const importSelectedSources = vi.fn();

        Reflect.set(controller, '_createImportSourcesFromFiles', vi.fn().mockReturnValue({
            sources,
            errors: [],
            hasMdx: true,
        }));
        Reflect.set(controller, '_ensureMdxImportReady', ensureMdxImportReady);
        Reflect.set(controller, '_importSelectedSources', importSelectedSources);
        Reflect.set(controller, '_showErrors', vi.fn());

        const input = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ({
            files: [sources[0].mdxFile, sources[1].mdxFile],
            value: 'picked',
        }));

        await onImportFileChange.call(
            controller,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: input})),
        );

        expect(input.value).toBe('');
        expect(ensureMdxImportReady).toHaveBeenCalledOnce();
        expect(importSelectedSources).toHaveBeenCalledTimes(1);
        expect(importSelectedSources).toHaveBeenCalledWith(sources, []);
    });

    test('does not start importing when MDX readiness fails', async () => {
        const controller = createControllerForInternalTests();
        const readinessError = new Error('MDX worker bootstrap failed');
        const importSelectedSources = vi.fn();
        const showErrors = vi.fn();

        Reflect.set(controller, '_createImportSourcesFromFiles', vi.fn().mockReturnValue({
            sources: [{type: 'mdx', mdxFile: createFile('Alpha.mdx'), mddFiles: []}],
            errors: [],
            hasMdx: true,
        }));
        Reflect.set(controller, '_ensureMdxImportReady', vi.fn().mockRejectedValue(readinessError));
        Reflect.set(controller, '_importSelectedSources', importSelectedSources);
        Reflect.set(controller, '_showErrors', showErrors);

        const input = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ({
            files: [createFile('Alpha.mdx')],
            value: 'picked',
        }));

        await onImportFileChange.call(
            controller,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: input})),
        );

        expect(importSelectedSources).not.toHaveBeenCalled();
        expect(showErrors).toHaveBeenCalledWith([readinessError]);
    });

    test('passes selection errors into the auto-import flow when valid files remain', async () => {
        const controller = createControllerForInternalTests();
        const source = {type: 'zip', file: createFile('Alpha.zip')};
        const selectionError = new Error('Unsupported dictionary file: notes.txt');
        const importSelectedSources = vi.fn();

        Reflect.set(controller, '_createImportSourcesFromFiles', vi.fn().mockReturnValue({
            sources: [source],
            errors: [selectionError],
            hasMdx: false,
        }));
        Reflect.set(controller, '_importSelectedSources', importSelectedSources);
        Reflect.set(controller, '_showErrors', vi.fn());

        const input = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ({
            files: [createFile('Alpha.zip'), createFile('notes.txt')],
            value: 'picked',
        }));

        await onImportFileChange.call(
            controller,
            /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: input})),
        );

        expect(importSelectedSources).toHaveBeenCalledWith([source], [selectionError]);
    });
});

describe('Dictionary import error display', () => {
    const {window} = testEnv;
    const showErrors = /** @type {(this: DictionaryImportController, errors: Error[]) => void} */ (getDictionaryImportControllerMethod('_showErrors'));

    afterEach(() => {
        vi.restoreAllMocks();
        window.document.body.innerHTML = '';
    });

    test('shows duplicate import skip errors while logging them as warnings', () => {
        const controller = createControllerForInternalTests();
        const errorContainer = window.document.createElement('div');
        errorContainer.hidden = true;
        window.document.body.appendChild(errorContainer);

        Reflect.set(controller, '_errorContainer', errorContainer);
        Reflect.set(controller, '_errorToStringOverrides', []);

        const duplicateImportError = new Error('Dictionary Alpha Dictionary is already imported, skipped it.');
        const importFailure = new Error('Invalid dictionary archive');
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

        showErrors.call(controller, [duplicateImportError, duplicateImportError, importFailure]);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(duplicateImportError);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith(importFailure);
        expect(errorContainer.hidden).toBe(false);
        expect(errorContainer.querySelectorAll('p')).toHaveLength(2);
        expect(errorContainer.textContent).toContain('Error: Dictionary Alpha Dictionary is already imported, skipped it.');
        expect(errorContainer.textContent).toContain('(2)');
        expect(errorContainer.textContent).toContain('Error: Invalid dictionary archive');
    });
});

describe('Welcome recommended dictionary auto import', () => {
    const {window} = testEnv;
    const resolveRecommendedLanguage = /** @type {(requestedLanguage: string, recommendedDictionaries: import('dictionary-recommended.js').RecommendedDictionaries, allowJapaneseFallback: boolean) => string | null} */ (getDictionaryImportControllerMethod('_resolveRecommendedLanguage'));
    const getWelcomeAutoImportDecision = /** @type {(requestedLanguage: string, recommendedDictionaries: import('dictionary-recommended.js').RecommendedDictionaries, installedDictionaries: import('dictionary-importer').Summary[]) => {status: string, resolvedLanguage: string | null, urls: string[]}} */ (getDictionaryImportControllerMethod('_getWelcomeAutoImportDecision'));
    const onWelcomeLanguageSelectChanged = /** @type {(event: Event) => Promise<void>} */ (getDictionaryImportControllerMethod('_onWelcomeLanguageSelectChanged'));

    test('resolves exact and base language without Japanese fallback', () => {
        const controller = createControllerForInternalTests();
        const recommended = {
            en: createLanguageRecommendations({terms: [{name: 'A', downloadUrl: 'https://example.invalid/a.zip', description: 'A'}]}),
            ja: createLanguageRecommendations({terms: [{name: 'J', downloadUrl: 'https://example.invalid/j.zip', description: 'J'}]}),
        };

        const exact = resolveRecommendedLanguage.call(controller, 'en', recommended, false);
        const base = resolveRecommendedLanguage.call(controller, 'en-US', recommended, false);
        const none = resolveRecommendedLanguage.call(controller, 'fr-CA', recommended, false);

        expect(exact).toBe('en');
        expect(base).toBe('en');
        expect(none).toBeNull();
    });

    test('does not fallback to Japanese for welcome auto import', () => {
        const controller = createControllerForInternalTests();
        const recommended = {
            ja: createLanguageRecommendations({terms: [{name: 'Jitendex', downloadUrl: 'https://example.invalid/jitendex.zip', description: 'J'}]}),
        };
        const decision = getWelcomeAutoImportDecision.call(controller, 'fr', recommended, []);
        expect(decision.status).toBe('no-match');
    });

    test('flattens categories, de-duplicates URLs, and skips installed dictionaries', () => {
        const controller = createControllerForInternalTests();
        const recommended = {
            en: createLanguageRecommendations({
                terms: [
                    {name: 'A', downloadUrl: 'https://example.invalid/a.zip', description: 'A'},
                    {name: 'B', downloadUrl: 'https://example.invalid/b.zip', description: 'B'},
                ],
                kanji: [
                    {name: 'B-duplicate', downloadUrl: 'https://example.invalid/b.zip', description: 'B2'},
                ],
                frequency: [
                    {name: 'F', downloadUrl: 'https://example.invalid/f.zip', description: 'F'},
                ],
                pronunciation: [
                    {name: 'P', downloadUrl: 'https://example.invalid/p.zip', description: 'P'},
                ],
            }),
        };
        const installed = /** @type {import('dictionary-importer').Summary[]} */ (/** @type {unknown} */ ([
            {title: 'B', downloadUrl: 'https://example.invalid/b.zip'},
            {title: 'already-url', downloadUrl: 'https://example.invalid/p.zip'},
        ]));

        const decision = getWelcomeAutoImportDecision.call(controller, 'en-US', recommended, installed);
        expect(decision.status).toBe('ready');
        if (decision.status !== 'ready') {
            throw new Error(`Expected ready status, got ${decision.status}`);
        }
        expect(decision.resolvedLanguage).toBe('en');
        expect(decision.urls).toStrictEqual([
            'https://example.invalid/a.zip',
            'https://example.invalid/f.zip',
        ]);
    });

    test('returns already-installed when all recommendations are already present', () => {
        const controller = createControllerForInternalTests();
        const recommended = {
            en: createLanguageRecommendations({
                terms: [
                    {name: 'A', downloadUrl: 'https://example.invalid/a.zip', description: 'A'},
                ],
            }),
        };
        const installed = /** @type {import('dictionary-importer').Summary[]} */ (/** @type {unknown} */ ([
            {title: 'A', downloadUrl: 'https://example.invalid/a.zip'},
        ]));
        const decision = getWelcomeAutoImportDecision.call(controller, 'en', recommended, installed);
        expect(decision.status).toBe('already-installed');
    });

    test('change handler does not auto-import outside welcome page', async () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_welcomeLanguageAutoImportEnabled', false);
        const importFilesFromURLs = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, 'importFilesFromURLs', importFilesFromURLs);

        const select = createLanguageSelect(window.document, 'en');
        await onWelcomeLanguageSelectChanged.call(controller, /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: select})));

        expect(importFilesFromURLs).not.toHaveBeenCalled();
    });

    test('change handler shows no-match status and does not import', async () => {
        const controller = createControllerForInternalTests();
        Reflect.set(controller, '_welcomeLanguageAutoImportEnabled', true);
        Reflect.set(controller, '_modifying', false);
        Reflect.set(controller, '_settingsController', {
            getDictionaryInfo: vi.fn().mockResolvedValue([]),
        });
        Reflect.set(controller, '_loadRecommendedDictionaries', vi.fn().mockResolvedValue({
            recommendedDictionaries: {
                ja: createLanguageRecommendations({
                    terms: [{name: 'Jitendex', downloadUrl: 'https://example.invalid/jitendex.zip', description: 'J'}],
                }),
            },
            source: 'extension-data',
            url: '../../data/recommended-dictionaries.json',
        }));
        const setWelcomeLanguageAutoImportStatus = vi.fn();
        Reflect.set(controller, '_setWelcomeLanguageAutoImportStatus', setWelcomeLanguageAutoImportStatus);
        const importFilesFromURLs = vi.fn().mockResolvedValue(void 0);
        Reflect.set(controller, 'importFilesFromURLs', importFilesFromURLs);

        const select = createLanguageSelect(window.document, 'de');
        await onWelcomeLanguageSelectChanged.call(controller, /** @type {Event} */ (/** @type {unknown} */ ({currentTarget: select})));

        expect(importFilesFromURLs).not.toHaveBeenCalled();
        const lastCall = setWelcomeLanguageAutoImportStatus.mock.calls.at(-1);
        expect(lastCall?.[0]).toContain('No recommended dictionaries are currently available');
        expect(lastCall?.[0]).toContain('"de"');
    });
});

describe('MDX import flow integration', () => {
    const {window} = testEnv;
    const arrayToAsyncGenerator = /** @type {(this: DictionaryImportController, arr: unknown[]) => AsyncGenerator<unknown, void, void>} */ (getDictionaryImportControllerMethod('_arrayToAsyncGenerator'));
    const importSelectedSources = /** @type {(this: DictionaryImportController, sources: unknown[], initialErrors?: Error[]) => void} */ (getDictionaryImportControllerMethod('_importSelectedSources'));
    const importDictionaries = /** @type {(this: DictionaryImportController, dictionaries: AsyncGenerator<unknown, void, void>, profilesDictionarySettings: import('settings-controller').ProfilesDictionarySettings, onImportDone: import('settings-controller').ImportDictionaryDoneCallback, importProgressTracker: ImportProgressTracker, initialErrors?: Error[]) => Promise<void>} */ (getDictionaryImportControllerMethod('_importDictionaries'));
    const importDictionaryFromMdx = /** @type {(this: DictionaryImportController, source: {type: 'mdx', mdxFile: File, mddFiles: File[]}, profilesDictionarySettings: import('settings-controller').ProfilesDictionarySettings, importDetails: import('dictionary-importer').ImportDetails, dictionaryWorker: unknown, useImportSession: boolean, finalizeImportSession: boolean, onProgress: import('dictionary-worker').ImportProgressCallback) => Promise<Error[]|undefined>} */ (getDictionaryImportControllerMethod('_importDictionaryFromMdx'));
    const importDictionaryArchiveContent = /** @type {(this: DictionaryImportController, dictionaryTitle: string, archiveContent: ArrayBuffer, profilesDictionarySettings: import('settings-controller').ProfilesDictionarySettings, importDetails: import('dictionary-importer').ImportDetails, dictionaryWorker: {importDictionary: ReturnType<typeof vi.fn>}, useImportSession: boolean, finalizeImportSession: boolean, onProgress: import('dictionary-worker').ImportProgressCallback, importStartTime: number, localPhaseTimings: Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>, recordLocalPhase: (phase: string, startTime: number, endTime: number, details?: Record<string, string|number|boolean|null>) => void) => Promise<Error[]|undefined>} */ (getDictionaryImportControllerMethod('_importDictionaryArchiveContent'));
    const onFileDrop = /** @type {(this: DictionaryImportController, e: DragEvent) => Promise<void>} */ (getDictionaryImportControllerMethod('_onFileDrop'));
    const onImportConfirm = /** @type {(this: DictionaryImportController) => void} */ (getDictionaryImportControllerMethod('_onImportConfirm'));

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        window.document.body.innerHTML = '';
    });

    test('imports mixed MDX and zip sources through one session and finalizes on the last dictionary', async () => {
        setupImportFlowDom(window.document);
        vi.stubGlobal('chrome', {
            runtime: {
                getManifest: () => ({version: '1.2.3.4'}),
            },
        });

        const controller = createControllerForInternalTests();
        const {showErrors, triggerStorageChanged, releaseDictionaryWorker, setDictionaryImportMode} = setupControllerImportHarness(controller);
        const dictionaryWorker = {};
        const importMdxCall = vi.fn().mockResolvedValue([]);
        const importZipCall = vi.fn().mockResolvedValue([]);

        Reflect.set(controller, '_getUseImportSession', vi.fn(() => true));
        Reflect.set(controller, '_getDictionaryWorker', vi.fn(() => dictionaryWorker));
        Reflect.set(controller, '_importDictionaryFromMdx', importMdxCall);
        Reflect.set(controller, '_importDictionaryFromZip', importZipCall);

        const sources = [
            {type: 'mdx', mdxFile: createFile('Alpha.mdx'), mddFiles: [createFile('Alpha.mdd')]},
            {type: 'zip', file: createFile('Beta.zip')},
        ];
        const tracker = new ImportProgressTracker(getFileImportSteps(), sources.length);

        await importDictionaries.call(
            controller,
            arrayToAsyncGenerator.call(controller, sources),
            null,
            null,
            tracker,
            [],
        );

        expect(importMdxCall).toHaveBeenCalledTimes(1);
        expect(importZipCall).toHaveBeenCalledTimes(1);
        expect(importMdxCall.mock.calls[0]?.[4]).toBe(true);
        expect(importMdxCall.mock.calls[0]?.[5]).toBe(false);
        expect(importZipCall.mock.calls[0]?.[4]).toBe(true);
        expect(importZipCall.mock.calls[0]?.[5]).toBe(true);
        expect(importMdxCall.mock.calls[0]?.[2]).toMatchObject({
            prefixWildcardsSupported: true,
            yomitanVersion: '1.2.3.4',
            enableTermEntryContentDedup: true,
            termContentStorageMode: 'baseline',
        });
        expect(setDictionaryImportMode.mock.calls).toStrictEqual([[true], [false]]);
        expect(releaseDictionaryWorker).toHaveBeenCalledWith(dictionaryWorker, true);
        expect(showErrors).toHaveBeenLastCalledWith([]);
        expect(triggerStorageChanged).toHaveBeenCalledTimes(1);
    });

    test('imports MDX sources through the direct worker path with upload progress and session flags', async () => {
        const controller = createControllerForInternalTests();
        const importDictionaryWithWorkerInvocation = vi.fn(async (...args) => {
            const invokeWorkerImport = /** @type {() => Promise<unknown>} */ (args[7]);
            await invokeWorkerImport();
            return [];
        });
        Reflect.set(controller, '_importDictionaryWithWorkerInvocation', importDictionaryWithWorkerInvocation);

        /** @type {{type: 'mdx', mdxFile: File, mddFiles: File[]}} */
        const source = {type: 'mdx', mdxFile: createFile('Alpha.mdx'), mddFiles: [createFile('Alpha.mdd'), createFile('Alpha.1.mdd')]};
        const importDetails = /** @type {import('dictionary-importer').ImportDetails} */ (/** @type {unknown} */ ({
            prefixWildcardsSupported: true,
            yomitanVersion: '1.2.3.4',
        }));
        const onProgress = vi.fn();
        const dictionaryWorker = {
            importMdxDictionary: vi.fn().mockResolvedValue({
                result: null,
                errors: [],
                debug: {importerDebug: {phaseTimings: []}},
            }),
        };

        await importDictionaryFromMdx.call(controller, source, null, importDetails, dictionaryWorker, true, false, onProgress);

        expect(onProgress.mock.calls.map(([value]) => value)).toContainEqual({nextStep: true, index: 0, count: 0});
        expect(onProgress.mock.calls.map(([value]) => value)).toContainEqual({nextStep: false, index: 150, count: 1000});
        expect(onProgress.mock.calls.map(([value]) => value)).toContainEqual({nextStep: false, index: 300, count: 1000});
        expect(onProgress.mock.calls.map(([value]) => value)).toContainEqual({nextStep: false, index: 450, count: 1000});
        expect(importDictionaryWithWorkerInvocation).toHaveBeenCalledWith(
            'Alpha.mdx',
            null,
            true,
            false,
            expect.any(Number),
            expect.any(Array),
            expect.any(Function),
            expect.any(Function),
        );
        expect(dictionaryWorker.importMdxDictionary).toHaveBeenCalledTimes(1);
        const [mdxFileName, mdxBytes, mddFiles, workerImportDetails, workerOnProgress, options] = dictionaryWorker.importMdxDictionary.mock.calls[0];
        expect(mdxFileName).toBe('Alpha.mdx');
        expect(new Uint8Array(/** @type {ArrayBuffer} */ (mdxBytes))).toStrictEqual(new TextEncoder().encode('test'));
        expect(mddFiles).toHaveLength(2);
        expect(mddFiles.map((/** @type {{name: string}} */ value) => value.name)).toStrictEqual(['Alpha.mdd', 'Alpha.1.mdd']);
        expect(workerImportDetails).toStrictEqual({
            prefixWildcardsSupported: true,
            yomitanVersion: '1.2.3.4',
            useImportSession: true,
            finalizeImportSession: false,
        });
        expect(workerOnProgress).toBe(onProgress);
        expect(options).toStrictEqual({enableAudio: false});
    });

    test('defers database-updated notifications until the import session is finalized', async () => {
        const controller = createControllerForInternalTests();
        const {showErrors, triggerDatabaseUpdated} = setupControllerImportHarness(controller);
        const addDictionarySettings = vi.fn().mockResolvedValue([]);
        const importWarning = new Error('Minor glossary warning');
        const dictionaryWorker = {
            importDictionary: vi.fn().mockResolvedValue({
                result: {title: 'Alpha Dictionary'},
                errors: [importWarning],
                debug: {
                    useImportSession: true,
                    finalizeImportSession: false,
                    importerDebug: {phaseTimings: []},
                },
            }),
        };

        Reflect.set(controller, '_addDictionarySettings', addDictionarySettings);

        const result = await importDictionaryArchiveContent.call(
            controller,
            'Alpha Dictionary',
            new Uint8Array([5, 6, 7]).buffer,
            null,
            /** @type {import('dictionary-importer').ImportDetails} */ (/** @type {unknown} */ ({yomitanVersion: '1.2.3.4'})),
            dictionaryWorker,
            true,
            false,
            vi.fn(),
            0,
            [],
            () => {},
        );

        expect(result).toBeUndefined();
        expect(dictionaryWorker.importDictionary).toHaveBeenCalledTimes(1);
        const workerImportArgs = dictionaryWorker.importDictionary.mock.calls[0];
        expect(typeof workerImportArgs?.[0]).toBe('object');
        expect(workerImportArgs?.[0]).not.toBeNull();
        expect(Reflect.get(/** @type {object} */ (workerImportArgs?.[0]), 'byteLength')).toBe(3);
        expect(workerImportArgs?.[1]).toStrictEqual({
            yomitanVersion: '1.2.3.4',
            useImportSession: true,
            finalizeImportSession: false,
        });
        expect(typeof workerImportArgs?.[2]).toBe('function');
        expect(addDictionarySettings).toHaveBeenCalledWith({title: 'Alpha Dictionary'}, null);
        expect(triggerDatabaseUpdated).not.toHaveBeenCalled();
        expect(showErrors).toHaveBeenCalledTimes(1);
        const shownErrors = showErrors.mock.calls[0]?.[0];
        expect(Array.isArray(shownErrors)).toBe(true);
        expect(shownErrors?.[0]).toBe(importWarning);
        expect(shownErrors?.[1]).toBeInstanceOf(Error);
        expect(shownErrors?.[1]?.message).toBe('Dictionary may not have been imported properly: 1 error reported.');
    });

    test('surfaces direct MDX worker failures unchanged', async () => {
        const controller = createControllerForInternalTests();
        const conversionError = new Error('Unsupported MDX variant');
        Reflect.set(controller, '_importDictionaryWithWorkerInvocation', vi.fn(async (...args) => {
            const invokeWorkerImport = /** @type {() => Promise<unknown>} */ (args[7]);
            await invokeWorkerImport();
            return [];
        }));

        await expect(importDictionaryFromMdx.call(
            controller,
            {type: 'mdx', mdxFile: createFile('Broken.mdx'), mddFiles: []},
            null,
            /** @type {import('dictionary-importer').ImportDetails} */ (/** @type {unknown} */ ({yomitanVersion: '1.2.3.4'})),
            {importMdxDictionary: vi.fn().mockRejectedValue(conversionError)},
            true,
            true,
            vi.fn(),
        )).rejects.toThrow('Unsupported MDX variant');
    });

    test('closes the import modal and starts importing selected sources with initial errors', () => {
        const controller = createControllerForInternalTests();
        const sources = [{type: 'zip', file: createFile('Alpha.zip')}];
        const selectionError = new Error('Unsupported dictionary file: notes.txt');
        const setVisible = vi.fn();
        const dictionaries = arrayToAsyncGenerator.call(controller, sources);
        const arrayToAsyncGeneratorStub = vi.fn().mockReturnValue(dictionaries);
        const importDictionariesStub = vi.fn();

        Reflect.set(controller, '_importModal', {setVisible});
        Reflect.set(controller, '_arrayToAsyncGenerator', arrayToAsyncGeneratorStub);
        Reflect.set(controller, '_importDictionaries', importDictionariesStub);

        importSelectedSources.call(controller, sources, [selectionError]);

        expect(setVisible).toHaveBeenCalledWith(false);
        expect(arrayToAsyncGeneratorStub).toHaveBeenCalledWith(sources);
        expect(importDictionariesStub).toHaveBeenCalledWith(
            dictionaries,
            null,
            null,
            expect.any(ImportProgressTracker),
            [selectionError],
        );
    });

    test('starts drag-and-drop imports immediately instead of staging them', async () => {
        const controller = createControllerForInternalTests();
        const importSelectedSourcesStub = vi.fn();
        const dropZone = window.document.createElement('div');
        dropZone.classList.add('drag-over');
        const file = createFile('Alpha.zip');

        Reflect.set(controller, '_importFileDrop', dropZone);
        Reflect.set(controller, '_getAllFileEntries', vi.fn().mockResolvedValue([createFileEntry(file)]));
        Reflect.set(controller, '_createImportSourcesFromFiles', vi.fn(() => ({
            sources: [{type: 'zip', file}],
            errors: [],
            hasMdx: false,
        })));
        Reflect.set(controller, '_importSelectedSources', importSelectedSourcesStub);
        Reflect.set(controller, '_showErrors', vi.fn());

        await onFileDrop.call(
            controller,
            /** @type {DragEvent} */ (/** @type {unknown} */ ({
                preventDefault: vi.fn(),
                dataTransfer: {items: []},
            })),
        );

        expect(dropZone.classList.contains('drag-over')).toBe(false);
        expect(importSelectedSourcesStub).toHaveBeenCalledWith([{type: 'zip', file}], []);
    });

    test('starts one drag-and-drop import batch when multiple valid local dictionaries are dropped', async () => {
        const controller = createControllerForInternalTests();
        const importSelectedSourcesStub = vi.fn();
        const ensureMdxImportReady = vi.fn().mockResolvedValue(void 0);
        const dropZone = window.document.createElement('div');
        dropZone.classList.add('drag-over');
        const alphaFile = createFile('Alpha.mdx');
        const betaFile = createFile('Beta.mdx');
        const sources = [
            {type: 'mdx', mdxFile: alphaFile, mddFiles: []},
            {type: 'mdx', mdxFile: betaFile, mddFiles: []},
        ];

        Reflect.set(controller, '_importFileDrop', dropZone);
        Reflect.set(controller, '_getAllFileEntries', vi.fn().mockResolvedValue([
            createFileEntry(alphaFile),
            createFileEntry(betaFile),
        ]));
        Reflect.set(controller, '_createImportSourcesFromFiles', vi.fn(() => ({
            sources,
            errors: [],
            hasMdx: true,
        })));
        Reflect.set(controller, '_ensureMdxImportReady', ensureMdxImportReady);
        Reflect.set(controller, '_importSelectedSources', importSelectedSourcesStub);
        Reflect.set(controller, '_showErrors', vi.fn());

        await onFileDrop.call(
            controller,
            /** @type {DragEvent} */ (/** @type {unknown} */ ({
                preventDefault: vi.fn(),
                dataTransfer: {items: []},
            })),
        );

        expect(dropZone.classList.contains('drag-over')).toBe(false);
        expect(ensureMdxImportReady).toHaveBeenCalledOnce();
        expect(importSelectedSourcesStub).toHaveBeenCalledTimes(1);
        expect(importSelectedSourcesStub).toHaveBeenCalledWith(sources, []);
    });

    test('starts file input imports immediately instead of staging them', async () => {
        const controller = createControllerForInternalTests();
        const importSelectedSourcesStub = vi.fn();
        const showErrors = vi.fn();
        const input = document.createElement('input');
        const file = createFile('Alpha.zip');
        Object.defineProperty(input, 'files', {value: [file]});

        Reflect.set(controller, '_createImportSourcesFromFiles', vi.fn(() => ({
            sources: [{type: 'zip', file}],
            errors: [],
            hasMdx: false,
        })));
        Reflect.set(controller, '_importSelectedSources', importSelectedSourcesStub);
        Reflect.set(controller, '_showErrors', showErrors);

        await getDictionaryImportControllerMethod('_onImportFileChange').call(controller, {currentTarget: input});

        expect(importSelectedSourcesStub).toHaveBeenCalledWith([{type: 'zip', file}], []);
        expect(showErrors).not.toHaveBeenCalled();
    });

    test('stages URL sources instead of importing immediately', async () => {
        const controller = createControllerForInternalTests();
        const appendPendingImportSources = vi.fn();
        const showErrors = vi.fn();

        Reflect.set(controller, '_importURLText', {value: 'https://example.invalid/alpha.zip'});
        Reflect.set(controller, '_appendPendingImportSources', appendPendingImportSources);
        Reflect.set(controller, '_showErrors', showErrors);
        Reflect.set(controller, '_generateFilesFromUrls', async function *generateFilesFromUrls() {
            yield {type: 'zip', file: createFile('Alpha.zip')};
        });

        await getDictionaryImportControllerMethod('_onImportFromURL').call(controller);

        expect(appendPendingImportSources).toHaveBeenCalledWith([{type: 'zip', file: expect.any(File)}], []);
        expect(Reflect.get(controller, '_importURLText').value).toBe('');
        expect(showErrors).not.toHaveBeenCalled();
    });

    test('import confirm still imports staged pending sources', () => {
        const controller = createControllerForInternalTests();
        const stagedSources = [{type: 'zip', file: createFile('Alpha.zip')}];
        const importSelectedSourcesStub = vi.fn();

        Reflect.set(controller, '_pendingImportSources', stagedSources);
        Reflect.set(controller, '_importSelectedSources', importSelectedSourcesStub);

        onImportConfirm.call(controller);

        expect(importSelectedSourcesStub).toHaveBeenCalledWith(stagedSources);
    });

    test('renders one staged entry per pending source and enables import', () => {
        const controller = createControllerForInternalTests();
        const {window} = testEnv;
        const {sourceList, sourceEmpty, importConfirmButton, showErrors} = setupPendingImportDom(window.document);
        const template = window.document.createElement('template');
        template.innerHTML = `
            <div class="settings-item dictionary-import-source">
                <div class="settings-item-inner">
                    <div class="settings-item-left">
                        <div class="settings-item-label dictionary-import-source-title"></div>
                        <div class="settings-item-description dictionary-import-source-description"></div>
                    </div>
                </div>
            </div>
        `;

        Reflect.set(controller, '_settingsController', {
            instantiateTemplate: vi.fn(() => {
                const node = template.content.firstElementChild;
                if (!(node instanceof HTMLElement)) {
                    throw new Error('Expected template node');
                }
                return node.cloneNode(true);
            }),
        });
        Reflect.set(controller, '_importSourceList', sourceList);
        Reflect.set(controller, '_importSourceEmpty', sourceEmpty);
        Reflect.set(controller, '_importConfirmButton', importConfirmButton);
        Reflect.set(controller, '_pendingImportSources', []);
        Reflect.set(controller, '_hideErrors', vi.fn());
        Reflect.set(controller, '_showErrors', showErrors);

        getDictionaryImportControllerMethod('_appendPendingImportSources').call(controller, [
            {type: 'zip', file: createFile('Alpha.zip')},
            {type: 'mdx', mdxFile: createFile('Beta.mdx'), mddFiles: [createFile('Beta.mdd')]},
        ], []);

        expect(sourceList.querySelectorAll('.dictionary-import-source')).toHaveLength(2);
        expect(sourceEmpty.hidden).toBe(true);
        expect(importConfirmButton.disabled).toBe(false);
        expect(sourceList.textContent).toContain('Alpha.zip');
        expect(sourceList.textContent).toContain('Beta.mdx');
        expect(sourceList.querySelector('.dictionary-import-source-details')).toBeNull();
    });
});
