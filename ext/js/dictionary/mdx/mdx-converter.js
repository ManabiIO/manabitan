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
    configure,
} from '../../../lib/zip.js';
import * as parse5 from '../../../lib/parse5.js';
import {base64ToArrayBuffer} from '../../data/array-buffer-util.js';
import {MDX} from './vendor/js-mdict/mdx.js';
import {MDD} from './vendor/js-mdict/mdd.js';

const BlobWriter = /** @type {typeof import('@zip.js/zip.js').BlobWriter} */ (/** @type {unknown} */ (BlobWriter0));
const Uint8ArrayReader = /** @type {typeof import('@zip.js/zip.js').Uint8ArrayReader} */ (/** @type {unknown} */ (Uint8ArrayReader0));
const ZipWriter = /** @type {typeof import('@zip.js/zip.js').ZipWriter} */ (/** @type {unknown} */ (ZipWriter0));

configure({useWebWorkers: false});

/**
 * @typedef {{keyText: string}} MdictKeyword
 */

/**
 * @typedef {{definition?: string|null}} MdictDefinitionResult
 */

/**
 * @typedef {{Title?: string, Description?: string}} MdictHeader
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

class EmbeddedAssetCollector {
    /**
     * @param {string} assetPrefix
     */
    constructor(assetPrefix) {
        /** @type {string} */
        this._assetPrefix = assetPrefix;
        /** @type {Map<string, Uint8Array>} */
        this._assets = new Map();
        /** @type {number} */
        this._counter = 0;
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
        const path = `${this._assetPrefix}embedded/${category}/${String(++this._counter).padStart(6, '0')}${extension}`;
        this._assets.set(path, data);
        return path;
    }
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimNullSuffix(value) {
    return value.replace(new RegExp(`${NULL_CHARACTER}+$`, 'gu'), '').trim();
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
 * @param {string|null} sourceAssetPath
 * @returns {string|null}
 */
function normalizeRelativeAssetPath(path, sourceAssetPath = null) {
    let value = path.trim().replaceAll('\\', '/');
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
    let suffix = '';
    const suffixIndex = value.search(/[?#]/u);
    if (suffixIndex >= 0) {
        suffix = value.slice(suffixIndex);
        value = value.slice(0, suffixIndex);
    }
    if (lowered.startsWith('file://')) {
        value = value.slice(7);
    }
    value = value.replace(/^\/+/u, '');
    if (sourceAssetPath !== null && (value.startsWith('./') || value.startsWith('../'))) {
        const sourceParent = sourceAssetPath.replace(/\/[^/]*$/u, '');
        value = sourceParent.length > 0 ? `${sourceParent}/${value}` : value;
    }
    value = collapsePosixPath(value);
    return value.length > 0 ? `${value}${suffix}` : null;
}

/**
 * @param {string} path
 * @param {string} assetPrefix
 * @param {string|null} sourceAssetPath
 * @returns {string|null}
 */
function prefixRelativeAssetPath(path, assetPrefix, sourceAssetPath = null) {
    const normalizedPath = normalizeRelativeAssetPath(path, sourceAssetPath);
    if (normalizedPath === null) { return null; }
    return normalizedPath.startsWith(assetPrefix) ? normalizedPath : `${assetPrefix}${normalizedPath}`;
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
    const parts = header.split(';').map((part) => part.trim()).filter((part) => part.length > 0);
    const mediaType = (parts[0] || 'text/plain').toLowerCase();
    const isBase64 = parts.slice(1).some((part) => part.toLowerCase() === 'base64');
    try {
        return {
            mediaType,
            data: isBase64 ? new Uint8Array(base64ToArrayBuffer(payload)) : new TextEncoder().encode(decodeURIComponent(payload)),
        };
    } catch (_error) {
        return null;
    }
}

/**
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function decodeStylesheetAsset(bytes) {
    for (const encoding of ['utf-8', 'utf-16', 'utf-16le', 'utf-16be']) {
        try {
            const value = new TextDecoder(encoding).decode(bytes).trim();
            if (value.length > 0 && !value.includes('\u0000')) {
                return value;
            }
        } catch (_error) {
            // NOP
        }
    }
    return null;
}

/**
 * @param {string} stylesheet
 * @param {string} assetPrefix
 * @param {string|null} sourceAssetPath
 * @returns {string}
 */
function rewriteCssAssetUrls(stylesheet, assetPrefix, sourceAssetPath) {
    return stylesheet.replace(/url\(\s*(["']?)(.*?)\1\s*\)/giu, (match, _quote, rawPath) => {
        const path = typeof rawPath === 'string' ? rawPath : '';
        const prefixedPath = prefixRelativeAssetPath(path, assetPrefix, sourceAssetPath);
        return prefixedPath === null ? match : `url("${prefixedPath}")`;
    });
}

/**
 * @param {Map<string, Uint8Array>} assets
 * @param {string} assetPrefix
 * @param {Array<[string, string]>} inlineStylesheets
 * @returns {string|null}
 */
function buildRootStylesheet(assets, assetPrefix, inlineStylesheets) {
    /** @type {string[]} */
    const sections = [];
    for (const [archivePath, bytes] of [...assets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!archivePath.toLowerCase().endsWith('.css')) { continue; }
        const stylesheet = decodeStylesheetAsset(bytes);
        if (stylesheet === null) { continue; }
        const sourceName = archivePath.startsWith(assetPrefix) ? archivePath.slice(assetPrefix.length) : archivePath;
        sections.push(`/* Source: ${sourceName} */\n${rewriteCssAssetUrls(stylesheet, assetPrefix, sourceName)}`);
    }
    for (const [sourceName, stylesheet] of inlineStylesheets) {
        sections.push(`/* Source: ${sourceName} */\n${rewriteCssAssetUrls(stylesheet, assetPrefix, null)}`);
    }
    return sections.length > 0 ? `${sections.join('\n\n')}\n` : null;
}

/**
 * @param {Map<string, Uint8Array>} assets
 * @param {Array<{name: string, bytes: Uint8Array}>} mddSources
 */
function collectAssets(assets, mddSources) {
    for (const {name, bytes} of mddSources) {
        const mdd = /** @type {MddDictionaryLike} */ (new MDD(name, bytes));
        for (const item of mdd.keywordList) {
            const key = normalizeAssetKey(item.keyText);
            if (key.length === 0) { continue; }
            const value = mdd.lookupRecordByKeyBlock(item);
            if (!(value instanceof Uint8Array)) { continue; }
            if (!assets.has(key)) {
                assets.set(key, value);
            }
        }
        mdd.close();
    }
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
    const className = attrs.class?.trim().replace(/\s+/gu, ' ') || '';
    if (className.length > 0) { data.class = className; }
    const id = attrs.id?.trim() || '';
    if (id.length > 0) { data.id = id; }
    return Object.keys(data).length > 0 ? data : null;
}

/**
 * @param {string|null|undefined} styleText
 * @param {string} assetPrefix
 * @returns {Record<string, string|string[]>|null}
 */
function convertInlineStyle(styleText, assetPrefix) {
    if (typeof styleText !== 'string' || styleText.trim().length === 0) { return null; }
    /** @type {Record<string, string|string[]>} */
    const style = {};
    for (const declaration of styleText.split(';')) {
        const separator = declaration.indexOf(':');
        if (separator < 0) { continue; }
        const propertyName = declaration.slice(0, separator).trim().toLowerCase();
        let value = declaration.slice(separator + 1).trim();
        if (propertyName.length === 0 || value.length === 0) { continue; }
        if (value.includes('url(')) {
            value = rewriteCssAssetUrls(value, assetPrefix, null);
        }
        if (propertyName === 'text-decoration' || propertyName === 'text-decoration-line') {
            const parts = value.split(/\s+/u).filter((part) => ['underline', 'overline', 'line-through', 'none'].includes(part));
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
 * @param {string} href
 * @param {{assetPrefix: string, enableAudio: boolean, embeddedAssets: EmbeddedAssetCollector}} details
 * @returns {string}
 */
function convertLinkHref(href, {assetPrefix, enableAudio, embeddedAssets}) {
    const value = href.trim();
    const lowered = value.toLowerCase();
    if (lowered.startsWith('entry://')) { return `?query=${value.slice(8)}`; }
    if (lowered.startsWith('bword://')) { return `?query=${value.slice(8)}`; }
    if (lowered.startsWith('d:') || lowered.startsWith('x:')) { return `?query=${value.slice(2)}`; }
    if (lowered.startsWith('sound://')) {
        const assetPath = prefixRelativeAssetPath(value.slice(8), assetPrefix, null);
        return enableAudio && assetPath !== null ? `media:${encodeMediaPath(assetPath)}` : '#';
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
    const assetPath = prefixRelativeAssetPath(value, assetPrefix, null);
    return assetPath !== null ? `media:${encodeMediaPath(assetPath)}` : '#';
}

/**
 * @param {Record<string, string>} attrs
 * @param {{assetPrefix: string, embeddedAssets: EmbeddedAssetCollector}} details
 * @returns {Record<string, unknown>|null}
 */
function createStructuredImage(attrs, {assetPrefix, embeddedAssets}) {
    const src = attrs.src ?? '';
    const lowerSrc = src.trim().toLowerCase();
    const path = lowerSrc.startsWith('data:') ? embeddedAssets.registerDataUrl(src) : prefixRelativeAssetPath(src, assetPrefix, null);
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
 * @param {{assetPrefix: string, enableAudio: boolean, embeddedAssets: EmbeddedAssetCollector, inlineStylesheets: Array<[string, string]>}} details
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
            const stylesheet = getDirectTextContent(elementNode)
                .trim();
            if (stylesheet.length > 0) {
                details.inlineStylesheets.push([`inline/${details.inlineStylesheets.length + 1}.css`, stylesheet]);
            }
            continue;
        }
        if (tagName === 'link' && (attrs.rel || '').toLowerCase().includes('stylesheet')) {
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
        const inlineStyle = convertInlineStyle(attrs.style, details.assetPrefix);
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
            if (typeof attrs.size === 'string' && attrs.size.length > 0) { fontStyle.fontSize = attrs.size; }
            if (typeof attrs.face === 'string' && attrs.face.length > 0) { fontStyle.fontFamily = attrs.face; }
            if (Object.keys(fontStyle).length > 0) {
                /** @type {StructuredStyle} */
                const existingStyle = isStructuredStyleRecord(element.style) ? element.style : {};
                element.style = {...existingStyle, ...fontStyle};
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
 * @param {{enableAudio: boolean, assetPrefix: string}} options
 * @returns {{glossary: Record<string, unknown>, inlineStylesheets: Array<[string, string]>, embeddedAssets: Map<string, Uint8Array>}}
 */
function convertDefinitionToStructuredContent(definition, options) {
    const embeddedAssets = new EmbeddedAssetCollector(options.assetPrefix);
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
    });
    return {
        glossary: {
            type: 'structured-content',
            content: {
                tag: 'div',
                data: {
                    tag: 'div',
                    class: MDX_GLOSSARY_ROOT_CLASS,
                },
                content,
            },
        },
        inlineStylesheets,
        embeddedAssets: embeddedAssets.assets,
    };
}

/**
 * @param {MdxDictionaryLike} mdx
 * @returns {Map<string, string[]>}
 */
function buildRedirectMap(mdx) {
    /** @type {Map<string, string[]>} */
    const redirects = new Map();
    for (const item of mdx.keywordList) {
        const result = mdx.fetch_definition(item);
        const term = trimNullSuffix(item.keyText);
        const definition = trimNullSuffix(result.definition ?? '');
        if (term.length === 0 || !definition.startsWith('@@@LINK=')) { continue; }
        const target = trimNullSuffix(definition.slice(8));
        const values = redirects.get(target) ?? [];
        values.push(term);
        redirects.set(target, values);
    }
    return redirects;
}

/**
 * @param {MdxDictionaryLike} mdx
 * @param {string} fileName
 * @param {string} override
 * @returns {string}
 */
function extractTitle(mdx, fileName, override) {
    if (override.trim().length > 0) { return override.trim(); }
    const title = trimNullSuffix(String(mdx.header.Title ?? ''));
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
    return override.trim().length > 0 ? override.trim() : trimNullSuffix(String(mdx.header.Description ?? ''));
}

/**
 * @param {string} fileName
 * @param {{titleOverride?: string, descriptionOverride?: string, revision?: string, enableAudio?: boolean, includeAssets?: boolean, termBankSize?: number}} options
 * @param {Uint8Array} mdxBytes
 * @param {Array<{name: string, bytes: Uint8Array}>} mddSources
 * @param {?(details: {stage: 'convert'|'download', completed: number, total: number}) => void} onProgress
 * @returns {Promise<{archiveContent: ArrayBuffer, archiveFileName: string}>}
 */
export async function convertMdxToArchive(fileName, options, mdxBytes, mddSources, onProgress = null) {
    const {
        titleOverride = '',
        descriptionOverride = '',
        revision = '',
        enableAudio = false,
        includeAssets = true,
        termBankSize = 10000,
    } = options;

    const mdx = /** @type {MdxDictionaryLike} */ (new MDX(fileName, mdxBytes));
    try {
        const redirects = buildRedirectMap(mdx);
        const title = extractTitle(mdx, fileName, titleOverride);
        const description = extractDescription(mdx, descriptionOverride);
        const assetPrefix = 'mdict-media/';
        /** @type {Map<string, Uint8Array>} */
        const assets = new Map();
        if (includeAssets && mddSources.length > 0) {
            collectAssets(assets, mddSources);
        }

        if (typeof onProgress === 'function') {
            onProgress({stage: 'convert', completed: 0, total: Math.max(1, mdx.keywordList.length)});
        }

        const writer = new BlobWriter();
        const zipWriter = new ZipWriter(writer, {level: 0});
        const encoder = new TextEncoder();
        /** @type {Array<[string, string]>} */
        const inlineStylesheets = [];
        let bankIndex = 1;
        let sequence = 0;
        /** @type {unknown[][]} */
        let bank = [];
        const totalEntries = Math.max(1, mdx.keywordList.length);
        let processedEntries = 0;

        /**
         * @param {string} path
         * @param {unknown} value
         * @returns {Promise<void>}
         */
        const writeJson = async (path, value) => {
            await zipWriter.add(path, new Uint8ArrayReader(encoder.encode(JSON.stringify(value))));
        };

        await writeJson('index.json', {
            title,
            revision: revision.trim().length > 0 ? revision.trim() : 'mdx import',
            sequenced: true,
            format: 3,
            description,
        });

        for (const item of mdx.keywordList) {
            const term = trimNullSuffix(item.keyText);
            const result = mdx.fetch_definition(item);
            const definition = trimNullSuffix(result.definition ?? '');
            processedEntries += 1;
            if (term.length === 0 || definition.startsWith('@@@LINK=')) {
                if (typeof onProgress === 'function') {
                    onProgress({stage: 'convert', completed: processedEntries, total: totalEntries});
                }
                continue;
            }

            const converted = convertDefinitionToStructuredContent(definition, {enableAudio, assetPrefix});
            for (const [path, bytes] of converted.embeddedAssets) {
                if (!assets.has(path)) {
                    assets.set(path, bytes);
                }
            }
            for (const [sourceName, stylesheet] of converted.inlineStylesheets) {
                inlineStylesheets.push([`${term}/${sourceName}`, stylesheet]);
            }
            const expressions = [term, ...(redirects.get(term) ?? [])];
            for (const expression of expressions) {
                bank.push([
                    expression,
                    '',
                    '',
                    '',
                    0,
                    [converted.glossary],
                    sequence,
                    '',
                ]);
            }
            sequence += 1;
            if (bank.length >= termBankSize) {
                await writeJson(`term_bank_${bankIndex}.json`, bank);
                bank = [];
                bankIndex += 1;
            }
            if (typeof onProgress === 'function') {
                onProgress({stage: 'convert', completed: processedEntries, total: totalEntries});
            }
        }

        if (bank.length > 0) {
            await writeJson(`term_bank_${bankIndex}.json`, bank);
        }

        /** @type {Map<string, Uint8Array>} */
        const archiveAssets = new Map();
        for (const [path, bytes] of assets) {
            archiveAssets.set(path.startsWith(assetPrefix) ? path : `${assetPrefix}${path}`, bytes);
        }
        const rootStylesheet = buildRootStylesheet(archiveAssets, assetPrefix, inlineStylesheets);
        if (rootStylesheet !== null) {
            await zipWriter.add('styles.css', new Uint8ArrayReader(encoder.encode(rootStylesheet)));
        }
        for (const [archivePath, bytes] of archiveAssets) {
            await zipWriter.add(archivePath, new Uint8ArrayReader(bytes));
        }

        await zipWriter.close();
        const archiveContent = await (await writer.getData()).arrayBuffer();
        if (typeof onProgress === 'function') {
            onProgress({stage: 'download', completed: archiveContent.byteLength, total: archiveContent.byteLength});
        }
        return {
            archiveContent,
            archiveFileName: `${title}.zip`,
        };
    } finally {
        mdx.close();
    }
}
