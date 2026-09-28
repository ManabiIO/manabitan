/* SPDX-License-Identifier: GPL-3.0-or-later */

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
    let output = '', visited = 0;
    while (stack.length && visited++ < 256 && output.length <= maximum) {
        const item = stack.pop();
        if (!item || item.depth > 24) {continue;}
        const content = item.value;
        if (typeof content === 'string') {
            output += content.slice(0, maximum + 1) + ' ';
        } else if (Array.isArray(content)) {
            for (let index = Math.min(content.length, 256 - visited, 256 - stack.length) - 1; index >= 0; --index) {
                stack.push({value: content[index], depth: item.depth + 1});
            }
        } else if (content && typeof content === 'object') {
            const node = /** @type {Record<string, unknown>} */ (content);
            if (node.type === 'image' || node.tag === 'img' || node.tag === 'rt' || node.tag === 'rp') {continue;}
            if (typeof node.text === 'string') {stack.push({value: node.text, depth: item.depth + 1});}
            else if ('content' in node) {stack.push({value: node.content, depth: item.depth + 1});}
        }
    }
    output = output.replace(/\s+/g, ' ').trim();
    const truncated = output.length > maximum || stack.length > 0;
    let clipped = output.slice(0, maximum);
    if (/[\uD800-\uDBFF]$/.test(clipped)) {clipped = clipped.slice(0, -1);}
    return clipped + (truncated ? '…' : '');
}

/**
 * @param {import('dictionary').TermDictionaryEntry[]} entries
 * @returns {{items: {id: string, term: string, reading: string, senses: {source: string, text: string, tags: string[]}[]}[], hasMore: boolean}}
 */
export function dictionaryPreview(entries) {
    const items = [];
    for (const entry of entries.slice(0, 2)) {
        const headword = entry.headwords[0];
        if (!headword) {continue;}
        const senses = [];
        // Respect definition/headword restrictions instead of pairing the first
        // gloss for another spelling with this preview's visible headword.
        for (const definition of entry.definitions.slice(0, 16)) {
            if (definition.headwordIndices.length && !definition.headwordIndices.includes(headword.headwordIndex)) {continue;}
            const text = glossaryPreview(definition.entries);
            if (text) {
                senses.push({source: definition.dictionary.slice(0, 256), text, tags: definition.tags.slice(0, 4).map((tag) => tag.name.slice(0, 40))});
            }
            if (senses.length === 2) {break;}
        }
        const definition = entry.definitions[0];
        items.push({id: JSON.stringify([definition?.dictionary.slice(0, 256), definition?.id, headword.term.slice(0, 256), headword.reading.slice(0, 256)]),
            term: headword.term.slice(0, 256), reading: headword.reading.slice(0, 256), senses});
    }
    return {items, hasMore: entries.length > 2};
}
