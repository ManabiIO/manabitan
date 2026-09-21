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
const CSS_URL_PATTERN = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)"'][^)]*?))\s*\)/giu;

/**
 * @param {string} value
 * @returns {string}
 */
function decodeCssString(value) {
    let result = '';
    for (let index = 0; index < value.length;) {
        const character = value[index];
        if (character !== '\\') {
            result += character;
            index += character.length;
            continue;
        }
        index += 1;
        if (index >= value.length) { break; }
        const next = value[index];
        if (next === '\n' || next === '\r' || next === '\f') {
            if (next === '\r' && value[index + 1] === '\n') { index += 1; }
            index += 1;
            continue;
        }
        const hexMatch = /^[0-9a-f]{1,6}/iu.exec(value.slice(index));
        if (hexMatch !== null) {
            const codePoint = Number.parseInt(hexMatch[0], 16);
            result += String.fromCodePoint(
                codePoint === 0 || codePoint > 0x10ffff ? 0xfffd : codePoint,
            );
            index += hexMatch[0].length;
            if (/\s/u.test(value[index] ?? '')) { index += 1; }
            continue;
        }
        result += next;
        index += next.length;
    }
    return result;
}

/**
 * @param {string} css
 * @returns {string[]}
 */
export function getMdictMediaPathsFromCss(css) {
    const result = [];
    CSS_URL_PATTERN.lastIndex = 0;
    for (const match of css.matchAll(CSS_URL_PATTERN)) {
        const raw = match[1] ?? match[2] ?? match[3] ?? '';
        const path = decodeCssString(raw.trim());
        if (path.startsWith(MDICT_MEDIA_PREFIX)) {
            result.push(path);
        }
    }
    return result;
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
 * @param {string} dictionary
 * @param {string} path
 * @returns {string}
 */
function getCacheKey(dictionary, path) {
    return `${dictionary}\u001f${path}`;
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
        this._api = api;
        this._createObjectURL = urlApi.createObjectURL ?? URL.createObjectURL.bind(URL);
        this._revokeObjectURL = urlApi.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
        /** @type {Map<string, {dictionary: string, path: string, url: string}>} */
        this._cache = new Map();
        this._generation = 0;
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
     * @param {Array<{name: string, enabled: boolean}>} dictionaries
     */
    prune(dictionaries) {
        const enabled = new Set(
            dictionaries
                .filter(({enabled: value}) => value)
                .map(({name}) => name),
        );
        let changed = false;
        for (const [key, value] of this._cache) {
            if (enabled.has(value.dictionary)) { continue; }
            this._revokeObjectURL(value.url);
            this._cache.delete(key);
            changed = true;
        }
        if (changed) { this._generation += 1; }
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
        CSS_URL_PATTERN.lastIndex = 0;
        return css.replace(CSS_URL_PATTERN, (match, doubleQuoted, singleQuoted, unquoted) => {
            const raw = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
            const path = decodeCssString(String(raw).trim());
            if (!path.startsWith(MDICT_MEDIA_PREFIX)) { return match; }
            const cached = this._cache.get(getCacheKey(dictionary, path));
            return typeof cached === 'undefined' ? match : `url("${cached.url}")`;
        });
    }
}
