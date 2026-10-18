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

import {getMdictMediaPathsFromComputedCss, getMdictMediaPathsFromCss, getMdictMediaUrlPathMap} from './dictionary-css-media-resolver.js';

const IMAGE_BEARING_PROPERTIES = [
    'background-image',
    'border-image-source',
    'list-style-image',
    'mask-image',
    '-webkit-mask-image',
    'content',
    'cursor',
    'filter',
    'clip-path',
    'shape-outside',
];

/**
 * Discover active resources without fetching bytes or mutating the display.
 * @param {HTMLElement} container
 * @param {Array<{name: string, enabled: boolean, styles?: string}>} dictionaries
 * @param {string} baseUrl
 * @returns {{targets: Array<{dictionary: string, path: string}>, inlineStyleElements: Array<{element: HTMLElement, dictionary: string}>}}
 */
export function collectDictionaryCssMediaTargets(container, dictionaries, baseUrl) {
    /** @type {Map<string, string>} */
    const dictionariesWithMediaStyles = new Map();
    for (const {name, enabled, styles = ''} of dictionaries) {
        if (enabled && styles.includes('mdict-media/')) { dictionariesWithMediaStyles.set(name, styles); }
    }
    /** @type {Map<string, Map<string, string[]>>} */
    const declaredMediaPaths = new Map();
    /** @type {Array<{element: HTMLElement, dictionary: string}>} */
    const inlineStyleElements = [];
    /** @type {Array<{dictionary: string, path: string}>} */
    const targets = [];
    const targetKeys = new Set();
    /**
     * @param {string} dictionary
     * @param {string} path
     */
    const addTarget = (dictionary, path) => {
        const key = JSON.stringify([dictionary, path]);
        if (targetKeys.has(key)) { return; }
        targetKeys.add(key);
        targets.push({dictionary, path});
    };
    for (const element of /** @type {NodeListOf<HTMLElement>} */ (container.querySelectorAll('[data-sc-tag], [data-sc-id], [data-sc-class], [style*="mdict-media/"]'))) {
        const dictionaryContainer = /** @type {HTMLElement|null} */ (element.closest('[data-dictionary]'));
        const dictionary = dictionaryContainer?.dataset.dictionary;
        if (typeof dictionary !== 'string' || dictionary.length === 0) { continue; }
        const inlineCss = element.style.cssText;
        if (inlineCss.includes('mdict-media/')) {
            inlineStyleElements.push({element, dictionary});
            for (const path of getMdictMediaPathsFromCss(inlineCss)) { addTarget(dictionary, path); }
        }
        if (!dictionariesWithMediaStyles.has(dictionary)) { continue; }
        for (const pseudoElement of [null, '::before', '::after']) {
            const style = getComputedStyle(element, pseudoElement);
            for (const property of IMAGE_BEARING_PROPERTIES) {
                const value = style.getPropertyValue(property);
                if (!value.includes('url(') || !value.includes('mdict-media/')) { continue; }
                let declaredPaths = declaredMediaPaths.get(dictionary);
                if (typeof declaredPaths === 'undefined') {
                    declaredPaths = getMdictMediaUrlPathMap(dictionariesWithMediaStyles.get(dictionary) ?? '', baseUrl);
                    declaredMediaPaths.set(dictionary, declaredPaths);
                }
                for (const path of getMdictMediaPathsFromComputedCss(value, baseUrl, declaredPaths)) { addTarget(dictionary, path); }
            }
        }
    }
    return {targets, inlineStyleElements};
}
