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

import {describe, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';

/**
 * @param {string} name
 * @returns {(this: unknown, ...args: unknown[]) => unknown}
 * @throws {Error}
 */
function getFrontendMethod(name) {
    const method = Reflect.get(Frontend.prototype, name);
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
        inputs: {
            hotkeys: [],
        },
        dictionaries: [
            {name: 'Enabled', enabled: true},
            {name: 'Disabled', enabled: false},
        ],
        scanning: {
            inputs: [],
            deepDomScan: false,
            normalizeCssZoom: true,
            selectText: false,
            delay: 20,
            length: scanLength,
            layoutAwareScan: false,
            preventMiddleMouse: {
                onWebPages: false,
                onSearchQuery: false,
                onPopupExpressions: false,
                onPopupHorizontalText: false,
                onSearchPage: false,
                onSearchPageTextField: false,
                onTextHover: false,
            },
            preventBackForward: {
                onWebPages: false,
                onSearchQuery: false,
                onPopupExpressions: false,
                onPopupHorizontalText: false,
                onSearchPage: false,
                onSearchPageTextField: false,
                onTextHover: false,
            },
            scanWithoutMousemove: false,
            scanResolution: 'sentence',
            enableOnPopupExpressions: false,
        },
        sentenceParsing: {
            scanExtent: 200,
            terminationCharacterMode: 'newlines',
            terminationCharacters: [],
        },
    });
}

describe('Frontend hover scan length', () => {
    test('web hover uses the hover-effective scan length without mutating stored options', async () => {
        const optionsContext = {depth: 0, url: 'https://example.test/'};
        const options = createProfileOptions(24);
        const api = {
            optionsGet: vi.fn(async () => options),
            getEffectiveHoverScanLength: vi.fn(async () => 12),
        };
        const textScanner = {
            language: null,
            setOptions: vi.fn(),
            searchLast: vi.fn(async () => {}),
        };
        const context = {
            _pageType: 'web',
            _application: {api},
            _options: null,
            _hotkeyHandler: {setHotkeys: vi.fn()},
            _textScanner: textScanner,
            _getOptionsContext: vi.fn(async () => optionsContext),
            _updatePopup: vi.fn(async () => {}),
            _getPreventSecondaryMouseValueForPageType: vi.fn(() => false),
            _updateTextScannerEnabled: vi.fn(),
            _updateContentScale: vi.fn(),
        };

        await getFrontendMethod('_updateOptionsInternal').call(context);

        expect(api.optionsGet).toHaveBeenCalledWith(optionsContext);
        expect(api.getEffectiveHoverScanLength).toHaveBeenCalledWith(optionsContext);
        expect(context._options).toBe(options);
        expect(options.scanning.length).toBe(24);
        expect(textScanner.language).toBe('ja');
        expect(textScanner.setOptions).toHaveBeenCalledWith(expect.objectContaining({
            scanLength: 12,
            hoverScanLengthDiagnostics: {
                configuredScanLength: 24,
                automaticScanLength: 12,
                effectiveScanLength: 12,
            },
        }));
    });

    test('non-hover pages keep the stored scan length and skip hover-effective lookup', async () => {
        const optionsContext = {depth: 0, url: 'https://example.test/'};
        const options = createProfileOptions(18);
        const api = {
            optionsGet: vi.fn(async () => options),
            getEffectiveHoverScanLength: vi.fn(async () => 9),
        };
        const textScanner = {
            language: null,
            excludeSelector: null,
            touchEventExcludeSelector: null,
            setOptions: vi.fn(),
            searchLast: vi.fn(async () => {}),
        };
        const context = {
            _pageType: 'popup',
            _application: {api},
            _options: null,
            _hotkeyHandler: {setHotkeys: vi.fn()},
            _textScanner: textScanner,
            _getOptionsContext: vi.fn(async () => optionsContext),
            _updatePopup: vi.fn(async () => {}),
            _getPreventSecondaryMouseValueForPageType: vi.fn(() => false),
            _updateTextScannerEnabled: vi.fn(),
            _updateContentScale: vi.fn(),
        };

        await getFrontendMethod('_updateOptionsInternal').call(context);

        expect(api.getEffectiveHoverScanLength).not.toHaveBeenCalled();
        expect(textScanner.setOptions).toHaveBeenCalledWith(expect.objectContaining({
            scanLength: 18,
            hoverScanLengthDiagnostics: null,
        }));
        expect(textScanner.excludeSelector).toContain('.scan-disable');
        expect(textScanner.touchEventExcludeSelector).toContain('.gloss-link');
    });
});
