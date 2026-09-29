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
import {convertToHiragana} from '../language/ja/japanese-wanakana.js';

/**
 * Search alternatives, not a transliteration of the user's editable text.
 * Keep literal spelling first, preserve Han compatibility characters, and bound
 * ambiguous long-vowel expansion. Use the existing converter/deinflector.
 * @param {string} value
 * @throws {RangeError} The query exceeds the length limit or contains NUL.
 * @returns {string[]}
 */
export function japaneseSearchQueries(value) {
    let characters = 0;
    for (const _character of value) {
        if (++characters > 256) {
            throw new RangeError('Use a dictionary query of 256 characters or fewer.');
        }
    }
    if (value.includes('\0')) {
        throw new RangeError('Use a dictionary query of 256 characters or fewer.');
    }
    const raw = value.trim();
    if (!raw) {
        return [];
    }
    const result = [raw];
    const normalized = raw.replace(/[^\uF900-\uFAFF\u{2F800}-\u{2FA1F}]+/gu, (part) => part.normalize('NFC')).replace(/[\uff01-\uff9f]+/g, (part) => part.normalize('NFKC'));
    /** @param {string} text */
    const add = (text) => {
        if (text && !result.includes(text) && result.length < 8) {
            result.push(text);
        }
    };
    add(normalized);
    if (!/[a-zāīūēōâîûêô]/i.test(normalized)) {
        return result;
    }
    /** @type {Record<string, string[]>} */
    const vowels = {ā: ['aa'], â: ['aa'], ī: ['ii'], î: ['ii'], ū: ['uu'], û: ['uu'], ē: ['ee', 'ei'], ê: ['ee', 'ei'], ō: ['ou', 'oo'], ô: ['ou', 'oo']};
    let alternatives = [''];
    for (const character of normalized.toLowerCase().replace(/[’ʼ]/g, "'")) {
        const expansions = vowels[character] ?? [character];
        alternatives = alternatives.flatMap((prefix) => expansions.map((suffix) => prefix + suffix)).slice(0, 6);
    }
    for (const alternative of alternatives) {
        const kana = convertToHiragana(alternative);
        // Do not turn English or an unfinished romaji syllable into a different
        // partial Japanese query by stripping its remaining Latin characters.
        if (!/[a-zāīūēōâîûêô]/i.test(kana)) {
            add(kana);
        }
    }
    return result;
}

/**
 * Prefix fallback is deliberately conservative: at least two Japanese code
 * points and no remaining Latin letters. This lets completed kana converted
 * from romaji participate without interpreting arbitrary English as Japanese.
 * @param {string} query
 * @returns {boolean}
 */
export function isJapanesePrefixCandidate(query) {
    return [...query].length >= 2 &&
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(query) &&
    !/[a-zāīūēōâîûêô]/i.test(query);
}

/**
 * Exact/deinflected results retain the translator's ordering. Only try spelling
 * alternatives when the literal query has no result; never fuse homophones or
 * override an installed dictionary's lexical identities with a surface key.
 *
 * An optional prefix lookup runs only after every exact/deinflected candidate
 * fails to cover its full query. The translator can return a shorter leading
 * word for an unfinished query; retain that result if completion also misses.
 * @template {{dictionaryEntries: unknown[], originalTextLength?: number}} T
 * @param {string} text
 * @param {(query: string) => Promise<T>} lookup
 * @param {() => void} [guard]
 * @param {((query: string) => Promise<T>) | null} [prefixLookup]
 * @returns {Promise<{result: T|null, matchedQuery: string, matchType: 'exact'|'prefix'}>}
 */
export async function findJapaneseSearch(text, lookup, guard = () => {}, prefixLookup = null) {
    const queries = japaneseSearchQueries(text);
    /** @type {{result: T, matchedQuery: string, matchType: 'exact'} | null} */
    let leadingResult = null;
    for (const query of queries) {
        guard();
        const result = await lookup(query);
        guard();
        if (result.dictionaryEntries.length > 0) {
            // Older callers and test doubles do not provide the translator's
            // span, so keep their established first-hit behavior.
            if (prefixLookup === null || typeof result.originalTextLength !== 'number' || result.originalTextLength >= query.length) {
                return {result, matchedQuery: query, matchType: 'exact'};
            }
            leadingResult ??= {result, matchedQuery: query, matchType: 'exact'};
        }
    }
    if (prefixLookup !== null) {
        for (const query of queries) {
            if (!isJapanesePrefixCandidate(query) || query.endsWith('*')) {
                continue;
            }
            guard();
            const result = await prefixLookup(query);
            guard();
            if (result.dictionaryEntries.length > 0) {
                return {result, matchedQuery: query, matchType: 'prefix'};
            }
        }
    }
    return leadingResult ?? {result: null, matchedQuery: text.trim(), matchType: 'exact'};
}
