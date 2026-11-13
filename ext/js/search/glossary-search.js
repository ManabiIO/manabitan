/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2017-2022  Yomichan Authors
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

const MAX_GLOSSARY_SEARCH_TEXT_CODEPOINTS = 16384;
const MAX_GLOSSARY_SEARCH_NODES = 4096;
const MAX_GLOSSARY_SEARCH_TOKENS_PER_ENTRY = 256;
const MAX_GLOSSARY_QUERY_TOKENS = 8;
const MIN_INDEX_TOKEN_CODEPOINTS = 2;
const MAX_INDEX_TOKEN_CODEPOINTS = 64;
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const JAPANESE_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const LATIN_PATTERN = /\p{Script=Latin}/u;
const STRUCTURED_TEXT_BOUNDARY_TAGS = new Set(['br', 'div', 'ol', 'ul', 'li', 'details', 'summary', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'img']);

/**
 * @param {string} value
 * @returns {string}
 */
export function foldGlossarySearchText(value) {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[‘’]/gu, "'")
        .replace(/\u03c2/gu, '\u03c3');
}

/**
 * Extracts only user-facing text from Yomitan glossary payloads. Structural
 * keys, media paths, CSS classes and URLs must never become search terms.
 * @param {unknown} glossary
 * @returns {string}
 */
export function glossarySearchText(glossary) {
    /** @type {{parts: string[], pendingBoundary: boolean}} */
    const main = {parts: [], pendingBoundary: false};
    /** @type {string[][]} */
    const annotations = [];
    let codepoints = 0;
    let nodes = 0;
    /**
     * @param {string} value
     * @param {{parts: string[], pendingBoundary: boolean}} flow
     */
    const append = (value, flow) => {
        if (codepoints >= MAX_GLOSSARY_SEARCH_TEXT_CODEPOINTS) { return; }
        const available = MAX_GLOSSARY_SEARCH_TEXT_CODEPOINTS - codepoints;
        // Walk only the permitted code points. Do not materialize an array
        // proportional to the length of an untrusted glossary string.
        let end = 0;
        let count = 0;
        while (end < value.length && count < available) {
            const point = value.codePointAt(end);
            end += typeof point === 'number' && point > 0xffff ? 2 : 1;
            ++count;
        }
        if (end === 0) { return; }
        if (flow.pendingBoundary && flow.parts.length > 0) { flow.parts.push(' '); }
        flow.parts.push(value.slice(0, end));
        flow.pendingBoundary = false;
        codepoints += count;
    };
    /**
     * Keep tooltip/caption text searchable without inserting it into a word
     * whose visible characters span multiple inline elements.
     * @param {unknown} value
     * @param {number} depth
     */
    const appendAnnotation = (value, depth) => {
        if (typeof value !== 'string' || depth > 32 || ++nodes > MAX_GLOSSARY_SEARCH_NODES) { return; }
        const flow = {parts: /** @type {string[]} */ ([]), pendingBoundary: false};
        append(value, flow);
        if (flow.parts.length > 0) { annotations.push(flow.parts); }
    };
    /**
     * @param {unknown} value
     * @param {number} depth
     * @param {boolean} separateItems
     * @param {{parts: string[], pendingBoundary: boolean}} flow
     */
    const visit = (value, depth, separateItems, flow) => {
        if (
            depth > 32 ||
            ++nodes > MAX_GLOSSARY_SEARCH_NODES ||
            value === null ||
            typeof value === 'undefined'
        ) {
            return;
        }
        if (typeof value === 'string') {
            append(value, flow);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                if (separateItems) { flow.pendingBoundary = true; }
                visit(item, depth + 1, separateItems, flow);
                if (
                    codepoints >= MAX_GLOSSARY_SEARCH_TEXT_CODEPOINTS ||
                    nodes >= MAX_GLOSSARY_SEARCH_NODES
                ) {
                    break;
                }
            }
            return;
        }
        if (typeof value !== 'object') { return; }
        const object = /** @type {Record<string, unknown>} */ (value);
        if (object.type === 'image') {
            flow.pendingBoundary = true;
            appendAnnotation(object.title, depth + 1);
            appendAnnotation(object.description, depth + 1);
            return;
        }
        // Ruby readings belong to their own text flow. They must not split
        // the base word, even when either flow contains inline formatting.
        if (object.tag === 'rt' || object.tag === 'rp') {
            flow = {parts: [], pendingBoundary: false};
            annotations.push(flow.parts);
        }
        const boundary = typeof object.tag === 'string' && STRUCTURED_TEXT_BOUNDARY_TAGS.has(object.tag);
        if (boundary) { flow.pendingBoundary = true; }
        if (typeof object.text === 'string') { visit(object.text, depth + 1, false, flow); }
        appendAnnotation(object.description, depth + 1);
        appendAnnotation(object.title, depth + 1);
        if ('content' in object) { visit(object.content, depth + 1, false, flow); }
        if (boundary) { flow.pendingBoundary = true; }
    };
    // Glossary entries are separate definitions. Within structured content,
    // only semantic boundaries separate text; inline formatting adds no space.
    visit(glossary, 0, true, main);
    return [main.parts, ...annotations].map((parts) => parts.join('')).filter((text) => text.length > 0).join(' ');
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function glossarySearchTokensFromText(text) {
    const folded = foldGlossarySearchText(text);
    const seen = new Set();
    const tokens = [];
    for (const match of folded.matchAll(TOKEN_PATTERN)) {
        const token = match[0].replace(/’/gu, "'");
        const length = [...token].length;
        if (
            length < MIN_INDEX_TOKEN_CODEPOINTS ||
            length > MAX_INDEX_TOKEN_CODEPOINTS ||
            seen.has(token)
        ) {
            continue;
        }
        seen.add(token);
        tokens.push(token);
        if (tokens.length >= MAX_GLOSSARY_SEARCH_TOKENS_PER_ENTRY) { break; }
    }
    return tokens;
}

/**
 * @param {unknown} glossary
 * @returns {string[]}
 */
export function glossarySearchTokens(glossary) {
    return glossarySearchTokensFromText(glossarySearchText(glossary));
}

/**
 * @param {string} query
 * @returns {{folded: string, phrase: string, tokens: string[], prefix: string}|null}
 */
export function createGlossarySearchQuery(query) {
    // Bound the raw request before normalization or Unicode token allocation.
    if (query.length > 1024) { return null; }
    const folded = foldGlossarySearchText(query.trim());
    if (
        folded.length === 0 ||
        !LATIN_PATTERN.test(folded) ||
        JAPANESE_PATTERN.test(folded)
    ) {
        return null;
    }
    const words = [...folded.matchAll(TOKEN_PATTERN)].map((match) => match[0]);
    // The last typed word owns live-prefix completion. Index tokens are
    // deduplicated, so taking their last item loses this when a word repeats.
    if (
        words.length === 0 ||
        words.length > MAX_GLOSSARY_QUERY_TOKENS ||
        words.some((word) => [...word].length > MAX_INDEX_TOKEN_CODEPOINTS)
    ) {
        // Otherwise a long non-final word is silently discarded by the token
        // index, yielding false matches for the remaining short words.
        return null;
    }
    const prefix = words[words.length - 1];
    if ([...prefix].length < MIN_INDEX_TOKEN_CODEPOINTS) { return null; }
    const phrase = words.join(' ');
    const uniqueTokens = glossarySearchTokensFromText(phrase);
    // Keep required tokens distinct for the posting-list HAVING count.
    const tokens = [...uniqueTokens.filter((token) => token !== prefix), prefix];
    return {folded, phrase, tokens, prefix};
}

/**
 * Upper bound for a binary-collated prefix range.
 * @param {string} prefix
 * @returns {string|null}
 */
export function glossaryPrefixUpperBound(prefix) {
    const points = [...prefix];
    for (let i = points.length - 1; i >= 0; --i) {
        const value = points[i].codePointAt(0);
        if (typeof value !== 'number' || value >= 0x10ffff) { continue; }
        points[i] = String.fromCodePoint(value + 1);
        return points.slice(0, i + 1).join('');
    }
    return null;
}

/**
 * @param {unknown} glossary
 * @param {{phrase: string, tokens: string[], prefix: string}} query
 * @returns {{tier: number, phraseIndex: number}|null}
 */
export function scoreGlossarySearchMatch(glossary, query) {
    const plain = foldGlossarySearchText(glossarySearchText(glossary))
        .replace(/[^\p{L}\p{N}']+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (plain.length === 0) { return null; }
    // A phrase match requires complete tokens at both edges. A live prefix
    // inside a longer final token belongs to the prefix tier.
    const phraseIndex = query.phrase.length > 0 ?
        ` ${plain} `.indexOf(` ${query.phrase} `) :
        -1;
    const tokens = glossarySearchTokensFromText(plain);
    const tokenSet = new Set(tokens);
    const required = query.tokens.slice(0, -1);
    if (required.some((token) => !tokenSet.has(token))) { return null; }
    const final = query.tokens.at(-1);
    if (typeof final !== 'string') { return null; }
    if (phraseIndex >= 0) { return {tier: 0, phraseIndex}; }
    if (tokenSet.has(final)) { return {tier: 1, phraseIndex: Number.MAX_SAFE_INTEGER}; }
    if (tokens.some((token) => token.startsWith(query.prefix))) {
        return {tier: 2, phraseIndex: Number.MAX_SAFE_INTEGER};
    }
    return null;
}
