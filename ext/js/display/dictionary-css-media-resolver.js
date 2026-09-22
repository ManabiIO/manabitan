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

import {base64ToArrayBuffer} from '../data/array-buffer-util.js';

const MDICT_MEDIA_PREFIX = 'mdict-media/';

/**
 * @param {string} value
 * @param {number} startIndex
 * @returns {{value: string, endIndex: number}|null}
 */
function readCssEscape(value, startIndex) {
    let index = startIndex + 1;
    if (index >= value.length) { return null; }
    const character = value[index];
    if (/[\n\r\f]/u.test(character)) {
        return {value: '', endIndex: index + (character === '\r' && value[index + 1] === '\n' ? 2 : 1)};
    }
    const hex = /^[0-9a-f]{1,6}/iu.exec(value.slice(index));
    if (hex === null) { return {value: character, endIndex: index + 1}; }
    const codePoint = Number.parseInt(hex[0], 16);
    index += hex[0].length;
    if (/[\t\n\f\r ]/u.test(value[index] ?? '')) {
        index += value[index] === '\r' && value[index + 1] === '\n' ? 2 : 1;
    }
    return {
        value: String.fromCodePoint(
            codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff) ? 0xfffd : codePoint,
        ),
        endIndex: index,
    };
}

/**
 * @param {string} value
 * @param {number} startIndex
 * @returns {{path: string, endIndex: number}|null}
 */
function readCssUrl(value, startIndex) {
    let index = startIndex + 4;
    while (index < value.length && /[\t\n\f\r ]/u.test(value[index])) { index += 1; }
    const quote = value[index] === '"' || value[index] === "'" ? value[index++] : '';
    let path = '';
    while (index < value.length) {
        const character = value[index];
        if (quote.length > 0) {
            if (character === quote) {
                index += 1;
                while (index < value.length && /[\t\n\f\r ]/u.test(value[index])) { index += 1; }
                return value[index] === ')' ? {path, endIndex: index + 1} : null;
            }
            if (/[\n\r\f]/u.test(character)) { return null; }
        } else {
            if (character === ')') { return {path, endIndex: index + 1}; }
            if (/[\t\n\f\r ]/u.test(character)) {
                while (index < value.length && /[\t\n\f\r ]/u.test(value[index])) { index += 1; }
                return value[index] === ')' ? {path, endIndex: index + 1} : null;
            }
            const codePoint = character.charCodeAt(0);
            if (
                character === '"' || character === "'" || character === '(' ||
                codePoint <= 8 || codePoint === 11 || (codePoint >= 14 && codePoint <= 31) || codePoint === 127
            ) { return null; }
        }
        if (character === '\\') {
            if (quote.length === 0 && /[\n\r\f]/u.test(value[index + 1] ?? '')) { return null; }
            const escape = readCssEscape(value, index);
            if (escape === null) { return null; }
            path += escape.value;
            index = escape.endIndex;
        } else {
            path += character;
            index += 1;
        }
    }
    return null;
}

/**
 * Discover literal url() functions without rewriting quoted content, comments,
 * or identifier suffixes. Converted dictionary styles use this function spelling.
 * @param {string} css
 * @returns {Array<{path: string, startIndex: number, endIndex: number}>}
 */
function getCssUrlTokens(css) {
    const tokens = [];
    for (let index = 0; index < css.length;) {
        if (css.startsWith('/*', index)) {
            const end = css.indexOf('*/', index + 2);
            index = end < 0 ? css.length : end + 2;
            continue;
        }
        const character = css[index];
        if (character === '\\') {
            index = readCssEscape(css, index)?.endIndex ?? css.length;
            continue;
        }
        if (character === '"' || character === "'") {
            const quote = character;
            index += 1;
            while (index < css.length) {
                if (css[index] === '\\') {
                    index = readCssEscape(css, index)?.endIndex ?? css.length;
                } else if (css[index++] === quote) {
                    break;
                }
            }
            continue;
        }
        const previous = index > 0 ? css[index - 1] : '';
        if (
            css.slice(index, index + 4).toLowerCase() !== 'url(' ||
            /[A-Za-z0-9_-]/u.test(previous) || (previous.codePointAt(0) ?? 0) >= 0x80
        ) {
            index += 1;
            continue;
        }
        const token = readCssUrl(css, index);
        if (token !== null) {
            tokens.push({...token, startIndex: index});
            index = token.endIndex;
            continue;
        }
        // Do not discover another function inside a malformed URL token.
        index += 4;
        while (index < css.length) {
            if (css[index] === '\\') {
                index = readCssEscape(css, index)?.endIndex ?? css.length;
            } else if (css[index++] === ')') {
                break;
            }
        }
    }
    return tokens;
}

/**
 * @param {string} css
 * @returns {string[]}
 */
export function getMdictMediaPathsFromCss(css) {
    return getCssUrlTokens(css).map(({path}) => path).filter((path) => path.startsWith(MDICT_MEDIA_PREFIX));
}

/**
 * @param {string} value
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function getMdictMediaPathFromComputedUrl(value, baseUrl) {
    try {
        const url = new URL(value, baseUrl);
        const base = new URL(baseUrl);
        if (url.protocol !== base.protocol || url.host !== base.host) { return null; }
        const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        return path.startsWith(MDICT_MEDIA_PREFIX) ? path : null;
    } catch (_error) {
        return null;
    }
}

/**
 * @param {string} css
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function getMdictMediaPathsFromComputedCss(css, baseUrl) {
    const result = [];
    for (const {path: value} of getCssUrlTokens(css)) {
        const path = getMdictMediaPathFromComputedUrl(value, baseUrl);
        if (path !== null) { result.push(path); }
    }
    return result;
}

/**
 * @param {string} dictionary
 * @param {string} path
 * @returns {string}
 */
function getCacheKey(dictionary, path) {
    return JSON.stringify([dictionary, path]);
}

/**
 * Resolves dictionary-owned media referenced by imported CSS to blob URLs.
 * The resolver deliberately fetches only targets discovered from rendered
 * content; it does not preload every image in an MDD.
 */
export class DictionaryCssMediaResolver {
    /**
     * @param {{getMedia: (targets: Array<{dictionary: string, path: string}>) => Promise<Array<{dictionary: string, path: string, mediaType: string, content: string}>>}} api
     * @param {{createObjectURL?: typeof URL.createObjectURL, revokeObjectURL?: typeof URL.revokeObjectURL}} [urlApi]
     */
    constructor(api, urlApi = {}) {
        /** @type {{getMedia: (targets: Array<{dictionary: string, path: string}>) => Promise<Array<{dictionary: string, path: string, mediaType: string, content: string}>>}} */
        this._api = api;
        /** @type {typeof URL.createObjectURL} */
        this._createObjectURL = urlApi.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
        /** @type {typeof URL.revokeObjectURL} */
        this._revokeObjectURL = urlApi.revokeObjectURL ?? ((url) => { URL.revokeObjectURL(url); });
        /** @type {Map<string, {dictionary: string, path: string, url: string}>} */
        this._cache = new Map();
        /** @type {number} */
        this._generation = 0;
        /** @type {Set<string>|null} */
        this._enabledDictionaries = null;
    }

    /** */
    clear() {
        this._generation += 1;
        for (const {url} of this._cache.values()) {
            this._revokeObjectURL(url);
        }
        this._cache.clear();
    }

    /**
     * Revoke cached objects belonging only to dictionaries which are no longer
     * enabled. A database refresh uses clear() because bytes can change while
     * retaining the same dictionary title and path.
     * @param {Array<{name: string, enabled: boolean, styles?: string}>} dictionaries
     */
    prune(dictionaries) {
        const enabled = new Set(
            dictionaries
                .filter(({enabled: value}) => value)
                .map(({name}) => name),
        );
        const previous = this._enabledDictionaries;
        if (previous === null || previous.size !== enabled.size || [...previous].some((name) => !enabled.has(name))) {
            // Revoke in-flight results even when no URL has reached the cache.
            // Disable/re-enable must not revive work admitted before disabling.
            this._generation += 1;
        }
        this._enabledDictionaries = enabled;
        for (const [key, value] of this._cache) {
            if (enabled.has(value.dictionary)) { continue; }
            this._revokeObjectURL(value.url);
            this._cache.delete(key);
        }
    }

    /**
     * @param {Array<{dictionary: string, path: string}>} targets
     * @returns {Promise<boolean>} Whether new blob URLs were created.
     */
    async resolve(targets) {
        const missing = [];
        const seen = new Set();
        for (const {dictionary, path} of targets) {
            if (!path.startsWith(MDICT_MEDIA_PREFIX)) { continue; }
            if (this._enabledDictionaries !== null && !this._enabledDictionaries.has(dictionary)) { continue; }
            const key = getCacheKey(dictionary, path);
            if (this._cache.has(key) || seen.has(key)) { continue; }
            seen.add(key);
            missing.push({dictionary, path});
        }
        if (missing.length === 0) { return false; }

        const generation = this._generation;
        const results = await this._api.getMedia(missing);
        if (generation !== this._generation) { return false; }

        let changed = false;
        for (const item of results) {
            const {dictionary, path, mediaType, content} = item;
            const key = getCacheKey(dictionary, path);
            if (!seen.has(key) || this._cache.has(key)) { continue; }
            const blob = new Blob([base64ToArrayBuffer(content)], {type: mediaType});
            const url = this._createObjectURL(blob);
            this._cache.set(key, {dictionary, path, url});
            changed = true;
        }
        return changed;
    }

    /**
     * @param {string} dictionary
     * @param {string} css
     * @returns {string}
     */
    rewriteStyles(dictionary, css) {
        const output = [];
        let lastIndex = 0;
        for (const {path, startIndex, endIndex} of getCssUrlTokens(css)) {
            if (!path.startsWith(MDICT_MEDIA_PREFIX)) { continue; }
            const cached = this._cache.get(getCacheKey(dictionary, path));
            if (typeof cached === 'undefined') { continue; }
            output.push(css.slice(lastIndex, startIndex), `url("${cached.url}")`);
            lastIndex = endIndex;
        }
        output.push(css.slice(lastIndex));
        return output.join('');
    }
}
