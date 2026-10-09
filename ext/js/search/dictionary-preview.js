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
/**
 * Only traverse text-bearing glossary fields, not CSS, links or image data.
 * The explicit stack, character, depth and node budgets apply before cloning
 * into the host. This is a presentation bound, not a decoder-allocation bound.
 * @param {unknown} value
 * @param {number} [maximum]
 * @returns {string}
 */
export function glossaryPreview(value, maximum = 220) {
    maximum = Math.max(1, Math.min(220, Math.trunc(maximum) || 220));
    const stack = [{value, depth: 0}];
    let output = '',
        visited = 0,
        omitted = false;
    while (stack.length > 0 && visited++ < 256 && output.length <= maximum) {
        const item = stack.pop();
        if (!item || item.depth > 24) {
            // Malformed/cyclic nested content still yields no preview text.
            continue;
        }
        const content = item.value;
        if (typeof content === 'string') {
            output += content.slice(0, maximum + 1) + ' ';
        } else if (Array.isArray(content)) {
            const permitted = Math.max(0, Math.min(content.length, 256 - visited, 256 - stack.length));
            if (permitted < content.length) {omitted = true;}
            for (let index = permitted - 1; index >= 0; --index) {
                stack.push({value: content[index], depth: item.depth + 1});
            }
        } else if (content && typeof content === 'object') {
            const node = /** @type {Record<string, unknown>} */ (content);
            if (node.type === 'image' || node.tag === 'img' || node.tag === 'rt' || node.tag === 'rp') {
                continue;
            }
            if (typeof node.text === 'string') {
                stack.push({value: node.text, depth: item.depth + 1});
            } else if ('content' in node) {
                stack.push({value: node.content, depth: item.depth + 1});
            }
        }
    }
    output = output.replace(/\s+/g, ' ').trim();
    const truncated = omitted || output.length > maximum || stack.length > 0;
    let clipped = output.slice(0, maximum);
    if (/[\uD800-\uDBFF]$/.test(clipped)) {
        clipped = clipped.slice(0, -1);
    }
    return clipped + (truncated ? '…' : '');
}

/**
 * Keep UTF-16 display limits without cutting a supplementary character in half.
 * @param {string} value
 * @param {number} maximum
 * @returns {string}
 */
function clipPreviewText(value, maximum) {
    const clipped = value.slice(0, maximum);
    return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

/**
 * @param {import('dictionary').TermDictionaryEntry[]} entries
 * @returns {{items: {id: string, term: string, reading: string, senses: {source: string, text: string, tags: string[]}[]}[], hasMore: boolean}}
 */
export function dictionaryPreview(entries) {
    const items = [];
    for (const entry of entries.slice(0, 2)) {
        const headword = entry.headwords[0];
        if (!headword) {
            continue;
        }
        const senses = [];
        // Respect definition/headword restrictions instead of pairing the first
        // gloss for another spelling with this preview's visible headword.
        for (const definition of entry.definitions.slice(0, 16)) {
            if (definition.headwordIndices.length > 0 && !definition.headwordIndices.includes(headword.headwordIndex)) {
                continue;
            }
            const text = glossaryPreview(definition.entries);
            if (text) {
                senses.push({source: clipPreviewText(definition.dictionary, 256), text, tags: definition.tags.slice(0, 4).map((tag) => clipPreviewText(tag.name, 40))});
            }
            if (senses.length === 2) {
                break;
            }
        }
        const definition = entry.definitions[0];
        const term = clipPreviewText(headword.term, 256);
        const reading = clipPreviewText(headword.reading, 256);
        items.push({id: JSON.stringify([items.length, definition ? clipPreviewText(definition.dictionary, 256) : undefined, definition?.id, term, reading]),
            term,
            reading,
            senses});
    }
    return {items, hasMore: entries.length > 2};
}
