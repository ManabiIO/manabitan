/*
 * Copyright (C) 2026  Manabitan authors
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

import {parseJson} from '../core/json.js';

const ATTRIBUTE = 'data-reader-lookup';
const CONTEXT_ATTRIBUTE = 'data-reader-lookup-context';
const INTERACTIVE = 'a,button,input,textarea,select,option,[role="button"],[contenteditable]:not([contenteditable="false"])';

/** @typedef {{protocol: 1, term: string, reading: string, surface: string, sentence: string, offset: number, namespace?: string, entryID?: string, segmentID?: string}} ReaderLookup */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Generic DOCUMENT exchange, not a binary-plugin or extension-internal API.
 * No proprietary code, engine dependency, SQL access, filesystem access, or
 * automatic Anki writes are exposed through this bridge.
 * @param {string} raw
 * @param {string|null} [contextRaw]
 * @returns {ReaderLookup|null}
 */
export function parseReaderLookup(raw, contextRaw = null) {
    if (typeof raw !== 'string' || raw.length > 32768) { return null; }
    /** @type {unknown} */
    let parsed;
    try {
        parsed = parseJson(raw);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) { return null; }
    let value = parsed;
    // Generic document exchange: each source sentence can live once on its
    // owning element instead of being copied into every word's attribute.
    if (typeof value?.contextID !== 'undefined') {
        if (typeof value.contextID !== 'string' || value.contextID.length === 0 || value.contextID.length > 512 ||
        typeof value.sentence !== 'undefined' || typeof contextRaw !== 'string' || contextRaw.length > 65536) { return null; }
        /** @type {unknown} */
        let context;
        try {
            context = parseJson(contextRaw);
        } catch {
            return null;
        }
        if (!isRecord(context) || context.protocol !== 1 || context.id !== value.contextID || typeof context.text !== 'string') { return null; }
        value = {...value, sentence: context.text};
    }
    if (value?.protocol !== 1 || typeof value.term !== 'string' || value.term.length === 0 || value.term.length > 512 ||
    typeof value.reading !== 'string' || value.reading.length === 0 || value.reading.length > 512 ||
    typeof value.surface !== 'string' || value.surface.length === 0 || value.surface.length > 2048 ||
    typeof value.sentence !== 'string' || value.sentence.length > 16384 ||
    typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 ||
    value.sentence.slice(value.offset, value.offset + value.surface.length) !== value.surface) { return null; }
    // Native sequence/namespace are provenance, NOT Manabitan database row IDs.
    if (typeof value.namespace !== 'undefined' && !['jmdict', 'jmnedict'].includes(value.namespace)) { return null; }
    if (typeof value.entryID !== 'undefined' && (typeof value.entryID !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.entryID))) { return null; }
    return {protocol: 1,
        term: value.term,
        reading: value.reading,
        surface: value.surface,
        sentence: value.sentence,
        offset: value.offset,
        ...(typeof value.namespace === 'string' ? {namespace: value.namespace} : {}),
        ...(typeof value.entryID === 'string' ? {entryID: value.entryID} : {})};
}

/**
 * Project exact lexical forms out of merged groups. Never pass unrelated
 * first headwords to the popup/Anki builder. Native entry IDs remain provenance,
 * not a universal cross-dictionary sense/row mapping.
 * @param {import('dictionary').TermDictionaryEntry[]} entries
 * @param {ReaderLookup} request
 * @returns {import('dictionary').TermDictionaryEntry[]}
 */
export function exactReaderEntries(entries, request) {
    const output = [];
    for (const entry of entries) {
        const matches = entry.headwords.filter(({term, reading}) => term === request.term && reading === request.reading);
        if (matches.length === 0) { continue; }
        if (matches.length === entry.headwords.length) {
            output.push(entry);
            continue;
        }
        // Indexes, not textual headword equality, own auxiliary relationships.
        // Reject malformed or future shapes instead of guessing at that binding.
        if (!Array.isArray(entry.definitions) || !Array.isArray(entry.frequencies) || !Array.isArray(entry.pronunciations) ||
        new Set(entry.headwords.map(({headwordIndex}) => headwordIndex)).size !== entry.headwords.length ||
        entry.headwords.some(({headwordIndex}, i) => headwordIndex !== i)) { continue; }
        const indexMap = new Map(matches.map((word, index) => [word.headwordIndex, index]));
        const headwords = matches.map((word, headwordIndex) => ({...word, headwordIndex}));
        const definitions = entry.definitions.flatMap((definition) => {
            if (!Array.isArray(definition.headwordIndices) || definition.headwordIndices.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= entry.headwords.length)) { return []; }
            const headwordIndices = [...new Set(definition.headwordIndices.filter((i) => indexMap.has(i)).map((i) => /** @type {number} */ (indexMap.get(i))))];
            return headwordIndices.length === 0 ? [] : [{...definition, headwordIndices}];
        });
        if (definitions.length === 0) { continue; }
        const frequencies = entry.frequencies.filter(({headwordIndex}) => indexMap.has(headwordIndex))
            .map((item) => ({...item, headwordIndex: /** @type {number} */ (indexMap.get(item.headwordIndex))}));
        const pronunciations = entry.pronunciations.filter(({headwordIndex}) => indexMap.has(headwordIndex))
            .map((item) => ({...item, headwordIndex: /** @type {number} */ (indexMap.get(item.headwordIndex))}));
        const primary = headwords.some((word) => word.sources.some((source) => source.isPrimary));
        let firstDictionary = definitions[0];
        let score = -Infinity;
        let frequencyOrder = Infinity;
        for (const definition of definitions) {
            if (definition.dictionaryIndex < firstDictionary.dictionaryIndex) { firstDictionary = definition; }
            score = Math.max(score, definition.score);
            frequencyOrder = Math.min(frequencyOrder, definition.frequencyOrder);
        }
        output.push({...entry,
            headwords,
            definitions,
            frequencies,
            pronunciations,
            isPrimary: primary,
            matchPrimaryReading: true,
            sourceTermExactMatchCount: headwords.flatMap((word) => word.sources).filter((source) => source.isPrimary && source.matchType === 'exact').length,
            dictionaryIndex: firstDictionary.dictionaryIndex,
            dictionaryAlias: firstDictionary.dictionaryAlias,
            score,
            frequencyOrder,
            // These chains describe the original group, not the selected subset.
            // The request is already canonical; don't invent an inflection proof.
            textProcessorRuleChainCandidates: [],
            inflectionRuleChainCandidates: []});
    }
    return output;
}

/**
 * Preserve the real inflected source span used by sentence/cloze templates.
 * Queries use the canonical term, but that term may have a different length.
 * @param {import('dictionary').TermDictionaryEntry[]} entries
 * @param {ReaderLookup} request
 * @returns {import('dictionary').TermDictionaryEntry[]}
 */
export function readerEntriesWithSurface(entries, request) {
    return entries.map((entry) => ({
        ...entry,
        maxOriginalTextLength: request.surface.length,
        headwords: entry.headwords.map((headword) => ({
            ...headword,
            sources: headword.sources.map((source) => (source.isPrimary ? {...source, originalText: request.surface} : source)),
        })),
    }));
}

/**
 * One iterative base-text pass also establishes the ACTUAL UTF-16 offset.
 * Repeated identical words are not interchangeable occurrences.
 * @param {Node} root
 * @param {Node|null} [anchor]
 * @returns {{text: string, start: number|null, end: number|null}}
 */
function baseTextPosition(root, anchor = null) {
    const parts = [];
    let length = 0;
    let start = null;
    let end = null;
    const stack = [{node: root, exiting: false}];
    while (stack.length > 0) {
        const {node, exiting} = /** @type {{node: Node, exiting: boolean}} */ (stack.pop());
        if (exiting) {
            if (node === anchor) { end = length; }
            continue;
        }
        if (node.nodeType === 1 && ['RT', 'RP', 'RTC', 'SCRIPT', 'STYLE'].includes(/** @type {Element} */ (node).tagName.toUpperCase())) { continue; }
        if (node === anchor) { start = length; }
        if (node.nodeType === 3) {
            const text = node.nodeValue ?? '';
            parts.push(text);
            length += text.length;
        } else {
            stack.push({node, exiting: true});
            for (let i = node.childNodes.length - 1; i >= 0; --i) { stack.push({node: node.childNodes[i], exiting: false}); }
        }
    }
    return {text: parts.join(''), start, end};
}
/**
 * @param {Node} node
 * @returns {string}
 */
function surfaceText(node) { return baseTextPosition(node).text; }

/**
 * @param {Element|null} context
 * @param {Element} anchor
 * @param {ReaderLookup} request
 * @returns {boolean}
 */
function contextMatches(context, anchor, request) {
    if (context === null) { return true; } // Original full-sentence protocol.
    const actual = baseTextPosition(context, anchor);
    return actual.text === request.sentence && actual.start === request.offset && actual.end === request.offset + request.surface.length;
}

export class ReaderLookupBridge {
    /**
     * @param {{document: Document, enabled: () => boolean, show: (request: ReaderLookup, anchor: Element, isCurrent: () => boolean) => Promise<void>, invalidateSearch: () => void, report?: (status: string) => void}} options
     */
    constructor({document, enabled, show, invalidateSearch, report = () => {}}) {
        /** @type {Document} */
        this._document = document;
        /** @type {() => boolean} */
        this._enabled = enabled;
        /** @type {(request: ReaderLookup, anchor: Element, isCurrent: () => boolean) => Promise<void>} */
        this._show = show;
        /** @type {() => void} */
        this._invalidateSearch = invalidateSearch;
        /** @type {(status: string) => void} */
        this._report = report;
        /** @type {number} */
        this._sequence = 0;
        /** @type {boolean} */
        this._disposed = false;
        /** @type {{x: number, y: number, target: Element, time: number}|null} */
        this._down = null;
        /** @type {(event: PointerEvent) => void} */
        this._onDown = this._pointerDown.bind(this);
        /** @type {(event: MouseEvent) => void} */
        this._onClick = this._click.bind(this);
        /** @type {(event: PointerEvent) => void} */
        this._onMove = this._pointerMove.bind(this);
        /** @type {() => void} */
        this._onCancel = () => { this._down = null; };
        /** @type {() => void} */
        this._onPageHide = () => {
            this.invalidate();
            this._down = null;
        };
        document.defaultView?.addEventListener('pagehide', this._onPageHide);
        document.addEventListener('pointerdown', this._onDown, true);
        document.addEventListener('pointercancel', this._onCancel, true);
        document.addEventListener('pointermove', this._onMove, true);
        document.addEventListener('click', this._onClick, true);
    }

    /**
     * @param {Element|null} node
     * @returns {{anchor: Element, request: ReaderLookup, context: Element|null, contextRaw: string|null}|null}
     */
    _target(node) {
        if (!this._enabled() || this._disposed || node?.closest(INTERACTIVE)) { return null; }
        const anchor = node?.closest(`[${ATTRIBUTE}]`);
        if (!anchor?.isConnected) { return null; }
        const context = anchor.closest(`[${CONTEXT_ATTRIBUTE}]`);
        const contextRaw = context?.getAttribute(CONTEXT_ATTRIBUTE) ?? null;
        const request = parseReaderLookup(anchor.getAttribute(ATTRIBUTE) ?? '', contextRaw);
        if (!request || surfaceText(anchor) !== request.surface) { return null; }
        // Context is data, not authority. Check it against the actual rendered
        // base text before displaying/mining a user-activated lookup.
        if (!contextMatches(context, anchor, request)) { return null; }
        return {anchor, request, context, contextRaw};
    }

    /**
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     */
    ownsPoint(x, y) {
        return this._target(this._document.elementFromPoint(x, y)) !== null;
    }

    /** @param {PointerEvent} event */
    _pointerDown(event) {
        this._down = null;
        if (!event.isTrusted || event.button !== 0 || !event.isPrimary) { return; }
        const target = this._target(event.target instanceof Element ? event.target : null);
        if (target) { this._down = {x: event.clientX, y: event.clientY, target: target.anchor, time: event.timeStamp}; }
    }

    /** @param {PointerEvent} event */
    _pointerMove(event) {
        if (this._down && event.isTrusted && Math.hypot(event.clientX - this._down.x, event.clientY - this._down.y) > 8) { this._down = null; }
    }

    /** @param {MouseEvent} event */
    _click(event) {
        const down = this._down;
        this._down = null;
        if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        this._document.getSelection()?.isCollapsed === false) { return; }
        const target = this._target(event.target instanceof Element ? event.target : null);
        if (!target) {
            this.invalidate();
            return;
        }
        // detail===0 allows real keyboard/assistive activation, never synthetic.
        if (event.detail !== 0 && (!down || down.target !== target.anchor ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8 || event.timeStamp - down.time > 700)) { return; }
        const raw = target.anchor.getAttribute(ATTRIBUTE);
        const sequence = ++this._sequence;
        const isCurrent = () => !this._disposed && this._enabled() && sequence === this._sequence &&
        target.anchor.isConnected && target.anchor.getAttribute(ATTRIBUTE) === raw && surfaceText(target.anchor) === target.request.surface &&
        (target.context === null || (target.context.isConnected && target.context.contains(target.anchor) &&
        target.context.getAttribute(CONTEXT_ATTRIBUTE) === target.contextRaw && contextMatches(target.context, target.anchor, target.request)));
        event.preventDefault();
        event.stopImmediatePropagation();
        this._invalidateSearch();
        void this._show(target.request, target.anchor, isCurrent).catch(() => {
            if (isCurrent()) {
                try { this._report('lookup-failed'); } catch { /* diagnostic only */ }
            }
        });
    }

    /** @returns {void} */
    invalidate() { ++this._sequence; }

    /** @returns {void} */
    dispose() {
        if (this._disposed) { return; }
        this._disposed = true;
        this.invalidate();
        this._down = null;
        this._document.defaultView?.removeEventListener('pagehide', this._onPageHide);
        this._document.removeEventListener('pointerdown', this._onDown, true);
        this._document.removeEventListener('pointercancel', this._onCancel, true);
        this._document.removeEventListener('pointermove', this._onMove, true);
        this._document.removeEventListener('click', this._onClick, true);
    }
}
