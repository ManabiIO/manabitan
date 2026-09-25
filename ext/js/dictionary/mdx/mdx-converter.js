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

import {
    BlobWriter as BlobWriter0,
    Uint8ArrayReader as Uint8ArrayReader0,
    ZipWriter as ZipWriter0,
} from '../../../lib/zip.js';
import * as parse5 from '../../../lib/parse5.js';
import {base64ToArrayBuffer} from '../../data/array-buffer-util.js';
import {MDX} from './vendor/js-mdict/mdx.js';
import {MDD} from './vendor/js-mdict/mdd.js';
import mdictCommon from './vendor/js-mdict/utils.js';

const BlobWriter = /** @type {typeof import('@zip.js/zip.js').BlobWriter} */ (/** @type {unknown} */ (BlobWriter0));
const Uint8ArrayReader = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayReader} */ (/** @type {unknown} */ (Uint8ArrayReader0));
const ZipWriter = /** @type {typeof import('@zip.js/zip.js').ZipWriter} */ (/** @type {unknown} */ (ZipWriter0));

/**
 * @typedef {{keyText: string}} MdictKeyword
 */

/**
 * @typedef {{definition?: string|null}} MdictDefinitionResult
 */

/**
 * @typedef {{Title?: string, Description?: string, Format?: string, StyleSheet?: Record<string, string[]>, KeyCaseSensitive?: string, StripKey?: string}} MdictHeader
 */

/**
 * @typedef {object} MdxDictionaryLike
 * @property {MdictHeader} header
 * @property {MdictKeyword[]} keywordList
 * @property {(item: MdictKeyword) => MdictDefinitionResult} fetch_definition
 * @property {() => void} close
 */

/**
 * @typedef {object} MddDictionaryLike
 * @property {MdictKeyword[]} keywordList
 * @property {(item: MdictKeyword) => Uint8Array|null} lookupRecordByKeyBlock
 * @property {() => void} close
 */

/**
 * @typedef {Record<string, string|string[]>} StructuredStyle
 */

/**
 * @typedef {{attrs?: Array<{name: string, value: string}>, childNodes?: unknown[], tagName: string}} Parse5ElementNode
 */

/**
 * @typedef {{childNodes?: unknown[]}} Parse5ParentNode
 */

/**
 * @typedef {{value: string}} Parse5TextNode
 */

const MDX_GLOSSARY_ROOT_CLASS = 'mdict-yomitan-content';
const MDX_GLOSSARY_ENTRY_CLASS_PREFIX = 'mdict-yomitan-entry-';
// Conversion walks every definition, so cache decompressed MDX record blocks.
// MDD resource lookup remains lazy and uncached.
const MDX_IMPORT_RECORD_BLOCK_CACHE_BYTES = 8 * 1024 * 1024;
const STRUCTURED_CLASS_ATTR = 'data-sc-class';
const STRUCTURED_ID_ATTR = 'data-sc-id';
const STRUCTURED_TAG_ATTR = 'data-sc-tag';
const STRUCTURED_ROOT_SELECTOR = `[${STRUCTURED_CLASS_ATTR}~="${MDX_GLOSSARY_ROOT_CLASS}"]`;
const SUPPORTED_STRUCTURED_TAGS = new Set([
    'a',
    'br',
    'details',
    'div',
    'img',
    'li',
    'ol',
    'rp',
    'rt',
    'ruby',
    'span',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
]);
const HTML_TAG_MAP = new Map([
    ['b', 'span'],
    ['blockquote', 'div'],
    ['center', 'div'],
    ['cite', 'span'],
    ['code', 'span'],
    ['del', 'span'],
    ['em', 'span'],
    ['font', 'span'],
    ['h1', 'div'],
    ['h2', 'div'],
    ['h3', 'div'],
    ['h4', 'div'],
    ['h5', 'div'],
    ['h6', 'div'],
    ['i', 'span'],
    ['ins', 'span'],
    ['kbd', 'span'],
    ['mark', 'span'],
    ['p', 'div'],
    ['pre', 'div'],
    ['s', 'span'],
    ['samp', 'span'],
    ['small', 'span'],
    ['strike', 'span'],
    ['strong', 'span'],
    ['sub', 'span'],
    ['sup', 'span'],
    ['tt', 'span'],
    ['u', 'span'],
    ['var', 'span'],
]);
/** @type {Array<[string, StructuredStyle]>} */
const HTML_TAG_DEFAULT_STYLE_ENTRIES = [
    ['b', {fontWeight: 'bold'}],
    ['blockquote', {marginLeft: '1em'}],
    ['center', {textAlign: 'center'}],
    ['code', {fontFamily: 'monospace'}],
    ['del', {textDecorationLine: 'line-through'}],
    ['em', {fontStyle: 'italic'}],
    ['h1', {fontWeight: 'bold', fontSize: '2em'}],
    ['h2', {fontWeight: 'bold', fontSize: '1.5em'}],
    ['h3', {fontWeight: 'bold', fontSize: '1.17em'}],
    ['h4', {fontWeight: 'bold'}],
    ['h5', {fontWeight: 'bold'}],
    ['h6', {fontWeight: 'bold'}],
    ['i', {fontStyle: 'italic'}],
    ['ins', {textDecorationLine: 'underline'}],
    ['kbd', {fontFamily: 'monospace'}],
    ['mark', {backgroundColor: 'yellow'}],
    ['pre', {whiteSpace: 'pre-wrap'}],
    ['s', {textDecorationLine: 'line-through'}],
    ['samp', {fontFamily: 'monospace'}],
    ['small', {fontSize: '0.875em'}],
    ['strike', {textDecorationLine: 'line-through'}],
    ['strong', {fontWeight: 'bold'}],
    ['sub', {verticalAlign: 'sub'}],
    ['sup', {verticalAlign: 'super'}],
    ['tt', {fontFamily: 'monospace'}],
    ['u', {textDecorationLine: 'underline'}],
    ['var', {fontStyle: 'italic'}],
];
const HTML_TAG_DEFAULT_STYLES = new Map(HTML_TAG_DEFAULT_STYLE_ENTRIES);
const INLINE_STYLE_PROPERTY_MAP = new Map([
    ['background', 'background'],
    ['background-image', 'background'],
    ['background-color', 'backgroundColor'],
    ['border-color', 'borderColor'],
    ['border-style', 'borderStyle'],
    ['border-radius', 'borderRadius'],
    ['border-width', 'borderWidth'],
    ['clip-path', 'clipPath'],
    ['color', 'color'],
    ['cursor', 'cursor'],
    ['font-family', 'fontFamily'],
    ['font-size', 'fontSize'],
    ['font-style', 'fontStyle'],
    ['font-weight', 'fontWeight'],
    ['list-style-type', 'listStyleType'],
    ['margin', 'margin'],
    ['margin-top', 'marginTop'],
    ['margin-left', 'marginLeft'],
    ['margin-right', 'marginRight'],
    ['margin-bottom', 'marginBottom'],
    ['padding', 'padding'],
    ['padding-top', 'paddingTop'],
    ['padding-left', 'paddingLeft'],
    ['padding-right', 'paddingRight'],
    ['padding-bottom', 'paddingBottom'],
    ['text-align', 'textAlign'],
    ['text-decoration-color', 'textDecorationColor'],
    ['text-decoration-style', 'textDecorationStyle'],
    ['text-emphasis', 'textEmphasis'],
    ['text-shadow', 'textShadow'],
    ['vertical-align', 'verticalAlign'],
    ['white-space', 'whiteSpace'],
    ['word-break', 'wordBreak'],
]);
const EMBEDDED_ASSET_EXTENSION_MAP = new Map([
    ['audio/aac', '.aac'],
    ['audio/flac', '.flac'],
    ['audio/mp4', '.m4a'],
    ['audio/mpeg', '.mp3'],
    ['audio/ogg', '.ogg'],
    ['audio/wav', '.wav'],
    ['audio/webm', '.webm'],
    ['image/apng', '.apng'],
    ['image/avif', '.avif'],
    ['image/bmp', '.bmp'],
    ['image/gif', '.gif'],
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/svg+xml', '.svg'],
    ['image/tiff', '.tiff'],
    ['image/webp', '.webp'],
]);
const NULL_CHARACTER = String.fromCodePoint(0);
const SELECTOR_LIST_PSEUDO_CLASSES = new Set(['has', 'is', 'not', 'where']);

class EmbeddedAssetCollector {
    /**
     * @param {string} assetPrefix
     * @param {{value: number}} counter
     */
    constructor(assetPrefix, counter) {
        /** @type {string} */
        this._assetPrefix = assetPrefix;
        /** @type {Map<string, Uint8Array>} */
        this._assets = new Map();
        /** @type {{value: number}} */
        this._counter = counter;
    }

    /**
     * @returns {Map<string, Uint8Array>}
     */
    get assets() {
        return this._assets;
    }

    /**
     * @param {string} dataUrl
     * @returns {string|null}
     */
    registerDataUrl(dataUrl) {
        const decoded = decodeDataUrl(dataUrl);
        if (decoded === null) { return null; }
        const {mediaType, data} = decoded;
        const extension = EMBEDDED_ASSET_EXTENSION_MAP.get(mediaType.split(';', 1)[0].trim().toLowerCase()) ?? '.bin';
        const category = (mediaType.split('/', 1)[0] || 'asset').trim().toLowerCase();
        const path = `${this._assetPrefix}embedded/${category}/${String(++this._counter.value).padStart(6, '0')}${extension}`;
        this._assets.set(path, data);
        return path;
    }
}

class MddAssetResolver {
    /**
     * @param {Array<{name: string, bytes: Uint8Array}>} mddSources
     */
    constructor(mddSources) {
        /** @type {Array<MddDictionaryLike>} */
        this._dictionaries = [];
        /** @type {Map<string, {dictionaryIndex: number, item: MdictKeyword}>} */
        this._records = new Map();
        /** @type {Map<string, {dictionaryIndex: number, item: MdictKeyword}|null>} */
        this._recordsLowercase = new Map();
        /** @type {string[]} */
        this._cssKeys = [];
        /** @type {number} */
        this._lookupErrorCount = 0;

        try {
            for (const {name, bytes} of mddSources) {
                const dictionary = /** @type {MddDictionaryLike} */ (new MDD(name, bytes));
                const dictionaryIndex = this._dictionaries.length;
                this._dictionaries.push(dictionary);
                for (const item of dictionary.keywordList) {
                    const key = normalizeAssetKey(item.keyText);
                    if (key.length === 0 || this._records.has(key)) { continue; }
                    const record = {dictionaryIndex, item};
                    this._records.set(key, record);
                    const lowercaseKey = key.toLowerCase();
                    const lowercaseRecord = this._recordsLowercase.get(lowercaseKey);
                    if (typeof lowercaseRecord === 'undefined') {
                        this._recordsLowercase.set(lowercaseKey, record);
                    } else if (
                        lowercaseRecord !== null &&
                        normalizeAssetKey(lowercaseRecord.item.keyText) !== key
                    ) {
                        // An exact reference can still choose either record. A
                        // case-insensitive fallback cannot choose safely.
                        this._recordsLowercase.set(lowercaseKey, null);
                    }
                    if (key.toLowerCase().endsWith('.css')) {
                        this._cssKeys.push(key);
                    }
                }
            }
        } catch (error) {
            this.close();
            throw error;
        }
    }

    /**
     * @returns {number}
     */
    get recordCount() {
        return this._records.size;
    }

    /**
     * @returns {string[]}
     */
    get cssKeys() {
        return this._cssKeys;
    }

    /**
     * @returns {number}
     */
    get lookupErrorCount() {
        return this._lookupErrorCount;
    }

    /**
     * @param {string} key
     * @returns {Uint8Array|null}
     */
    getBytes(key) {
        let entry = this._records.get(key);
        if (typeof entry === 'undefined') {
            entry = this._recordsLowercase.get(key.toLowerCase()) ?? void 0;
        }
        if (typeof entry === 'undefined' || entry === null) { return null; }
        try {
            return this._dictionaries[entry.dictionaryIndex]?.lookupRecordByKeyBlock(entry.item) ?? null;
        } catch (_error) {
            this._lookupErrorCount += 1;
            return null;
        }
    }

    /** */
    close() {
        for (const dictionary of this._dictionaries) {
            dictionary.close();
        }
        this._dictionaries = [];
        this._records.clear();
        this._recordsLowercase.clear();
        this._cssKeys = [];
        this._lookupErrorCount = 0;
    }
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimNullSuffix(value) {
    return value.replace(new RegExp(`${NULL_CHARACTER}+$`, 'gu'), '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtmlText(value) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * @param {string} definition
 * @param {MdictHeader} header
 * @returns {string}
 */
function prepareDefinitionMarkup(definition, header) {
    const format = String(header.Format ?? '').trim().toLowerCase();
    if (format === 'text') {
        return `<pre>${escapeHtmlText(definition)}</pre>`;
    }
    const styleSheet = header.StyleSheet;
    if (typeof styleSheet === 'object' && styleSheet !== null && !Array.isArray(styleSheet)) {
        return mdictCommon.substituteStylesheet(styleSheet, definition);
    }
    return definition;
}

/**
 * @param {string} rawKey
 * @returns {string}
 */
function normalizeAssetKey(rawKey) {
    return rawKey.replaceAll('\\', '/').replace(/^\/+/u, '');
}

/**
 * @param {string} fileName
 * @returns {string}
 */
function getBaseName(fileName) {
    return fileName.replace(/\.[^.]+$/u, '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function encodeMediaPath(value) {
    return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/**
 * @param {string} query
 * @returns {string}
 */
function createSearchHref(query) {
    return `?query=${encodeURIComponent(query)}`;
}

/**
 * @param {string} path
 * @returns {string}
 */
function collapsePosixPath(path) {
    const parts = [];
    for (const part of path.replaceAll('\\', '/').split('/')) {
        if (part === '' || part === '.') { continue; }
        if (part === '..') {
            if (parts.length > 0) { parts.pop(); }
            continue;
        }
        parts.push(part);
    }
    return parts.join('/');
}

/**
 * @param {string} path
 * @returns {string}
 */
function decodePercentEncodedPathSegments(path) {
    const decodedParts = [];
    for (const part of path.split('/')) {
        try {
            decodedParts.push(decodeURIComponent(part));
        } catch (_error) {
            decodedParts.push(part);
        }
    }
    return decodedParts.join('/');
}

/**
 * @param {string} path
 * @param {string|null} sourceAssetPath
 * @param {string} assetPrefix
 * @returns {string|null}
 */
function normalizeRelativeAssetPath(path, sourceAssetPath = null, assetPrefix = '') {
    let value = trimCssWhitespace(path).replaceAll('\\', '/');
    if (value.length === 0) { return null; }
    const lowered = value.toLowerCase();
    if (
        lowered.startsWith('entry://') ||
        lowered.startsWith('bword://') ||
        lowered.startsWith('sound://') ||
        lowered.startsWith('http://') ||
        lowered.startsWith('https://') ||
        lowered.startsWith('data:') ||
        lowered.startsWith('javascript:') ||
        lowered.startsWith('vbscript:') ||
        lowered.startsWith('about:') ||
        lowered.startsWith('#') ||
        value.startsWith('//')
    ) {
        return null;
    }
    const fromRoot = value.startsWith('/') || lowered.startsWith('file://');
    const suffixIndex = value.search(/[?#]/u);
    if (suffixIndex >= 0) {
        value = value.slice(0, suffixIndex);
    }
    if (lowered.startsWith('file://')) {
        value = value.slice(7);
    }
    value = decodePercentEncodedPathSegments(value);
    value = value.replace(/^\/+/u, '');
    const alreadyPrefixed = assetPrefix.length > 0 && value.startsWith(assetPrefix);
    if (sourceAssetPath !== null && !fromRoot && !alreadyPrefixed) {
        const slash = sourceAssetPath.lastIndexOf('/');
        const sourceParent = slash < 0 ? '' : sourceAssetPath.slice(0, slash + 1);
        value = `${sourceParent}${value}`;
    }
    value = collapsePosixPath(value);
    return value.length > 0 ? value : null;
}

/**
 * @param {string} path
 * @param {string} assetPrefix
 * @param {string|null} sourceAssetPath
 * @returns {string|null}
 */
function normalizeReferencedAssetKey(path, assetPrefix, sourceAssetPath = null) {
    const normalizedPath = normalizeRelativeAssetPath(path, sourceAssetPath, assetPrefix);
    if (normalizedPath === null) { return null; }
    return normalizedPath.startsWith(assetPrefix) ? normalizedPath.slice(assetPrefix.length) : normalizedPath;
}

/**
 * @param {string} value
 * @returns {{mediaType: string, data: Uint8Array}|null}
 */
function decodeDataUrl(value) {
    if (!value.toLowerCase().startsWith('data:')) { return null; }
    const headerEnd = value.indexOf(',');
    if (headerEnd < 0) { return null; }
    const header = value.slice(5, headerEnd);
    const payload = value.slice(headerEnd + 1);
    const parts = header.split(';').map((part) => part.trim());
    const mediaType = (parts.shift() || 'text/plain').toLowerCase();
    const isBase64 = parts.some((part) => part.toLowerCase() === 'base64');
    try {
        if (isBase64) {
            return {mediaType, data: new Uint8Array(base64ToArrayBuffer(decodeURIComponent(payload)))};
        }
        // Percent escapes describe bytes, not necessarily valid UTF-8 text.
        const encoded = new TextEncoder().encode(payload);
        const data = new Uint8Array(encoded.length);
        let count = 0;
        for (let i = 0; i < encoded.length; i += 1) {
            if (encoded[i] === 0x25 && i + 2 < encoded.length) {
                const hex = String.fromCharCode(encoded[i + 1], encoded[i + 2]);
                if (/^[\da-f]{2}$/iu.test(hex)) {
                    data[count++] = Number.parseInt(hex, 16);
                    i += 2;
                    continue;
                }
            }
            data[count++] = encoded[i];
        }
        return {mediaType, data: data.subarray(0, count)};
    } catch (_error) {
        return null;
    }
}

/**
 * CSS syntax whitespace is ASCII-only. JavaScript \s and trim() also
 * consume NBSP and other non-ASCII characters that CSS permits in identifiers.
 * @param {string} character
 * @returns {boolean}
 */
function isCssWhitespace(character) {
    return (
        character === '\t' ||
        character === '\n' ||
        character === '\f' ||
        character === '\r' ||
        character === ' '
    );
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimCssWhitespace(value) {
    let start = 0;
    let end = value.length;
    while (start < end && isCssWhitespace(value[start])) { ++start; }
    while (end > start && isCssWhitespace(value[end - 1])) { --end; }
    return value.slice(start, end);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function getDeclaredStylesheetEncoding(bytes) {
    let prefix = '';
    const limit = Math.min(bytes.length, 128);
    for (let index = 0; index < limit; index += 1) {
        const byte = bytes[index];
        if (byte > 0x7f) { break; }
        prefix += String.fromCodePoint(byte);
        if (byte === 0x3b) { break; }
    }
    const match = /^@charset[\t\n\f\r ]+"([^"\r\n]+)"[\t\n\f\r ]*;/iu.exec(prefix);
    return match?.[1] ?? null;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function getBomStylesheetEncoding(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return 'utf-8';
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return 'utf-16le';
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return 'utf-16be';
    }
    return null;
}

/**
 * Recognize common BOM-less UTF-16 CSS by its ASCII NUL-byte pattern instead
 * of trying UTF-16 against arbitrary legacy single-byte encodings.
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function getLikelyUtf16StylesheetEncoding(bytes) {
    const pairCount = Math.min(Math.floor(bytes.length / 2), 32);
    if (pairCount < 2) { return null; }
    let evenZeros = 0;
    let oddZeros = 0;
    for (let index = 0; index < pairCount * 2; index += 2) {
        if (bytes[index] === 0) { evenZeros += 1; }
        if (bytes[index + 1] === 0) { oddZeros += 1; }
    }
    const threshold = Math.max(2, Math.ceil(pairCount / 3));
    if (oddZeros >= threshold && evenZeros === 0) { return 'utf-16le'; }
    if (evenZeros >= threshold && oddZeros === 0) { return 'utf-16be'; }
    return null;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} encoding
 * @returns {string|null}
 */
function decodeStylesheetWithEncoding(bytes, encoding) {
    try {
        const decoded = new TextDecoder(encoding, {fatal: true}).decode(bytes);
        const value = trimCssWhitespace(
            decoded.replace(/^\ufeff?@charset[\t\n\f\r ]+"[^"\r\n]+"[\t\n\f\r ]*;[\t\n\f\r ]*/iu, ''),
        );
        return value.length > 0 && !value.includes('\u0000') ? value : null;
    } catch (_error) {
        return null;
    }
}

/**
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function decodeStylesheetAsset(bytes) {
    const bomEncoding = getBomStylesheetEncoding(bytes);
    if (bomEncoding !== null) {
        return decodeStylesheetWithEncoding(bytes, bomEncoding);
    }

    const declaredEncoding = getDeclaredStylesheetEncoding(bytes);
    if (declaredEncoding !== null) {
        return decodeStylesheetWithEncoding(bytes, declaredEncoding);
    }

    const utf8 = decodeStylesheetWithEncoding(bytes, 'utf-8');
    if (utf8 !== null) { return utf8; }

    const utf16Encoding = getLikelyUtf16StylesheetEncoding(bytes);
    return utf16Encoding === null ? null : decodeStylesheetWithEncoding(bytes, utf16Encoding);
}

/**
 * Parse a CSS url() token without treating escaped closing parentheses as the
 * end of an unquoted value.
 * @param {string} value
 * @param {number} startIndex
 * @returns {{path: string, endIndex: number}|null}
 */
function readCssUrlFunction(value, startIndex) {
    if (value.slice(startIndex, startIndex + 4).toLowerCase() !== 'url(') { return null; }
    let index = startIndex + 4;
    while (index < value.length && isCssWhitespace(value[index])) { index += 1; }
    if (index >= value.length) { return null; }

    const quote = value[index] === '"' || value[index] === "'" ? value[index++] : '';
    let path = '';
    while (index < value.length) {
        const character = value[index];
        if (quote.length > 0) {
            if (character === quote) {
                index += 1;
                while (index < value.length && isCssWhitespace(value[index])) { index += 1; }
                return value[index] === ')' ? {path, endIndex: index + 1} : null;
            }
            if (/[\n\r\f]/u.test(character)) { return null; }
        } else {
            if (character === ')') { return {path, endIndex: index + 1}; }
            if (isCssWhitespace(character)) {
                while (index < value.length && isCssWhitespace(value[index])) { index += 1; }
                return value[index] === ')' ? {path, endIndex: index + 1} : null;
            }
            if (character === '"' || character === "'" || character === '(' || /[\n\r\f]/u.test(character)) {
                return null;
            }
        }
        if (character === '\\') {
            const escape = readCssEscape(value, index);
            if (escape === null) { return null; }
            path += escape.value;
            index = escape.endIndex;
            continue;
        }
        path += character;
        index += character.length;
    }
    return null;
}

/**
 * @param {string} stylesheet
 * @param {string} assetPrefix
 * @param {string|null} sourceAssetPath
 * @param {Set<string>|null} assetReferences
 * @returns {string}
 */
function rewriteCssAssetUrls(stylesheet, assetPrefix, sourceAssetPath, assetReferences = null) {
    const output = [];
    let lastIndex = 0;
    for (let index = 0; index < stylesheet.length;) {
        if (stylesheet.startsWith('/*', index)) {
            const commentEnd = stylesheet.indexOf('*/', index + 2);
            index = commentEnd < 0 ? stylesheet.length : commentEnd + 2;
            continue;
        }
        const character = stylesheet[index];
        if (character === '"' || character === "'") {
            const quote = character;
            index += 1;
            while (index < stylesheet.length) {
                if (stylesheet[index] === '\\') {
                    const escape = readCssEscape(stylesheet, index);
                    index = escape === null ? index + 1 : escape.endIndex;
                    continue;
                }
                if (stylesheet[index] === quote) {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        if (stylesheet.slice(index, index + 4).toLowerCase() !== 'url(') {
            index += 1;
            continue;
        }
        const previous = index > 0 ? stylesheet[index - 1] : '';
        const previousCodePoint = previous.codePointAt(0) ?? 0;
        if (/[A-Za-z0-9_-]/u.test(previous) || previousCodePoint >= 0x80) {
            index += 1;
            continue;
        }
        const token = readCssUrlFunction(stylesheet, index);
        if (token === null) {
            index += 1;
            continue;
        }
        const assetKey = normalizeReferencedAssetKey(token.path, assetPrefix, sourceAssetPath);
        if (assetKey !== null && assetReferences !== null) {
            assetReferences.add(assetKey);
        }
        if (assetKey !== null) {
            output.push(
                stylesheet.slice(lastIndex, index),
                `url("${escapeCssString(`${assetPrefix}${assetKey}`)}")`,
            );
            lastIndex = token.endIndex;
        }
        index = token.endIndex;
    }
    output.push(stylesheet.slice(lastIndex));
    return output.join('');
}

/**
 * @param {string} value
 * @param {number} startIndex
 * @returns {{value: string, endIndex: number}|null}
 */
function readCssEscape(value, startIndex) {
    if (value[startIndex] !== '\\' || startIndex + 1 >= value.length) { return null; }
    let endIndex = startIndex + 1;
    if (/[\n\r\f]/u.test(value[endIndex])) { return null; }

    const hexMatch = value.slice(endIndex).match(/^[\da-f]{1,6}/iu);
    if (hexMatch !== null) {
        endIndex += hexMatch[0].length;
        const codePoint = Number.parseInt(hexMatch[0], 16);
        const decoded = (
            codePoint === 0 ||
            codePoint > 0x10ffff ||
            (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) ?
            '\ufffd' :
            String.fromCodePoint(codePoint);
        if (endIndex < value.length) {
            if (value[endIndex] === '\r' && value[endIndex + 1] === '\n') {
                endIndex += 2;
            } else if (isCssWhitespace(value[endIndex])) {
                endIndex += 1;
            }
        }
        return {value: decoded, endIndex};
    }

    const decoded = value[endIndex];
    return {value: decoded, endIndex: endIndex + decoded.length};
}

/**
 * @param {string} selectorText
 * @returns {string[]}
 */
function splitCssSelectorList(selectorText) {
    const selectors = [];
    let partStart = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote = '';
    for (let index = 0; index < selectorText.length; index += 1) {
        const character = selectorText[index];
        if (quote.length > 0) {
            if (character === '\\') {
                index += 1;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }
        if (character === '\\') {
            const escape = readCssEscape(selectorText, index);
            if (escape !== null) {
                index = escape.endIndex - 1;
                continue;
            }
        }
        switch (character) {
            case '"':
            case "'": {
                quote = character;

                break;
            }
            case '(': {
                parenDepth += 1;

                break;
            }
            case ')': {
                parenDepth = Math.max(0, parenDepth - 1);

                break;
            }
            case '[': {
                bracketDepth += 1;

                break;
            }
            case ']': {
                bracketDepth = Math.max(0, bracketDepth - 1);

                break;
            }
            default: if (character === ',' && parenDepth === 0 && bracketDepth === 0) {
                selectors.push(selectorText.slice(partStart, index));
                partStart = index + 1;
            }
        }
    }
    selectors.push(selectorText.slice(partStart));
    return selectors;
}

/**
 * @param {string} selector
 * @returns {string[]}
 */
function splitSelectorByCombinators(selector) {
    const parts = [];
    let startIndex = 0;
    let quote = '';
    let parenDepth = 0;
    let bracketDepth = 0;
    for (let index = 0; index < selector.length; index += 1) {
        const character = selector[index];
        if (quote.length > 0) {
            if (character === '\\') {
                index += 1;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }
        if (character === '\\') {
            const escape = readCssEscape(selector, index);
            if (escape !== null) {
                index = escape.endIndex - 1;
                continue;
            }
        }
        switch (character) {
            case '"':
            case "'": {
                quote = character;

                break;
            }
            case '(': {
                parenDepth += 1;

                break;
            }
            case ')': {
                parenDepth = Math.max(0, parenDepth - 1);

                break;
            }
            case '[': {
                bracketDepth += 1;

                break;
            }
            case ']': {
                bracketDepth = Math.max(0, bracketDepth - 1);

                break;
            }
            default: if (parenDepth === 0 && bracketDepth === 0 && ['>', '+', '~'].includes(character)) {
                if (startIndex < index) { parts.push(selector.slice(startIndex, index)); }
                parts.push(character);
                startIndex = index + 1;
            } else if (parenDepth === 0 && bracketDepth === 0 && isCssWhitespace(character)) {
                if (startIndex < index) { parts.push(selector.slice(startIndex, index)); }
                const whitespaceStart = index;
                while (index + 1 < selector.length && isCssWhitespace(selector[index + 1])) { index += 1; }
                parts.push(selector.slice(whitespaceStart, index + 1));
                startIndex = index + 1;
            }
        }
    }
    if (startIndex < selector.length) { parts.push(selector.slice(startIndex)); }
    return parts;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeCssString(value) {
    let result = '';
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (character === '"' || character === '\\') {
            result += `\\${character}`;
        } else if (codePoint === 0 || codePoint <= 0x1f || codePoint === 0x7f) {
            result += `\\${codePoint.toString(16)} `;
        } else {
            result += character;
        }
    }
    return result;
}

/**
 * @param {string} selector
 * @param {number} startIndex
 * @returns {{value: string|null, endIndex: number}}
 */
function readCssIdentifier(selector, startIndex) {
    let index = startIndex;
    let value = '';
    let first = true;
    while (index < selector.length) {
        const character = selector[index];
        if (character === '\\') {
            const escape = readCssEscape(selector, index);
            if (escape === null) { break; }
            value += escape.value;
            index = escape.endIndex;
            first = false;
            continue;
        }
        const codePoint = character.codePointAt(0) ?? 0;
        const nonAscii = codePoint >= 0x80;
        const allowed = first ?
            character === '-' || character === '_' || /[A-Za-z]/u.test(character) || nonAscii :
            character === '-' || character === '_' || /[A-Za-z0-9]/u.test(character) || nonAscii;
        if (!allowed) { break; }
        value += character;
        index += character.length;
        first = false;
    }
    if (value.length === 0 || value === '-') {
        return {value: null, endIndex: startIndex};
    }
    return {value, endIndex: index};
}

/**
 * @param {string} attributeSelector
 * @returns {string}
 */
function rewriteCssAttributeSelector(attributeSelector) {
    if (!attributeSelector.startsWith('[') || !attributeSelector.endsWith(']')) {
        return attributeSelector;
    }
    let nameStart = 1;
    while (nameStart < attributeSelector.length && isCssWhitespace(attributeSelector[nameStart])) {
        nameStart += 1;
    }
    const {value: rawName, endIndex} = readCssIdentifier(attributeSelector, nameStart);
    if (
        rawName === null ||
        (attributeSelector[endIndex] === '|' && attributeSelector[endIndex + 1] !== '=')
    ) { return attributeSelector; }
    const name = rawName.toLowerCase();
    const replacement = name === 'class' ? STRUCTURED_CLASS_ATTR : (name === 'id' ? STRUCTURED_ID_ATTR : null);
    return replacement === null ? attributeSelector : `[${replacement}${attributeSelector.slice(endIndex)}`;
}

/**
 * @param {string} selector
 * @param {number} openParenIndex
 * @returns {{content: string, endIndex: number}|null}
 */
function readCssParenthesizedContent(selector, openParenIndex) {
    if (selector[openParenIndex] !== '(') { return null; }
    let quote = '';
    let depth = 1;
    for (let index = openParenIndex + 1; index < selector.length; index += 1) {
        const character = selector[index];
        if (quote.length > 0) {
            if (character === '\\') {
                const escape = readCssEscape(selector, index);
                index = escape === null ? index + 1 : escape.endIndex - 1;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }
        if (character === '\\') {
            const escape = readCssEscape(selector, index);
            if (escape !== null) {
                index = escape.endIndex - 1;
                continue;
            }
        }
        switch (character) {
            case '"':
            case "'": {
                quote = character;
                break;
            }
            case '(': {
                depth += 1;
                break;
            }
            case ')': {
                depth -= 1;
                if (depth === 0) {
                    return {
                        content: selector.slice(openParenIndex + 1, index),
                        endIndex: index + 1,
                    };
                }
                break;
            }
        }
    }
    return null;
}

/**
 * @param {string} selector
 * @param {string} glossaryRootSelector
 * @returns {string}
 */
function migrateCssSelectorSegment(selector, glossaryRootSelector) {
    if (selector.length === 0) { return selector; }
    const parts = [];
    let index = 0;
    let expectTagName = true;
    while (index < selector.length) {
        const character = selector[index];
        if (character === ':' && selector[index + 1] !== ':') {
            const pseudo = readCssIdentifier(selector, index + 1);
            if (pseudo.value !== null) {
                const pseudoName = pseudo.value.toLowerCase();
                if (pseudoName === 'root') {
                    parts.push(glossaryRootSelector);
                    index = pseudo.endIndex;
                    expectTagName = false;
                    continue;
                }
                if (SELECTOR_LIST_PSEUDO_CLASSES.has(pseudoName) && selector[pseudo.endIndex] === '(') {
                    const functionContent = readCssParenthesizedContent(selector, pseudo.endIndex);
                    if (functionContent !== null) {
                        const migratedContent = splitCssSelectorList(functionContent.content)
                            .map((item) => migrateCssSelector(item, glossaryRootSelector))
                            .join(', ');
                        parts.push(
                            selector.slice(index, pseudo.endIndex + 1),
                            migratedContent,
                            ')',
                        );
                        index = functionContent.endIndex;
                        expectTagName = false;
                        continue;
                    }
                }
            }
        }
        if (character === '.') {
            const {value, endIndex} = readCssIdentifier(selector, index + 1);
            if (value !== null) {
                parts.push(`[${STRUCTURED_CLASS_ATTR}~="${escapeCssString(value)}"]`);
                index = endIndex;
                expectTagName = false;
                continue;
            }
        }
        if (character === '#') {
            const {value, endIndex} = readCssIdentifier(selector, index + 1);
            if (value !== null) {
                parts.push(`[${STRUCTURED_ID_ATTR}="${escapeCssString(value)}"]`);
                index = endIndex;
                expectTagName = false;
                continue;
            }
        }
        if (character === '[') {
            let endIndex = index + 1;
            let quote = '';
            let bracketDepth = 1;
            while (endIndex < selector.length) {
                const inner = selector[endIndex];
                if (quote.length > 0) {
                    if (inner === '\\') {
                        endIndex += 2;
                        continue;
                    }
                    if (inner === quote) { quote = ''; }
                } else {
                    if (inner === '\\') {
                        endIndex += 2;
                        continue;
                    }
                    switch (inner) {
                        case '"':
                        case "'":
                            quote = inner;
                            break;
                        case '[':
                            bracketDepth += 1;
                            break;
                        case ']':
                            bracketDepth -= 1;
                            break;
                        default:
                            break;
                    }
                    if (bracketDepth === 0) {
                        endIndex += 1;
                        break;
                    }
                }
                endIndex += 1;
            }
            parts.push(rewriteCssAttributeSelector(selector.slice(index, endIndex)));
            index = endIndex;
            expectTagName = false;
            continue;
        }
        if (expectTagName) {
            if (character === '*') {
                parts.push(character);
                index += 1;
                expectTagName = false;
                continue;
            }
            const {value, endIndex} = readCssIdentifier(selector, index);
            if (value !== null) {
                const lower = value.toLowerCase();
                parts.push(['html', 'body'].includes(lower) ? glossaryRootSelector : `[${STRUCTURED_TAG_ATTR}="${lower}"]`);
                index = endIndex;
                expectTagName = false;
                continue;
            }
        }
        parts.push(character);
        if (!isCssWhitespace(character)) {
            expectTagName = false;
        }
        index += 1;
    }
    return parts.join('');
}

/**
 * @param {string} selector
 * @param {string} glossaryRootSelector
 * @returns {string}
 */
function migrateCssSelector(selector, glossaryRootSelector) {
    const migrated = splitSelectorByCombinators(trimCssWhitespace(selector)).map((part) => {
        if (trimCssWhitespace(part).length === 0 || ['>', '+', '~'].includes(part)) { return part; }
        return migrateCssSelectorSegment(part, glossaryRootSelector);
    }).join('');
    // Quoted attribute values and whitespace after CSS hex escapes are significant.
    return trimCssWhitespace(migrated);
}

/**
 * Constrain the matched element, not merely an ancestor, to this definition.
 * :where() adds no specificity. Guard the originating element before its
 * pseudo-element so ::before/::after and their legacy spellings stay valid.
 * @param {string} selector
 * @param {string} glossaryRootSelector
 * @returns {string}
 */
function scopeCssSelectorSubject(selector, glossaryRootSelector) {
    const parts = splitSelectorByCombinators(selector);
    let subjectIndex = parts.length - 1;
    while (subjectIndex >= 0) {
        const part = parts[subjectIndex];
        if (trimCssWhitespace(part).length > 0 && !['>', '+', '~'].includes(part)) { break; }
        subjectIndex -= 1;
    }
    if (subjectIndex < 0) { return selector; }
    const subject = parts[subjectIndex];
    let insertionIndex = subject.length;
    let quote = '';
    let bracketDepth = 0;
    let parenDepth = 0;
    for (let index = 0; index < subject.length; index += 1) {
        const character = subject[index];
        if (character === '\\') {
            const escape = readCssEscape(subject, index);
            if (escape !== null) { index = escape.endIndex - 1; }
            continue;
        }
        if (quote.length > 0) {
            if (character === quote) { quote = ''; }
            continue;
        }
        switch (character) {
            case '"':
            case "'": {
                quote = character;
                break;
            }
            case '[': {
                bracketDepth += 1;
                break;
            }
            case ']': {
                bracketDepth = Math.max(0, bracketDepth - 1);
                break;
            }
            case '(': {
                parenDepth += 1;
                break;
            }
            case ')': {
                parenDepth = Math.max(0, parenDepth - 1);
                break;
            }
            case ':': {
                if (bracketDepth > 0 || parenDepth > 0) { break; }
                const pseudo = readCssIdentifier(subject, index + 1);
                const legacy = pseudo.value !== null &&
                ['before', 'after', 'first-line', 'first-letter'].includes(pseudo.value.toLowerCase());
                if (subject[index + 1] === ':' || legacy) {
                    insertionIndex = index;
                }
                break;
            }
        }
        if (insertionIndex < subject.length) { break; }
    }
    const guard = `:where(${glossaryRootSelector}, ${glossaryRootSelector} *)`;
    parts[subjectIndex] = `${subject.slice(0, insertionIndex)}${guard}${subject.slice(insertionIndex)}`;
    return parts.join('');
}

/**
 * @param {string} stylesheet
 * @param {number} blockStartIndex
 * @returns {number}
 */
function findMatchingCssBrace(stylesheet, blockStartIndex) {
    let depth = 0;
    let quote = '';
    for (let index = blockStartIndex; index < stylesheet.length; index += 1) {
        const character = stylesheet[index];
        if (stylesheet.startsWith('/*', index) && quote.length === 0) {
            const commentEnd = stylesheet.indexOf('*/', index + 2);
            if (commentEnd < 0) {
                return stylesheet.length - 1;
            }
            index = commentEnd + 1;
            continue;
        }
        if (quote.length > 0) {
            if (character === '\\') {
                index += 1;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }
        switch (character) {
            case '\\':
                index += 1;
                break;
            case '"':
            case "'":
                quote = character;
                break;
            case '{':
                depth += 1;
                break;
            case '}':
                if (--depth === 0) { return index; }
                break;
        }
    }
    return stylesheet.length - 1;
}

/**
 * Rewrite selectors to match structured-content data attributes. Declaration
 * blocks are otherwise retained verbatim so CSS properties and at-rules stay intact.
 * @param {string} stylesheet
 * @param {string} glossaryRootSelector
 * @param {boolean} [scopeSelectors]
 * @returns {string}
 */
function rewriteCssRuleSelectors(stylesheet, glossaryRootSelector, scopeSelectors = false) {
    const output = [];
    let index = 0;
    while (index < stylesheet.length) {
        let preludeStart = index;
        while (preludeStart < stylesheet.length) {
            if (stylesheet.startsWith('/*', preludeStart)) {
                const commentEnd = stylesheet.indexOf('*/', preludeStart + 2);
                if (commentEnd < 0) {
                    output.push(stylesheet.slice(index));
                    return output.join('');
                }
                preludeStart = commentEnd + 2;
                continue;
            }
            if (isCssWhitespace(stylesheet[preludeStart])) {
                preludeStart += 1;
                continue;
            }
            break;
        }
        output.push(stylesheet.slice(index, preludeStart));
        if (preludeStart >= stylesheet.length) { break; }
        let cursor = preludeStart;
        let consumed = false;
        let quote = '';
        let parenDepth = 0;
        let bracketDepth = 0;
        while (cursor < stylesheet.length) {
            const character = stylesheet[cursor];
            if (stylesheet.startsWith('/*', cursor) && quote.length === 0) {
                const commentEnd = stylesheet.indexOf('*/', cursor + 2);
                if (commentEnd < 0) {
                    output.push(stylesheet.slice(preludeStart));
                    return output.join('');
                }
                cursor = commentEnd + 2;
                continue;
            }
            if (quote.length > 0) {
                if (character === '\\') {
                    cursor += 2;
                    continue;
                }
                if (character === quote) { quote = ''; }
                cursor += 1;
                continue;
            }
            if (character === '\\') {
                cursor += 2;
                continue;
            }
            // The delimiter cases below intentionally share cursor state.
            // eslint-disable-next-line unicorn/prefer-switch
            if (character === '"' || character === "'") {
                quote = character;
            } else if (character === '(') {
                parenDepth += 1;
            } else if (character === ')') {
                parenDepth = Math.max(0, parenDepth - 1);
            } else if (character === '[') {
                bracketDepth += 1;
            } else if (character === ']') {
                bracketDepth = Math.max(0, bracketDepth - 1);
            } else if (character === ';' && parenDepth === 0 && bracketDepth === 0) {
                output.push(stylesheet.slice(preludeStart, cursor + 1));
                index = cursor + 1;
                consumed = true;
                break;
            } else if (character === '{' && parenDepth === 0 && bracketDepth === 0) {
                const prelude = stylesheet.slice(preludeStart, cursor);
                const blockEnd = findMatchingCssBrace(stylesheet, cursor);
                let body = stylesheet.slice(cursor + 1, blockEnd);
                const stripped = trimCssWhitespace(prelude);
                if (stripped.startsWith('@')) {
                    const atRuleName = stripped.slice(1).split(/[\t\n\f\r (]/u, 1)[0].toLowerCase();
                    if (['media', 'supports', 'layer', 'container', 'document'].includes(atRuleName)) {
                        body = rewriteCssRuleSelectors(body, glossaryRootSelector, scopeSelectors);
                    }
                    output.push(`${prelude}{${body}}`);
                } else {
                    const migratedSelectors = [];
                    const seen = new Set();
                    for (const part of splitCssSelectorList(prelude)) {
                        let migrated = migrateCssSelector(part, glossaryRootSelector);
                        if (scopeSelectors && migrated.length > 0) {
                            migrated = scopeCssSelectorSubject(migrated, glossaryRootSelector);
                        }
                        if (migrated.length > 0 && !seen.has(migrated)) {
                            seen.add(migrated);
                            migratedSelectors.push(migrated);
                        }
                    }
                    output.push(`${migratedSelectors.join(', ')}{${body}}`);
                }
                index = blockEnd + 1;
                consumed = true;
                break;
            }
            cursor += 1;
        }
        if (!consumed) {
            output.push(stylesheet.slice(preludeStart));
            break;
        }
    }
    return output.join('');
}

/**
 * @param {string} stylesheet
 * @param {string} assetPrefix
 * @param {string|null} sourceAssetPath
 * @param {Set<string>|null} assetReferences
 * @param {string} [glossaryRootSelector]
 * @param {boolean} [scopeSelectors]
 * @returns {string}
 */
function migrateStylesheetForYomitan(stylesheet, assetPrefix, sourceAssetPath, assetReferences = null, glossaryRootSelector = STRUCTURED_ROOT_SELECTOR, scopeSelectors = false) {
    const rewritten = rewriteCssAssetUrls(stylesheet, assetPrefix, sourceAssetPath, assetReferences);
    return rewriteCssRuleSelectors(rewritten, glossaryRootSelector, scopeSelectors);
}

/**
 * @param {string} sourceName
 * @returns {string}
 */
function escapeStylesheetSourceComment(sourceName) {
    return sourceName.replaceAll('*/', '* /').replace(/[\r\n]+/gu, ' ');
}

/**
 * @param {Map<string, Uint8Array>} cssAssets
 * @param {string} assetPrefix
 * @param {Array<[string, string, string]>} inlineStylesheets
 * @param {Set<string>|null} assetReferences
 * @returns {string|null}
 */
function buildRootStylesheet(cssAssets, assetPrefix, inlineStylesheets, assetReferences = null) {
    /** @type {string[]} */
    const sections = [];
    for (const [archivePath, bytes] of [...cssAssets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        let stylesheet = decodeStylesheetAsset(bytes);
        if (stylesheet === null) { continue; }
        const sourceName = archivePath.startsWith(assetPrefix) ? archivePath.slice(assetPrefix.length) : archivePath;
        stylesheet = migrateStylesheetForYomitan(stylesheet, assetPrefix, sourceName, assetReferences);
        sections.push(`/* Source: ${escapeStylesheetSourceComment(sourceName)} */\n${stylesheet}`);
    }
    for (const [sourceName, stylesheet, scopeClass] of inlineStylesheets) {
        const scopeSelector = `[${STRUCTURED_CLASS_ATTR}~="${scopeClass}"]`;
        sections.push(`/* Source: ${escapeStylesheetSourceComment(sourceName)} */\n${migrateStylesheetForYomitan(stylesheet, assetPrefix, null, assetReferences, scopeSelector, true)}`);
    }
    return sections.length > 0 ? `${sections.join('\n\n')}\n` : null;
}

/**
 * @param {unknown} value
 * @returns {value is StructuredStyle}
 */
function isStructuredStyleRecord(value) {
    return typeof value === 'object' && value !== null;
}

/**
 * @param {Record<string, string>} attrs
 * @returns {Record<string, string>|null}
 */
function buildStructuredData(attrs) {
    /** @type {Record<string, string>} */
    const data = {};
    const className = typeof attrs.class === 'string' ?
        trimCssWhitespace(attrs.class).replace(/[\t\n\f\r ]+/gu, ' ') :
        '';
    if (className.length > 0) { data.class = className; }
    const id = typeof attrs.id === 'string' ? trimCssWhitespace(attrs.id) : '';
    if (id.length > 0) { data.id = id; }
    return Object.keys(data).length > 0 ? data : null;
}

/**
 * Split an inline declaration list without treating semicolons inside strings,
 * comments, or functions as declaration boundaries.
 * @param {string} styleText
 * @returns {string[]}
 */
function splitInlineCssDeclarations(styleText) {
    const declarations = [];
    let startIndex = 0;
    let quote = '';
    let parenDepth = 0;
    for (let index = 0; index < styleText.length; index += 1) {
        const character = styleText[index];
        if (styleText.startsWith('/*', index) && quote.length === 0) {
            const commentEnd = styleText.indexOf('*/', index + 2);
            if (commentEnd < 0) { break; }
            index = commentEnd + 1;
            continue;
        }
        if (quote.length > 0) {
            if (character === '\\') {
                index += 1;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }
        switch (character) {
            case '"':
            case "'": {
                quote = character;
                break;
            }
            case '(': {
                parenDepth += 1;
                break;
            }
            case ')': {
                parenDepth = Math.max(0, parenDepth - 1);
                break;
            }
            case ';': {
                if (parenDepth === 0) {
                    declarations.push(styleText.slice(startIndex, index));
                    startIndex = index + 1;
                }
                break;
            }
        }
    }
    declarations.push(styleText.slice(startIndex));
    return declarations;
}

/**
 * Remove CSS comments without treating comment markers inside quoted strings
 * as syntax. Closed comments retain the previous removal behavior; an
 * unterminated comment is left intact for the existing declaration handling.
 * @param {string} value
 * @returns {string}
 */
function stripCssCommentsOutsideStrings(value) {
    let result = '';
    let startIndex = 0;
    let quote = '';
    for (let index = 0; index < value.length; ++index) {
        const character = value[index];
        if (quote.length > 0) {
            if (character === '\\') {
                ++index;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (value.startsWith('/*', index)) {
            const commentEnd = value.indexOf('*/', index + 2);
            if (commentEnd < 0) { break; }
            result += value.slice(startIndex, index);
            startIndex = commentEnd + 2;
            index = commentEnd + 1;
        }
    }
    return startIndex === 0 ? value : result + value.slice(startIndex);
}

/**
 * @param {string|null|undefined} styleText
 * @param {string} assetPrefix
 * @param {Set<string>} assetReferences
 * @returns {Record<string, string|string[]>|null}
 */
function convertInlineStyle(styleText, assetPrefix, assetReferences) {
    if (typeof styleText !== 'string' || trimCssWhitespace(styleText).length === 0) { return null; }
    /** @type {Record<string, string|string[]>} */
    const style = {};
    for (const rawDeclaration of splitInlineCssDeclarations(styleText)) {
        const declaration = stripCssCommentsOutsideStrings(rawDeclaration);
        const separator = declaration.indexOf(':');
        if (separator < 0) { continue; }
        const propertyName = trimCssWhitespace(declaration.slice(0, separator)).toLowerCase();
        let value = trimCssWhitespace(declaration.slice(separator + 1));
        if (propertyName.length === 0 || value.length === 0) { continue; }
        if (/url\(/iu.test(value)) {
            value = rewriteCssAssetUrls(value, assetPrefix, null, assetReferences);
        }
        if (propertyName === 'text-decoration' || propertyName === 'text-decoration-line') {
            const parts = value.split(/[\t\n\f\r ]+/u).filter((part) => ['underline', 'overline', 'line-through', 'none'].includes(part));
            if (parts.length === 0) { continue; }
            style.textDecorationLine = parts.length === 1 ? parts[0] : parts;
            continue;
        }
        const mappedName = INLINE_STYLE_PROPERTY_MAP.get(propertyName);
        if (typeof mappedName !== 'string') { continue; }
        style[mappedName] = value;
    }
    return Object.keys(style).length > 0 ? style : null;
}

/**
 * HTML legacy sizes are presentational hints, not unitless CSS lengths.
 * https://html.spec.whatwg.org/multipage/rendering.html#rules-for-parsing-a-legacy-font-size
 * @param {string|undefined} value
 * @returns {string|null}
 */
function convertLegacyFontSize(value) {
    if (typeof value !== 'string') { return null; }
    const match = /^[\t\n\f\r ]*([+-]?)(\d+)/u.exec(value);
    if (match === null) { return null; }
    let size = Number.parseInt(match[2], 10);
    if (match[1] === '+') { size += 3; }
    if (match[1] === '-') { size = 3 - size; }
    const sizes = ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large'];
    return sizes[Math.max(1, Math.min(7, size)) - 1];
}

/**
 * @param {string} href
 * @param {{assetPrefix: string, enableAudio: boolean, embeddedAssets: EmbeddedAssetCollector, assetReferences: Set<string>}} details
 * @returns {string}
 */
function convertLinkHref(href, {assetPrefix, enableAudio, embeddedAssets, assetReferences}) {
    const value = trimCssWhitespace(href);
    const lowered = value.toLowerCase();
    if (lowered.startsWith('entry://')) { return createSearchHref(decodePercentEncodedPathSegments(value.slice(8))); }
    if (lowered.startsWith('bword://')) { return createSearchHref(decodePercentEncodedPathSegments(value.slice(8))); }
    if (lowered.startsWith('d:') || lowered.startsWith('x:')) { return createSearchHref(decodePercentEncodedPathSegments(value.slice(2))); }
    if (lowered.startsWith('sound://')) {
        if (!enableAudio) { return '#'; }
        const assetKey = normalizeReferencedAssetKey(value.slice(8), assetPrefix, null);
        if (assetKey !== null) { assetReferences.add(assetKey); }
        const assetPath = assetKey === null ? null : `${assetPrefix}${assetKey}`;
        return assetPath !== null ? `media:${encodeMediaPath(assetPath)}` : '#';
    }
    if (lowered.startsWith('http://') || lowered.startsWith('https://') || lowered.startsWith('mailto:') || lowered.startsWith('tel:')) {
        return value;
    }
    if (lowered.startsWith('data:')) {
        const assetPath = embeddedAssets.registerDataUrl(value);
        return assetPath !== null ? `media:${encodeMediaPath(assetPath)}` : '#';
    }
    if (lowered.startsWith('javascript:') || lowered.startsWith('vbscript:') || lowered.startsWith('about:') || value.startsWith('#')) {
        return '#';
    }
    const assetKey = normalizeReferencedAssetKey(value, assetPrefix, null);
    if (assetKey !== null) { assetReferences.add(assetKey); }
    const assetPath = assetKey === null ? null : `${assetPrefix}${assetKey}`;
    return assetPath !== null ? `media:${encodeMediaPath(assetPath)}` : '#';
}

/**
 * @param {Record<string, string>} attrs
 * @param {{assetPrefix: string, embeddedAssets: EmbeddedAssetCollector, assetReferences: Set<string>}} details
 * @returns {Record<string, unknown>|null}
 */
function createStructuredImage(attrs, {assetPrefix, embeddedAssets, assetReferences}) {
    const src = attrs.src ?? '';
    const lowerSrc = trimCssWhitespace(src).toLowerCase();
    let path;
    if (lowerSrc.startsWith('data:')) {
        path = embeddedAssets.registerDataUrl(src);
    } else {
        const assetKey = normalizeReferencedAssetKey(src, assetPrefix, null);
        if (assetKey !== null) { assetReferences.add(assetKey); }
        path = assetKey === null ? null : `${assetPrefix}${assetKey}`;
    }
    if (path === null) { return null; }
    /** @type {Record<string, unknown>} */
    const image = {tag: 'img', path};
    const data = buildStructuredData(attrs);
    if (data !== null) { image.data = {tag: 'img', ...data}; }
    if (typeof attrs.width === 'string' && /^\d+$/u.test(attrs.width)) { image.width = Number.parseInt(attrs.width, 10); }
    if (typeof attrs.height === 'string' && /^\d+$/u.test(attrs.height)) { image.height = Number.parseInt(attrs.height, 10); }
    if (typeof attrs.title === 'string' && attrs.title.length > 0) { image.title = attrs.title; }
    if (typeof attrs.alt === 'string' && attrs.alt.length > 0) { image.alt = attrs.alt; }
    return image;
}

/**
 * @param {Parse5ElementNode} element
 * @returns {Record<string, string>}
 */
function getElementAttributes(element) {
    /** @type {Record<string, string>} */
    const attrs = {};
    const elementAttrs = /** @type {Array<{name: string, value: string}>} */ (/** @type {unknown} */ (element.attrs ?? []));
    for (const {name, value} of elementAttrs) {
        attrs[name.toLowerCase()] = value;
    }
    return attrs;
}

/**
 * @param {Parse5ParentNode} parent
 * @returns {string}
 */
function getDirectTextContent(parent) {
    let text = '';
    for (const node of parent.childNodes ?? []) {
        if (parse5.defaultTreeAdapter.isTextNode(node)) {
            const textNode = /** @type {Parse5TextNode} */ (/** @type {unknown} */ (node));
            text += textNode.value;
        }
    }
    return text;
}

/**
 * @param {Parse5ParentNode} parent
 * @param {Array<unknown>} content
 * @param {{assetPrefix: string, enableAudio: boolean, embeddedAssets: EmbeddedAssetCollector, inlineStylesheets: Array<[string, string]>, assetReferences: Set<string>}} details
 */
function appendStructuredContent(parent, content, details) {
    for (const child of parent.childNodes ?? []) {
        if (parse5.defaultTreeAdapter.isTextNode(child)) {
            const textNode = /** @type {Parse5TextNode} */ (/** @type {unknown} */ (child));
            if (textNode.value.length === 0) { continue; }
            const lastValue = content.at(-1);
            if (typeof lastValue === 'string') {
                content[content.length - 1] = `${lastValue}${textNode.value}`;
            } else {
                content.push(textNode.value);
            }
            continue;
        }
        if (!parse5.defaultTreeAdapter.isElementNode(child)) { continue; }
        const elementNode = /** @type {Parse5ElementNode} */ (/** @type {unknown} */ (child));
        const tagName = elementNode.tagName.toLowerCase();
        const attrs = getElementAttributes(elementNode);
        if (tagName === 'script' || tagName === 'noscript') { continue; }
        if (tagName === 'style') {
            const stylesheet = trimCssWhitespace(getDirectTextContent(elementNode));
            if (stylesheet.length > 0) {
                details.inlineStylesheets.push([`inline/${details.inlineStylesheets.length + 1}.css`, stylesheet]);
            }
            continue;
        }
        if (tagName === 'link' && (attrs.rel || '').split(/[\t\n\f\r ]+/u).some((token) => token.toLowerCase() === 'stylesheet')) {
            const assetKey = normalizeReferencedAssetKey(attrs.href ?? '', details.assetPrefix, null);
            if (assetKey !== null) {
                details.assetReferences.add(assetKey);
            }
            continue;
        }

        let mappedTag = SUPPORTED_STRUCTURED_TAGS.has(tagName) ? tagName : (HTML_TAG_MAP.get(tagName) ?? null);
        if (tagName === 'audio' || tagName === 'video') { mappedTag = 'a'; }
        if (mappedTag === null) {
            appendStructuredContent(elementNode, content, details);
            continue;
        }
        if (mappedTag === 'img') {
            const image = createStructuredImage(attrs, details);
            if (image !== null) { content.push(image); }
            continue;
        }

        /** @type {Record<string, unknown>} */
        const element = {tag: mappedTag};
        const data = buildStructuredData(attrs);
        if (data !== null) { element.data = {tag: tagName, ...data}; }

        /** @type {StructuredStyle} */
        const style = {};
        const defaultStyle = HTML_TAG_DEFAULT_STYLES.get(tagName);
        if (typeof defaultStyle !== 'undefined') {
            Object.assign(style, defaultStyle);
        }
        const inlineStyle = convertInlineStyle(attrs.style, details.assetPrefix, details.assetReferences);
        if (inlineStyle !== null) {
            Object.assign(style, inlineStyle);
        }
        if (Object.keys(style).length > 0 && ['a', 'details', 'div', 'li', 'ol', 'span', 'summary', 'td', 'th', 'ul'].includes(mappedTag)) {
            element.style = style;
        }
        if (typeof attrs.lang === 'string' && attrs.lang.length > 0) { element.lang = attrs.lang; }
        if (typeof attrs.title === 'string' && attrs.title.length > 0) { element.title = attrs.title; }

        if (mappedTag === 'a') {
            const sourceHref = attrs.href ?? attrs.src ?? '';
            element.href = convertLinkHref(sourceHref, details);
        } else if ((mappedTag === 'td' || mappedTag === 'th') && typeof attrs.colspan === 'string' && /^\d+$/u.test(attrs.colspan)) {
            element.colSpan = Number.parseInt(attrs.colspan, 10);
        }
        if ((mappedTag === 'td' || mappedTag === 'th') && typeof attrs.rowspan === 'string' && /^\d+$/u.test(attrs.rowspan)) {
            element.rowSpan = Number.parseInt(attrs.rowspan, 10);
        }
        if (mappedTag === 'details' && Object.hasOwn(attrs, 'open')) {
            element.open = true;
        }
        if (tagName === 'font') {
            /** @type {StructuredStyle} */
            const fontStyle = {};
            if (typeof attrs.color === 'string' && attrs.color.length > 0) { fontStyle.color = attrs.color; }
            const fontSize = convertLegacyFontSize(attrs.size);
            if (fontSize !== null) { fontStyle.fontSize = fontSize; }
            if (typeof attrs.face === 'string' && attrs.face.length > 0) { fontStyle.fontFamily = attrs.face; }
            if (Object.keys(fontStyle).length > 0) {
                /** @type {StructuredStyle} */
                const existingStyle = isStructuredStyleRecord(element.style) ? element.style : {};
                // Author inline CSS takes precedence over legacy attributes.
                element.style = {...fontStyle, ...existingStyle};
            }
        }

        if (mappedTag !== 'br') {
            /** @type {unknown[]} */
            const childContent = [];
            appendStructuredContent(elementNode, childContent, details);
            if (childContent.length > 0) {
                element.content = childContent;
            } else if (tagName === 'audio' || tagName === 'video') {
                element.content = [tagName];
            }
        }

        content.push(element);
    }
}

/**
 * @param {string} definition
 * @param {{enableAudio: boolean, assetPrefix: string, embeddedAssetCounter: {value: number}, entryScopeClass: string}} options
 * @returns {{glossary: Record<string, unknown>, inlineStylesheets: Array<[string, string]>, embeddedAssets: Map<string, Uint8Array>, assetReferences: Set<string>}}
 */
function convertDefinitionToStructuredContent(definition, options) {
    const embeddedAssets = new EmbeddedAssetCollector(options.assetPrefix, options.embeddedAssetCounter);
    /** @type {Set<string>} */
    const assetReferences = new Set();
    /** @type {Array<[string, string]>} */
    const inlineStylesheets = [];
    const fragmentResult = /** @type {unknown} */ (parse5.parseFragment(definition));
    const fragment = /** @type {Parse5ParentNode} */ (fragmentResult);
    /** @type {unknown[]} */
    const content = [];
    appendStructuredContent(fragment, content, {
        assetPrefix: options.assetPrefix,
        enableAudio: options.enableAudio,
        embeddedAssets,
        inlineStylesheets,
        assetReferences,
    });
    const rootClass = inlineStylesheets.length > 0 ? `${MDX_GLOSSARY_ROOT_CLASS} ${options.entryScopeClass}` : MDX_GLOSSARY_ROOT_CLASS;
    return {
        glossary: {
            type: 'structured-content',
            content: {
                tag: 'div',
                data: {
                    tag: 'div',
                    class: rootClass,
                },
                content,
            },
        },
        inlineStylesheets,
        embeddedAssets: embeddedAssets.assets,
        assetReferences,
    };
}

/**
 * @param {MdxDictionaryLike} mdx
 * @param {string} fileName
 * @param {string} override
 * @returns {string}
 */
function extractTitle(mdx, fileName, override) {
    if (override.trim().length > 0) { return override.trim(); }
    const title = trimNullSuffix(String(mdx.header.Title ?? '')).trim();
    if (title.length === 0 || title === 'Title (No HTML code allowed)') {
        return getBaseName(fileName);
    }
    return title;
}

/**
 * @param {MdxDictionaryLike} mdx
 * @param {string} override
 * @returns {string}
 */
function extractDescription(mdx, override) {
    return override.trim().length > 0 ? override.trim() : trimNullSuffix(String(mdx.header.Description ?? '')).trim();
}

/**
 * @param {string} term
 * @param {Map<string, Set<string>>} redirects
 * @param {Map<string, string[]>} fallbackTargets
 * @param {Set<string>} resolvedTargets
 * @param {(value: string) => string} normalizeRedirectKey
 * @returns {string[]}
 */
function getRedirectExpressions(term, redirects, fallbackTargets, resolvedTargets, normalizeRedirectKey) {
    const expressions = [term];
    const emittedExpressions = new Set(expressions);
    const visitedFallbacks = new Set();
    for (let index = 0; index < expressions.length; ++index) {
        const expression = expressions[index];
        const targets = [expression];
        const normalized = normalizeRedirectKey(expression);
        if (!visitedFallbacks.has(normalized)) {
            visitedFallbacks.add(normalized);
            const fallbacks = fallbackTargets.get(normalized);
            if (typeof fallbacks !== 'undefined') {
                for (const target of fallbacks) { targets.push(target); }
            }
        }
        for (const target of targets) {
            const aliases = redirects.get(target);
            if (typeof aliases === 'undefined') { continue; }
            resolvedTargets.add(target);
            for (const alias of aliases) {
                if (emittedExpressions.has(alias)) { continue; }
                emittedExpressions.add(alias);
                expressions.push(alias);
            }
        }
    }
    return expressions;
}

/**
 * Preserve an exact target even when another spelling normalizes to the same
 * key. Only genuinely absent targets may use case/StripKey fallback. Scan the
 * existing key metadata, retaining only redirect target names, not another
 * dictionary-wide lookup index. Failed records and cycles remain unresolved.
 * @param {Map<string, Set<string>>} redirects
 * @param {MdictKeyword[]} keywords
 * @param {(value: string) => string} normalizeRedirectKey
 * @returns {Map<string, string[]>}
 */
function getFallbackRedirectTargets(redirects, keywords, normalizeRedirectKey) {
    /** @type {Map<string, string[]>} */
    const fallbacks = new Map();
    if (redirects.size === 0) { return fallbacks; }
    const exactTargets = new Set();
    for (const {keyText} of keywords) {
        const term = trimNullSuffix(keyText);
        if (redirects.has(term)) { exactTargets.add(term); }
    }
    for (const target of redirects.keys()) {
        if (exactTargets.has(target)) { continue; }
        const normalized = normalizeRedirectKey(target);
        const targets = fallbacks.get(normalized);
        if (typeof targets === 'undefined') {
            fallbacks.set(normalized, [target]);
        } else {
            targets.push(target);
        }
    }
    return fallbacks;
}

/**
 * @param {string} fileName
 * @param {{titleOverride?: string, descriptionOverride?: string, revision?: string, enableAudio?: boolean, includeAssets?: boolean, termBankSize?: number}} options
 * @param {Uint8Array} mdxBytes
 * @param {Array<{name: string, bytes: Uint8Array}>} mddSources
 * @param {?(details: {stage: 'convert', completed: number, total: number}) => void} onProgress
 * @returns {Promise<{files: Map<string, Uint8Array>, archiveFileName: string, phaseTimings: Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>}>}
 */
export async function createMdxImportData(fileName, options, mdxBytes, mddSources, onProgress = null) {
    const {
        titleOverride = '',
        descriptionOverride = '',
        revision = '',
        enableAudio = false,
        includeAssets = true,
        termBankSize = 10000,
    } = options;

    const mdx = /** @type {MdxDictionaryLike} */ (new MDX(fileName, mdxBytes, {recordBlockCacheBytes: MDX_IMPORT_RECORD_BLOCK_CACHE_BYTES}));
    /** @type {MddAssetResolver|null} */
    let assetResolver = null;
    try {
        const title = extractTitle(mdx, fileName, titleOverride);
        const description = extractDescription(mdx, descriptionOverride);
        const assetPrefix = 'mdict-media/';
        /** @type {Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>} */
        const phaseTimings = [];
        /**
         * @param {string} phase
         * @param {number} startTime
         * @param {Record<string, string|number|boolean|null>} [details]
         */
        const recordPhaseTiming = (phase, startTime, details = {}) => {
            phaseTimings.push({
                phase,
                elapsedMs: Math.max(0, Date.now() - startTime),
                details,
            });
        };

        const tIndexMddStart = Date.now();
        if (includeAssets && mddSources.length > 0) {
            assetResolver = new MddAssetResolver(mddSources);
        }
        recordPhaseTiming('prepare-mdx:index-mdd', tIndexMddStart, {
            includeAssets,
            mddCount: mddSources.length,
            indexedAssetCount: assetResolver?.recordCount ?? 0,
            cssAssetCount: assetResolver?.cssKeys.length ?? 0,
        });

        const totalEntries = Math.max(1, mdx.keywordList.length);
        if (typeof onProgress === 'function') {
            onProgress({stage: 'convert', completed: 0, total: totalEntries});
        }

        /** @type {Map<string, Uint8Array>} */
        const embeddedAssets = new Map();
        const embeddedAssetCounter = {value: 0};
        const encoder = new TextEncoder();
        /** @type {Map<string, Uint8Array>} */
        const files = new Map();
        /** @type {Array<[string, string, string]>} */
        const inlineStylesheets = [];
        /** @type {Set<string>} */
        const referencedAssetKeys = new Set();
        const redirectCaseSensitive = mdictCommon.isTrue(mdx.header.KeyCaseSensitive);
        const redirectStripKey = mdictCommon.isTrue(mdx.header.StripKey);
        /**
         * @param {string} value
         * @returns {string}
         */
        const normalizeRedirectKey = (value) => {
            if (redirectStripKey) {
                value = value.replace(mdictCommon.REGEXP_STRIPKEY.mdx, '$1');
            }
            return redirectCaseSensitive ? value : value.toLowerCase();
        };
        /** @type {Map<string, Set<string>>} */
        const redirects = new Map();
        /** @type {Set<string>} */
        const resolvedRedirectTargets = new Set();
        /** @type {Array<{term: string, glossary: Record<string, unknown>, sequence: number}>} */
        const convertedEntries = [];
        let sequence = 0;
        let processedEntries = 0;
        let redirectCount = 0;
        let skippedEntryErrorCount = 0;
        let jsonEncodeMs = 0;

        /**
         * @param {string} path
         * @param {unknown} value
         * @returns {void}
         */
        const writeJson = (path, value) => {
            const tEncodeStart = Date.now();
            files.set(path, encoder.encode(JSON.stringify(value)));
            jsonEncodeMs += Math.max(0, Date.now() - tEncodeStart);
        };

        writeJson('index.json', {
            title,
            revision: revision.trim().length > 0 ? revision.trim() : 'mdx import',
            sequenced: true,
            format: 3,
            description,
        });

        const tConvertEntriesStart = Date.now();
        for (const item of mdx.keywordList) {
            const term = trimNullSuffix(item.keyText);
            processedEntries += 1;
            if (term.length === 0) {
                if (typeof onProgress === 'function') {
                    onProgress({stage: 'convert', completed: processedEntries, total: totalEntries});
                }
                continue;
            }
            let definition;
            try {
                const result = mdx.fetch_definition(item);
                definition = trimNullSuffix(result.definition ?? '');
            } catch (_error) {
                skippedEntryErrorCount += 1;
                if (typeof onProgress === 'function') {
                    onProgress({stage: 'convert', completed: processedEntries, total: totalEntries});
                }
                continue;
            }
            const redirectDefinition = trimCssWhitespace(definition);
            if (redirectDefinition.startsWith('@@@LINK=')) {
                const target = trimCssWhitespace(trimNullSuffix(redirectDefinition.slice(8)));
                if (target.length > 0) {
                    const aliases = redirects.get(target) ?? new Set();
                    if (!aliases.has(term)) {
                        aliases.add(term);
                        redirects.set(target, aliases);
                        redirectCount += 1;
                    }
                }
                if (typeof onProgress === 'function') {
                    onProgress({stage: 'convert', completed: processedEntries, total: totalEntries});
                }
                continue;
            }

            let converted;
            try {
                const preparedDefinition = prepareDefinitionMarkup(definition, mdx.header);
                converted = convertDefinitionToStructuredContent(preparedDefinition, {
                    enableAudio,
                    assetPrefix,
                    embeddedAssetCounter,
                    entryScopeClass: `${MDX_GLOSSARY_ENTRY_CLASS_PREFIX}${sequence}`,
                });
            } catch (_error) {
                skippedEntryErrorCount += 1;
                if (typeof onProgress === 'function') {
                    onProgress({stage: 'convert', completed: processedEntries, total: totalEntries});
                }
                continue;
            }
            for (const [path, bytes] of converted.embeddedAssets) {
                if (!embeddedAssets.has(path)) {
                    embeddedAssets.set(path, bytes);
                }
            }
            for (const [sourceName, stylesheet] of converted.inlineStylesheets) {
                inlineStylesheets.push([`${term}/${sourceName}`, stylesheet, `${MDX_GLOSSARY_ENTRY_CLASS_PREFIX}${sequence}`]);
            }
            for (const assetKey of converted.assetReferences) {
                referencedAssetKeys.add(assetKey);
            }
            convertedEntries.push({term, glossary: converted.glossary, sequence});
            sequence += 1;
            if (typeof onProgress === 'function') {
                onProgress({stage: 'convert', completed: processedEntries, total: totalEntries});
            }
        }
        recordPhaseTiming('prepare-mdx:convert-entries', tConvertEntriesStart, {
            entries: processedEntries,
            convertedEntryCount: convertedEntries.length,
            redirectCount,
            referencedAssetCount: referencedAssetKeys.size,
            inlineStylesheetCount: inlineStylesheets.length,
            embeddedAssetCount: embeddedAssets.size,
            skippedEntryErrorCount,
        });
        if (
            mdx.keywordList.length > 0 &&
            convertedEntries.length === 0
        ) {
            if (skippedEntryErrorCount > 0) {
                throw new Error(`MDX import failed: all ${skippedEntryErrorCount} non-empty entr${skippedEntryErrorCount === 1 ? 'y was' : 'ies were'} corrupt or unsupported`);
            }
            throw new Error('MDX import failed: no usable non-redirect entries were found');
        }

        const tEncodeBanksStart = Date.now();
        let bankIndex = 1;
        let encodedTermBankCount = 0;
        let encodedTermRowCount = 0;
        /** @type {unknown[][]} */
        let bank = [];
        const flushBank = () => {
            if (bank.length === 0) { return; }
            encodedTermRowCount += bank.length;
            writeJson(`term_bank_${bankIndex}.json`, bank);
            encodedTermBankCount += 1;
            bank = [];
            bankIndex += 1;
        };
        const fallbackTargets = getFallbackRedirectTargets(redirects, mdx.keywordList, normalizeRedirectKey);
        for (const {term, glossary, sequence: entrySequence} of convertedEntries) {
            const expressions = getRedirectExpressions(term, redirects, fallbackTargets, resolvedRedirectTargets, normalizeRedirectKey);
            for (const expression of expressions) {
                bank.push([
                    expression,
                    '',
                    '',
                    '',
                    0,
                    [glossary],
                    entrySequence,
                    '',
                ]);
                if (bank.length >= termBankSize) { flushBank(); }
            }
        }

        if (bank.length > 0) {
            flushBank();
        } else if (convertedEntries.length === 0) {
            writeJson(`term_bank_${bankIndex}.json`, []);
            encodedTermBankCount += 1;
        }
        let resolvedRedirectCount = 0;
        for (const target of resolvedRedirectTargets) {
            resolvedRedirectCount += redirects.get(target)?.size ?? 0;
        }
        recordPhaseTiming('prepare-mdx:encode-banks', tEncodeBanksStart, {
            encodedTermBankCount,
            encodedTermRowCount,
            jsonEncodeMs,
            unresolvedRedirectCount: Math.max(0, redirectCount - resolvedRedirectCount),
        });

        const tMaterializeAssetsStart = Date.now();
        /** @type {Map<string, Uint8Array>} */
        const cssAssets = new Map();
        if (assetResolver !== null) {
            for (const cssKey of assetResolver.cssKeys) {
                const bytes = assetResolver.getBytes(cssKey);
                if (!(bytes instanceof Uint8Array)) { continue; }
                cssAssets.set(cssKey, bytes);
            }
        }
        /** @type {Set<string>} */
        const cssReferencedAssetKeys = new Set();
        const rootStylesheet = buildRootStylesheet(cssAssets, assetPrefix, inlineStylesheets, cssReferencedAssetKeys);
        if (rootStylesheet !== null) {
            files.set('styles.css', encoder.encode(rootStylesheet));
        }
        for (const [assetPath, bytes] of embeddedAssets) {
            files.set(assetPath, bytes);
        }
        for (const [cssKey, bytes] of cssAssets) {
            files.set(`${assetPrefix}${cssKey}`, bytes);
        }
        let materializedReferencedAssetCount = 0;
        const allReferencedAssetKeys = new Set([...referencedAssetKeys, ...cssReferencedAssetKeys]);
        if (assetResolver !== null) {
            for (const assetKey of allReferencedAssetKeys) {
                if (assetKey.toLowerCase().endsWith('.css')) { continue; }
                const bytes = assetResolver.getBytes(assetKey);
                if (!(bytes instanceof Uint8Array)) { continue; }
                const archivePath = `${assetPrefix}${assetKey}`;
                if (files.has(archivePath)) { continue; }
                files.set(archivePath, bytes);
                materializedReferencedAssetCount += 1;
            }
        }
        let missingReferencedAssetCount = 0;
        if (includeAssets) {
            for (const assetKey of allReferencedAssetKeys) {
                if (!files.has(`${assetPrefix}${assetKey}`)) { ++missingReferencedAssetCount; }
            }
        }
        recordPhaseTiming('prepare-mdx:materialize-assets', tMaterializeAssetsStart, {
            missingReferencedAssetCount,
            cssAssetCount: cssAssets.size,
            referencedAssetCount: referencedAssetKeys.size,
            cssReferencedAssetCount: cssReferencedAssetKeys.size,
            embeddedAssetCount: embeddedAssets.size,
            materializedReferencedAssetCount,
            assetLookupErrorCount: assetResolver?.lookupErrorCount ?? 0,
            hasRootStylesheet: rootStylesheet !== null,
        });
        if (typeof onProgress === 'function') {
            onProgress({stage: 'convert', completed: totalEntries, total: totalEntries});
        }
        return {
            files,
            archiveFileName: `${title}.zip`,
            phaseTimings,
        };
    } finally {
        assetResolver?.close();
        mdx.close();
    }
}

/**
 * @param {string} fileName
 * @param {{titleOverride?: string, descriptionOverride?: string, revision?: string, enableAudio?: boolean, includeAssets?: boolean, termBankSize?: number}} options
 * @param {Uint8Array} mdxBytes
 * @param {Array<{name: string, bytes: Uint8Array}>} mddSources
 * @param {?(details: {stage: 'convert'|'download', completed: number, total: number}) => void} onProgress
 * @returns {Promise<{archiveContent: ArrayBuffer, archiveFileName: string, phaseTimings: Array<{phase: string, elapsedMs: number, details?: Record<string, string|number|boolean|null>}>}>}
 */
export async function convertMdxToArchive(fileName, options, mdxBytes, mddSources, onProgress = null) {
    const {files, archiveFileName, phaseTimings} = await createMdxImportData(
        fileName,
        options,
        mdxBytes,
        mddSources,
        (details) => {
            if (typeof onProgress === 'function') {
                onProgress(details);
            }
        },
    );

    const writer = new BlobWriter();
    const zipWriter = new ZipWriter(writer, {level: 0});
    for (const [archivePath, bytes] of files) {
        await zipWriter.add(archivePath, new Uint8ArrayReader(bytes), {useWebWorkers: false});
    }
    await zipWriter.close();
    const archiveContent = await (await writer.getData()).arrayBuffer();
    if (typeof onProgress === 'function') {
        onProgress({stage: 'download', completed: archiveContent.byteLength, total: archiveContent.byteLength});
    }
    return {
        archiveContent,
        archiveFileName,
        phaseTimings,
    };
}
