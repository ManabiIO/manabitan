/*
 * Copyright (C) 2026 Manabi Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
 * <https://www.gnu.org/licenses/>.
 */

const MAX_GLOSSARY_SEARCH_TEXT_CODEPOINTS = 16384;
const MAX_GLOSSARY_SEARCH_TOKENS_PER_ENTRY = 256;
const MAX_GLOSSARY_QUERY_TOKENS = 8;
const MIN_INDEX_TOKEN_CODEPOINTS = 2;
const MAX_INDEX_TOKEN_CODEPOINTS = 64;
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const JAPANESE_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const LATIN_PATTERN = /\p{Script=Latin}/u;

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
    /** @type {string[]} */
    const parts = [];
    let codepoints = 0;
    const append = (value) => {
        if (typeof value !== 'string' || codepoints >= MAX_GLOSSARY_SEARCH_TEXT_CODEPOINTS) { return; }
        const points = Array.from(value);
        const available = MAX_GLOSSARY_SEARCH_TEXT_CODEPOINTS - codepoints;
        if (available <= 0) { return; }
        parts.push(points.slice(0, available).join(''));
        codepoints += Math.min(points.length, available);
    };
    /**
     * @param {unknown} value
     * @param {number} depth
     */
    const visit = (value, depth) => {
        if (depth > 32 || value === null || typeof value === 'undefined') { return; }
        if (typeof value === 'string') {
            append(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item, depth + 1);
                if (codepoints >= MAX_GLOSSARY_SEARCH_TEXT_CODEPOINTS) { break; }
            }
            return;
        }
        if (typeof value !== 'object') { return; }
        const object = /** @type {Record<string, unknown>} */ (value);
        if (object.type === 'image') {
            visit(object.title, depth + 1);
            visit(object.description, depth + 1);
            return;
        }
        if (typeof object.text === 'string') { visit(object.text, depth + 1); }
        if (typeof object.description === 'string') { visit(object.description, depth + 1); }
        if (typeof object.title === 'string') { visit(object.title, depth + 1); }
        if ('content' in object) { visit(object.content, depth + 1); }
    };
    visit(glossary, 0);
    return parts.join(' ');
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
        const length = Array.from(token).length;
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
    const folded = foldGlossarySearchText(query.trim());
    if (
        folded.length === 0 ||
        !LATIN_PATTERN.test(folded) ||
        JAPANESE_PATTERN.test(folded)
    ) {
        return null;
    }
    const tokens = glossarySearchTokensFromText(folded).slice(0, MAX_GLOSSARY_QUERY_TOKENS);
    if (tokens.length === 0) { return null; }
    const prefix = tokens[tokens.length - 1];
    if (Array.from(prefix).length < MIN_INDEX_TOKEN_CODEPOINTS) { return null; }
    const phrase = Array.from(folded.matchAll(TOKEN_PATTERN), (match) => match[0].replace(/’/gu, "'"))
        .slice(0, MAX_GLOSSARY_QUERY_TOKENS)
        .join(' ');
    return {folded, phrase, tokens, prefix};
}

/**
 * Upper bound for a binary-collated prefix range.
 * @param {string} prefix
 * @returns {string|null}
 */
export function glossaryPrefixUpperBound(prefix) {
    const points = Array.from(prefix);
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
    const phraseIndex = query.phrase.length > 0 ? plain.indexOf(query.phrase) : -1;
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
