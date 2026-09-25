/*
 * Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 * This program is distributed WITHOUT ANY WARRANTY; see the repository license.
 */

const ATTRIBUTE = 'data-reader-lookup';
const CONTEXT_ATTRIBUTE = 'data-reader-lookup-context';
const INTERACTIVE = 'a,button,input,textarea,select,option,[role="button"],[contenteditable]:not([contenteditable="false"])';

/** @typedef {{protocol: 1, term: string, reading: string, surface: string, sentence: string, offset: number, namespace?: string, entryID?: string, segmentID?: string}} ReaderLookup */

/** Generic DOCUMENT exchange, not a binary-plugin or extension-internal API.
 * No proprietary code, engine dependency, SQL access, filesystem access, or
 * automatic Anki writes are exposed through this bridge.
 * @param {string} raw
 * @param {string|null} [contextRaw]
 * @returns {ReaderLookup|null}
 */
export function parseReaderLookup(raw, contextRaw = null) {
    if (typeof raw !== 'string' || raw.length > 32768) { return null; }
    let value;
    try { value = JSON.parse(raw); } catch { return null; }
    if (typeof value?.contextID !== 'undefined') {
        if (typeof value.contextID !== 'string' || value.contextID.length === 0 || value.contextID.length > 512 ||
            typeof value.sentence !== 'undefined' || typeof contextRaw !== 'string' || contextRaw.length > 65536) { return null; }
        let context;
        try { context = JSON.parse(contextRaw); } catch { return null; }
        if (context?.protocol !== 1 || context.id !== value.contextID || typeof context.text !== 'string') { return null; }
        value = {...value, sentence: context.text};
    }
    if (value?.protocol !== 1 || typeof value.term !== 'string' || value.term.length === 0 || value.term.length > 512 ||
        typeof value.reading !== 'string' || value.reading.length === 0 || value.reading.length > 512 ||
        typeof value.surface !== 'string' || value.surface.length === 0 || value.surface.length > 2048 ||
        typeof value.sentence !== 'string' || value.sentence.length > 16384 ||
        !Number.isSafeInteger(value.offset) || value.offset < 0 ||
        value.sentence.slice(value.offset, value.offset + value.surface.length) !== value.surface) { return null; }
    if (typeof value.namespace !== 'undefined' && !['jmdict', 'jmnedict'].includes(value.namespace)) { return null; }
    if (typeof value.entryID !== 'undefined' && (typeof value.entryID !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.entryID))) { return null; }
    return {protocol: 1, term: value.term, reading: value.reading, surface: value.surface,
        sentence: value.sentence, offset: value.offset,
        ...(typeof value.namespace === 'string' ? {namespace: value.namespace} : {}),
        ...(typeof value.entryID === 'string' ? {entryID: value.entryID} : {})};
}

export function exactReaderEntries(entries, request) {
    const output = [];
    for (const entry of entries) {
        const matches = entry.headwords.filter(({term, reading}) => term === request.term && reading === request.reading);
        if (matches.length === 0) { continue; }
        if (matches.length === entry.headwords.length) { output.push(entry); continue; }
        if (!Array.isArray(entry.definitions) || !Array.isArray(entry.frequencies) || !Array.isArray(entry.pronunciations) ||
            new Set(entry.headwords.map(({index}) => index)).size !== entry.headwords.length ||
            entry.headwords.some(({index}, i) => index !== i)) { continue; }
        const indexMap = new Map(matches.map((word, index) => [word.index, index]));
        const headwords = matches.map((word, index) => ({...word, index}));
        const definitions = entry.definitions.flatMap((definition) => {
            if (!Array.isArray(definition.headwordIndices) || definition.headwordIndices.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= entry.headwords.length)) { return []; }
            const headwordIndices = [...new Set(definition.headwordIndices.filter((i) => indexMap.has(i)).map((i) => /** @type {number} */ (indexMap.get(i))))];
            return headwordIndices.length === 0 ? [] : [{...definition, headwordIndices}];
        }).map((definition, index) => ({...definition, index}));
        if (definitions.length === 0) { continue; }
        const frequencies = entry.frequencies.filter(({headwordIndex}) => indexMap.has(headwordIndex))
            .map((item, index) => ({...item, index, headwordIndex: /** @type {number} */ (indexMap.get(item.headwordIndex))}));
        const pronunciations = entry.pronunciations.filter(({headwordIndex}) => indexMap.has(headwordIndex))
            .map((item, index) => ({...item, index, headwordIndex: /** @type {number} */ (indexMap.get(item.headwordIndex))}));
        const primary = headwords.some((word) => word.sources.some((source) => source.isPrimary));
        const firstDictionary = definitions.reduce((a, b) => a.dictionaryIndex <= b.dictionaryIndex ? a : b);
        output.push({...entry, headwords, definitions, frequencies, pronunciations,
            isPrimary: primary, matchPrimaryReading: true,
            sourceTermExactMatchCount: headwords.reduce((n, word) => n + word.sources.filter((source) => source.isPrimary && source.matchType === 'exact').length, 0),
            dictionaryIndex: firstDictionary.dictionaryIndex, dictionaryAlias: firstDictionary.dictionaryAlias,
            score: Math.max(...definitions.map((d) => d.score)),
            frequencyOrder: Math.min(...definitions.map((d) => d.frequencyOrder)),
            textProcessorRuleChainCandidates: [], inflectionRuleChainCandidates: []});
    }
    return output;
}

export function readerEntriesWithSurface(entries, request) {
    return entries.map((entry) => ({
        ...entry,
        maxOriginalTextLength: request.surface.length,
        headwords: entry.headwords.map((headword) => ({
            ...headword,
            sources: headword.sources.map((source) => source.isPrimary ? {...source, originalText: request.surface} : source),
        })),
    }));
}

function baseTextPosition(root, anchor = null) {
    const parts = [];
    let length = 0, start = null, end = null;
    const stack = [{node: root, exiting: false}];
    while (stack.length > 0) {
        const {node, exiting} = /** @type {{node: Node, exiting: boolean}} */ (stack.pop());
        if (exiting) { if (node === anchor) { end = length; } continue; }
        if (node.nodeType === 1 && ['RT', 'RP', 'RTC', 'SCRIPT', 'STYLE'].includes(/** @type {Element} */ (node).tagName.toUpperCase())) { continue; }
        if (node === anchor) { start = length; }
        if (node.nodeType === 3) { const text = node.nodeValue ?? ''; parts.push(text); length += text.length; }
        else {
            stack.push({node, exiting: true});
            for (let i = node.childNodes.length - 1; i >= 0; --i) { stack.push({node: node.childNodes[i], exiting: false}); }
        }
    }
    return {text: parts.join(''), start, end};
}
function surfaceText(node) { return baseTextPosition(node).text; }
function contextMatches(context, anchor, request) {
    if (context === null) { return true; }
    const actual = baseTextPosition(context, anchor);
    return actual.text === request.sentence && actual.start === request.offset && actual.end === request.offset + request.surface.length;
}

export class ReaderLookupBridge {
    constructor({document, enabled, show, invalidateSearch, report = () => {}}) {
        this._document = document;
        this._enabled = enabled;
        this._show = show;
        this._invalidateSearch = invalidateSearch;
        this._report = report;
        this._sequence = 0;
        this._disposed = false;
        this._down = null;
        this._onDown = this._pointerDown.bind(this);
        this._onClick = this._click.bind(this);
        this._onMove = this._pointerMove.bind(this);
        this._onCancel = () => { this._down = null; };
        this._onPageHide = () => { this.invalidate(); this._down = null; };
        document.defaultView?.addEventListener('pagehide', this._onPageHide);
        document.addEventListener('pointerdown', this._onDown, true);
        document.addEventListener('pointercancel', this._onCancel, true);
        document.addEventListener('pointermove', this._onMove, true);
        document.addEventListener('click', this._onClick, true);
    }
    _target(node, verifyContext = true) {
        if (!this._enabled() || this._disposed || node?.closest(INTERACTIVE)) { return null; }
        const anchor = node?.closest(`[${ATTRIBUTE}]`);
        if (!anchor?.isConnected) { return null; }
        const context = anchor.closest(`[${CONTEXT_ATTRIBUTE}]`);
        const contextRaw = context?.getAttribute(CONTEXT_ATTRIBUTE) ?? null;
        const request = parseReaderLookup(anchor.getAttribute(ATTRIBUTE) ?? '', contextRaw);
        if (!request || surfaceText(anchor) !== request.surface) { return null; }
        if (verifyContext && !contextMatches(context, anchor, request)) { return null; }
        return {anchor, request, context, contextRaw};
    }
    ownsPoint(x, y) { return this._target(this._document.elementFromPoint(x, y)) !== null; }
    _pointerDown(event) {
        this._down = null;
        if (!event.isTrusted || event.button !== 0 || !event.isPrimary) { return; }
        const target = this._target(event.target instanceof Element ? event.target : null);
        if (target) { this._down = {x: event.clientX, y: event.clientY, target: target.anchor, time: event.timeStamp}; }
    }
    _pointerMove(event) {
        if (this._down && event.isTrusted && Math.hypot(event.clientX - this._down.x, event.clientY - this._down.y) > 8) { this._down = null; }
    }
    _click(event) {
        const down = this._down;
        this._down = null;
        if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
            this._document.getSelection()?.isCollapsed === false) { return; }
        const target = this._target(event.target instanceof Element ? event.target : null);
        if (!target) { this.invalidate(); return; }
        if (event.detail !== 0 && (!down || down.target !== target.anchor ||
            Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8 || event.timeStamp - down.time > 700)) { return; }
        const raw = target.anchor.getAttribute(ATTRIBUTE);
        const sequence = ++this._sequence;
        const isCurrent = () => !this._disposed && this._enabled() && sequence === this._sequence &&
            target.anchor.isConnected && target.anchor.getAttribute(ATTRIBUTE) === raw && surfaceText(target.anchor) === target.request.surface &&
            (target.context === null || (target.context.isConnected && target.context.contains(target.anchor) &&
                target.context.getAttribute(CONTEXT_ATTRIBUTE) === target.contextRaw && contextMatches(target.context, target.anchor, target.request)));
        event.preventDefault(); event.stopImmediatePropagation();
        this._invalidateSearch();
        void this._show(target.request, target.anchor, isCurrent).catch(() => {
            if (isCurrent()) { try { this._report('lookup-failed'); } catch {} }
        });
    }
    invalidate() { ++this._sequence; }
    dispose() {
        if (this._disposed) { return; }
        this._disposed = true; this.invalidate(); this._down = null;
        this._document.defaultView?.removeEventListener('pagehide', this._onPageHide);
        this._document.removeEventListener('pointerdown', this._onDown, true);
        this._document.removeEventListener('pointercancel', this._onCancel, true);
        this._document.removeEventListener('pointermove', this._onMove, true);
        this._document.removeEventListener('click', this._onClick, true);
    }
}
