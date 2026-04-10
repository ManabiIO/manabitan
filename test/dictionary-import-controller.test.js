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

import {afterAll, describe, expect, test} from 'vitest';
import {DictionaryImportController, ImportProgressTracker} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();
afterAll(async () => {
    await testEnv.teardown(global);
});

/**
 * @param {Document} document
 * @returns {HTMLElement}
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
 * @param {string} name
 * @returns {Function}
 */
function getDictionaryImportControllerMethod(name) {
    const method = /** @type {unknown} */ (Reflect.get(DictionaryImportController.prototype, name));
    if (typeof method !== 'function') {
        throw new Error(`Expected DictionaryImportController.${name} to be a function`);
    }
    return method;
}

/**
 * @returns {import('dictionary-importer').ImportSteps}
 */
function getFileImportSteps() {
    const getFileImportStepsMethod = getDictionaryImportControllerMethod('_getFileImportSteps');
    return /** @type {import('dictionary-importer').ImportSteps} */ (getFileImportStepsMethod.call({}));
}

/**
 * @returns {import('dictionary-importer').ImportSteps}
 */
function getUrlImportSteps() {
    const getUrlImportStepsMethod = getDictionaryImportControllerMethod('_getUrlImportSteps');
    /** @type {Record<string, unknown>} */
    const context = {};
    Reflect.set(context, '_getFileImportSteps', () => getFileImportSteps());
    return /** @type {import('dictionary-importer').ImportSteps} */ (getUrlImportStepsMethod.call(context));
}

describe('Dictionary import progress steps', () => {
    const {window} = testEnv;

    test('File and URL import steps exclude validation phase', () => {
        const fileImportSteps = getFileImportSteps();
        expect(fileImportSteps.map(({label}) => label)).toStrictEqual([
            '',
            'Initializing import',
            'Loading dictionary',
            'Importing data',
            'Finalizing import',
        ]);

        const urlImportSteps = getUrlImportSteps();
        expect(urlImportSteps.map(({label}) => label)).toStrictEqual([
            '',
            'Initializing import',
            'Downloading dictionary',
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

        expect(infoLabel.textContent).toBe('Importing dictionary - Step 1 of 5: ...');

        tracker.onNextDictionary();
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 2 of 5: Initializing import...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 3 of 5: Loading dictionary...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 4 of 5: Importing data...');

        tracker.onProgress({nextStep: true, index: 0, count: 0});
        expect(infoLabel.textContent).toBe('Importing dictionary - Step 5 of 5: Finalizing import...');
    });
});
