/* SPDX-License-Identifier: GPL-3.0-or-later */
import {convertToHiragana} from '../language/ja/japanese-wanakana.js';

/**
 * Search alternatives, not a transliteration of the user's editable text.
 * Keep literal spelling first, preserve Han compatibility characters, and bound
 * ambiguous long-vowel expansion. Use the existing converter/deinflector.
 * @param {string} value
 * @returns {string[]}
 */
export function japaneseSearchQueries(value) {
    if (value.length > 256 || value.includes('\0')) {throw new RangeError('Use a dictionary query of 256 characters or fewer.');}
    const raw = value.trim();
    if (!raw) {return [];}
    const result = [raw];
    const normalized = raw.replace(/[^\uF900-\uFAFF\u{2F800}-\u{2FA1F}]+/gu, (part) => part.normalize('NFC')).replace(/[\uff01-\uff9f]+/g, (part) => part.normalize('NFKC'));
    /** @param {string} text */
    const add = (text) => {if (text && !result.includes(text) && result.length < 8) {result.push(text);}};
    add(normalized);
    if (!/[a-zāīūēōâîûêô]/i.test(normalized)) {return result;}
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
        if (!/[a-zāīūēōâîûêô]/i.test(kana)) {add(kana);}
    }
    return result;
}

/**
 * Exact/deinflected results retain the translator's ordering. Only try spelling
 * alternatives when the literal query has no result; never fuse homophones or
 * override an installed dictionary's lexical identities with a surface key.
 * @template {{dictionaryEntries: unknown[]}} T
 * @param {string} text
 * @param {(query: string) => Promise<T>} lookup
 * @param {() => void} [guard]
 * @returns {Promise<{result: T|null, matchedQuery: string}>}
 */
export async function findJapaneseSearch(text, lookup, guard = () => {}) {
    for (const query of japaneseSearchQueries(text)) {
        guard();
        const result = await lookup(query);
        guard();
        if (result.dictionaryEntries.length > 0) {return {result, matchedQuery: query};}
    }
    return {result: null, matchedQuery: text.trim()};
}
