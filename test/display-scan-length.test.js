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

import {afterAll, describe, expect, test, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';
import {setupDomTest} from './fixtures/dom-test.js';

const {teardown} = await setupDomTest('ext/search.html');

/**
 * @param {string} name
 * @returns {(this: unknown, ...args: unknown[]) => unknown}
 * @throws {Error}
 */
function getDisplayMethod(name) {
    const method = Reflect.get(Display.prototype, name);
    if (typeof method !== 'function') {
        throw new Error(`Expected ${name} method`);
    }
    return method;
}

/**
 * @param {number} scanLength
 * @returns {import('settings').ProfileOptions}
 */
function createProfileOptions(scanLength) {
    return /** @type {import('settings').ProfileOptions} */ ({
        general: {
            language: 'ja',
        },
        parsing: {
            selectedParser: null,
            termSpacing: true,
            readingMode: 'default',
            enableScanningParser: true,
            enableMecabParser: false,
        },
        scanning: {
            inputs: [],
            deepDomScan: false,
            normalizeCssZoom: true,
            selectText: false,
            delay: 10,
            length: scanLength,
            layoutAwareScan: false,
            preventMiddleMouse: {
                onSearchQuery: false,
                onTextHover: false,
            },
            preventBackForward: {
                onSearchQuery: false,
                onTextHover: false,
            },
            scanWithoutMousemove: false,
            scanResolution: 'sentence',
            enablePopupSearch: true,
            enableOnSearchPage: true,
        },
        sentenceParsing: {
            scanExtent: 200,
            terminationCharacterMode: 'newlines',
            terminationCharacters: [],
        },
    });
}

describe('Display scan length usage', () => {
    afterAll(async () => {
        await teardown(global);
    });

    test('query parser keeps using the stored scan length', () => {
        const options = createProfileOptions(31);
        const context = {
            _options: null,
            _updateHotkeys: vi.fn(),
            _updateDocumentOptions: vi.fn(),
            _setTheme: vi.fn(),
            _setStickyHeader: vi.fn(),
            _hotkeyHelpController: {setOptions: vi.fn(), setupNode: vi.fn()},
            _displayGenerator: {updateHotkeys: vi.fn(), updateLanguage: vi.fn()},
            _elementOverflowController: {setOptions: vi.fn()},
            _queryParser: {setOptions: vi.fn()},
            _updateNestedFrontend: vi.fn(),
            _updateContentTextScanner: vi.fn(),
            trigger: vi.fn(),
        };

        getDisplayMethod('_applyOptions').call(context, options);

        expect(context._queryParser.setOptions).toHaveBeenCalledWith(expect.objectContaining({
            scanning: expect.objectContaining({
                scanLength: 31,
            }),
        }));
        expect(context._updateContentTextScanner).toHaveBeenCalledWith(options);
    });

    test('embedded popup/search scanner keeps using the stored scan length', () => {
        const options = createProfileOptions(27);
        const contentTextScanner = {
            language: null,
            setOptions: vi.fn(),
            setEnabled: vi.fn(),
        };
        const context = {
            _pageType: 'search',
            _application: {api: {}},
            _textSourceGenerator: {},
            _getSearchContext: vi.fn(() => ({optionsContext: {depth: 0, url: 'https://example.test/'}, detail: {documentTitle: 'Example'}})),
            _contentTextScanner: contentTextScanner,
        };

        getDisplayMethod('_updateContentTextScanner').call(context, options);

        expect(contentTextScanner.language).toBe('ja');
        expect(contentTextScanner.setOptions).toHaveBeenCalledWith(expect.objectContaining({
            scanLength: 27,
        }));
        expect(contentTextScanner.setEnabled).toHaveBeenCalledWith(true);
    });
});
