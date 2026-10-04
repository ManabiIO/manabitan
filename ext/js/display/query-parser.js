/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {EventDispatcher} from '../core/event-dispatcher.js';
import {ExtensionError} from '../core/extension-error.js';
import {log} from '../core/log.js';
import {trimTrailingWhitespacePlusSpace} from '../data/string-util.js';
import {querySelectorNotNull} from '../dom/query-selector.js';
import {convertHiraganaToKatakana, convertKatakanaToHiragana, isStringEntirelyKana} from '../language/ja/japanese.js';
import {TextScanner} from '../language/text-scanner.js';

/**
 * @augments EventDispatcher<import('query-parser').Events>
 */
export class QueryParser extends EventDispatcher {
    /**
     * @param {import('../comm/api.js').API} api
     * @param {import('../dom/text-source-generator').TextSourceGenerator} textSourceGenerator
     * @param {import('display').GetSearchContextCallback} getSearchContext
     */
    constructor(api, textSourceGenerator, getSearchContext) {
        super();
        /** @type {import('../comm/api.js').API} */
        this._api = api;
        /** @type {import('display').GetSearchContextCallback} */
        this._getSearchContext = getSearchContext;
        /** @type {string} */
        this._text = '';
        /** @type {?import('core').TokenObject} */
        this._setTextToken = null;
        /** @type {boolean} */
        this._needsTextUpdate = false;
        /** @type {?string} */
        this._selectedParser = null;
        /** @type {import('settings').ParsingReadingMode} */
        this._readingMode = 'none';
        /** @type {number} */
        this._scanLength = 1;
        /** @type {boolean} */
        this._useInternalParser = true;
        /** @type {boolean} */
        this._useMecabParser = false;
        /** @type {boolean} */
        this._useAllFrequencyDictionaries = false;
        /** @type {import('api').ParseTextResultItem[]} */
        this._parseResults = [];
        /** @type {HTMLElement} */
        this._queryParser = querySelectorNotNull(document, '#query-parser-content');
        /** @type {HTMLElement} */
        this._queryParserModeContainer = querySelectorNotNull(document, '#query-parser-mode-container');
        /** @type {HTMLSelectElement} */
        this._queryParserModeSelect = querySelectorNotNull(document, '#query-parser-mode-select');
        /** @type {TextScanner} */
        this._textScanner = new TextScanner({
            api,
            node: this._queryParser,
            getSearchContext,
            searchTerms: true,
            searchKanji: false,
            searchOnClick: true,
            textSourceGenerator,
            browser: null,
        });
        /** @type {?(import('../language/ja/japanese-wanakana.js'))} */
        this._japaneseWanakanaModule = null;
        /** @type {?Promise<import('../language/ja/japanese-wanakana.js')>} */
        this._japaneseWanakanaModuleImport = null;
    }

    /** @type {string} */
    get text() {
        return this._text;
    }

    /** @type {boolean} Whether a failed or invalidated parse needs a later retry. */
    get needsTextUpdate() {
        return this._needsTextUpdate;
    }

    /** */
    prepare() {
        this._textScanner.prepare();
        this._textScanner.on('clear', this._onTextScannerClear.bind(this));
        this._textScanner.on('searchSuccess', this._onSearchSuccess.bind(this));
        this._textScanner.on('searchError', this._onSearchError.bind(this));
        this._queryParserModeSelect.addEventListener('change', this._onParserChange.bind(this), false);
    }

    /**
     * @param {import('display').QueryParserOptions} display
     */
    setOptions({selectedParser, termSpacing, readingMode, useInternalParser, useMecabParser, useAllFrequencyDictionaries, language, scanning}) {
        const previousUseInternalParser = this._useInternalParser;
        const previousUseMecabParser = this._useMecabParser;
        const previousUseAllFrequencyDictionaries = this._useAllFrequencyDictionaries;
        const previousScanLength = this._scanLength;
        const previousLanguage = this._queryParser.lang;
        const previousReadingMode = this._readingMode;
        let selectedParserChanged = false;
        if (selectedParser === null || typeof selectedParser === 'string') {
            selectedParserChanged = (this._selectedParser !== selectedParser);
            this._selectedParser = selectedParser;
        }
        if (typeof termSpacing === 'boolean') {
            this._queryParser.dataset.termSpacing = `${termSpacing}`;
        }
        if (typeof readingMode === 'string') {
            this._setReadingMode(readingMode);
        }
        if (typeof useInternalParser === 'boolean') {
            this._useInternalParser = useInternalParser;
        }
        if (typeof useMecabParser === 'boolean') {
            this._useMecabParser = useMecabParser;
        }
        if (typeof useAllFrequencyDictionaries === 'boolean') {
            this._useAllFrequencyDictionaries = useAllFrequencyDictionaries;
        }
        if (scanning !== null && typeof scanning === 'object') {
            const {scanLength} = scanning;
            if (typeof scanLength === 'number') {
                this._scanLength = scanLength;
            }
            this._textScanner.language = language;
            this._textScanner.setOptions(scanning);
            this._textScanner.setEnabled(true);
        }

        const parsingEnabled = this._useInternalParser || this._useMecabParser;
        const parsingChanged = (
            previousUseInternalParser !== this._useInternalParser ||
            previousUseMecabParser !== this._useMecabParser ||
            previousUseAllFrequencyDictionaries !== this._useAllFrequencyDictionaries ||
            previousScanLength !== this._scanLength ||
            previousLanguage !== language
        );
        if (parsingChanged || !parsingEnabled) {
            this._setTextToken = null;
            this._needsTextUpdate = parsingEnabled && this._text.length > 0;
            this._setPreview(this._text);
        } else if ((selectedParserChanged || previousReadingMode !== this._readingMode) && this._parseResults.length > 0) {
            this._refreshSelectedParser(false);
            this._renderParserSelect();
            this._renderParseResult();
        }

        this._queryParser.lang = language;
    }

    /**
     * @param {string} text
     * @returns {Promise<void>}
     * @throws {Error} If the current parse or rendering fails.
     */
    async setText(text) {
        /** @type {import('core').TokenObject} */
        const token = {};
        this._setTextToken = token;
        this._needsTextUpdate = false;
        this._text = text;
        try {
            this._setPreview(text);
            if (this._useInternalParser === false && this._useMecabParser === false) { return; }
            const parseResults = await this._api.parseText(text, this._getOptionsContext(), this._scanLength, this._useInternalParser, this._useMecabParser, this._useAllFrequencyDictionaries);
            if (this._setTextToken !== token) { return; }
            this._parseResults = parseResults;
            this._refreshSelectedParser();
            this._renderParserSelect();
            this._renderParseResult();
        } catch (error) {
            if (this._setTextToken !== token) { return; }
            this._parseResults = [];
            this._needsTextUpdate = true;
            try {
                this._setPreview(text);
            } catch (e) {
                // Preserve the original failure if even the text preview cannot render.
            }
            throw error;
        }
    }

    // Private

    /** */
    _onTextScannerClear() {
        this._textScanner.clearSelection();
    }

    /**
     * @param {import('text-scanner').EventArgument<'searchSuccess'>} details
     */
    _onSearchSuccess({type, dictionaryEntries, dictionaryAvailability, sentence, inputInfo, textSource, optionsContext, pageTheme}) {
        this.trigger('searched', {
            textScanner: this._textScanner,
            type,
            dictionaryEntries,
            ...(dictionaryAvailability?.length ? {dictionaryAvailability} : {}),
            sentence,
            inputInfo,
            textSource,
            optionsContext,
            sentenceOffset: this._getSentenceOffset(textSource),
            pageTheme: pageTheme,
        });
    }

    /**
     * @param {import('text-scanner').EventArgument<'searchError'>} details
     */
    _onSearchError({error}) {
        log.error(error);
    }

    /**
     * @param {Event} e
     */
    _onParserChange(e) {
        const element = /** @type {HTMLInputElement} */ (e.currentTarget);
        const value = element.value;
        void this._setSelectedParser(value);
        this._renderParseResult();
    }

    /**
     * @returns {import('settings').OptionsContext}
     */
    _getOptionsContext() {
        return this._getSearchContext().optionsContext;
    }

    /**
     * @param {boolean} [persist] Whether a fallback should be saved, rather than applied locally.
     */
    _refreshSelectedParser(persist = true) {
        if (this._parseResults.length > 0 && !this._getParseResult()) {
            const value = this._parseResults[0].id;
            if (persist) {
                void this._setSelectedParser(value);
            } else {
                // Receiving settings must not trigger another settings broadcast.
                this._selectedParser = value;
            }
        }
    }

    /**
     * @param {string} value
     */
    async _setSelectedParser(value) {
        this._selectedParser = value;
        try {
            const optionsContext = this._getOptionsContext();
            /** @type {import('settings-modifications').ScopedModificationSet} */
            const modification = {
                action: 'set',
                path: 'parsing.selectedParser',
                value,
                scope: 'profile',
                optionsContext,
            };
            const results = await this._api.modifySettings([modification], 'search');
            for (const {error} of results) {
                if (typeof error !== 'undefined') { throw ExtensionError.deserialize(error); }
            }
        } catch (error) {
            try {
                log.error(error);
            } catch (e) {
                // A failed settings write/report cannot reject an unawaited UI handler.
            }
        }
    }

    /**
     * @returns {import('api').ParseTextResultItem|undefined}
     */
    _getParseResult() {
        const selectedParser = this._selectedParser;
        return this._parseResults.find((r) => r.id === selectedParser);
    }

    /**
     * @param {string} text
     */
    _setPreview(text) {
        this._parseResults = [];
        this._renderParserSelect();
        const terms = [[{text, reading: ''}]];
        this._queryParser.textContent = '';
        this._queryParser.dataset.parsed = 'false';
        this._queryParser.appendChild(this._createParseResult(terms));
    }

    /** */
    _renderParserSelect() {
        const visible = (this._parseResults.length > 1);
        if (visible) {
            this._updateParserModeSelect(this._queryParserModeSelect, this._parseResults, this._selectedParser);
        }
        this._queryParserModeContainer.hidden = !visible;
    }

    /** */
    _renderParseResult() {
        const parseResult = this._getParseResult();
        if (!parseResult) {
            this._setPreview(this._text);
            return;
        }
        this._queryParser.textContent = '';
        this._queryParser.dataset.parsed = 'true';
        this._queryParser.appendChild(this._createParseResult(parseResult.content));
    }

    /**
     * @param {HTMLSelectElement} select
     * @param {import('api').ParseTextResultItem[]} parseResults
     * @param {?string} selectedParser
     */
    _updateParserModeSelect(select, parseResults, selectedParser) {
        const fragment = document.createDocumentFragment();

        let index = 0;
        let selectedIndex = -1;
        for (const parseResult of parseResults) {
            const option = document.createElement('option');
            option.value = parseResult.id;
            switch (parseResult.source) {
                case 'scanning-parser':
                    option.textContent = 'Scanning parser';
                    break;
                case 'mecab':
                    option.textContent = `MeCab: ${parseResult.dictionary}`;
                    break;
                default:
                    option.textContent = `Unknown source: ${parseResult.source}`;
                    break;
            }
            fragment.appendChild(option);

            if (selectedParser === parseResult.id) {
                selectedIndex = index;
            }
            ++index;
        }

        select.textContent = '';
        select.appendChild(fragment);
        select.selectedIndex = selectedIndex;
    }

    /**
     * @param {import('api').ParseTextLine[]} data
     * @returns {DocumentFragment}
     */
    _createParseResult(data) {
        let offset = 0;
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < data.length; i++) {
            const term = data[i];
            const termNode = document.createElement('span');
            termNode.className = 'query-parser-term';
            termNode.dataset.offset = `${offset}`;
            for (const {text, reading} of term) {
                // trimEnd only for final text
                const trimmedText = i === data.length - 1 ? text.trimEnd() : trimTrailingWhitespacePlusSpace(text);
                if (reading.length === 0) {
                    termNode.appendChild(document.createTextNode(trimmedText));
                } else {
                    const reading2 = this._convertReading(trimmedText, reading);
                    termNode.appendChild(this._createSegment(trimmedText, reading2, offset));
                }
                offset += trimmedText.length;
            }
            fragment.appendChild(termNode);
        }
        return fragment;
    }

    /**
     * @param {string} text
     * @param {string} reading
     * @param {number} offset
     * @returns {HTMLElement}
     */
    _createSegment(text, reading, offset) {
        const segmentNode = document.createElement('ruby');
        segmentNode.className = 'query-parser-segment';

        const textNode = document.createElement('span');
        textNode.className = 'query-parser-segment-text';
        textNode.dataset.offset = `${offset}`;

        const readingNode = document.createElement('rt');
        readingNode.className = 'query-parser-segment-reading';

        segmentNode.appendChild(textNode);
        segmentNode.appendChild(readingNode);

        textNode.textContent = text;
        readingNode.textContent = reading;

        return segmentNode;
    }

    /**
     * Convert _reading_ to hiragana, katakana, or romaji, or _term_ if it is entirely kana and _reading_ is an empty string,  based on _readingMode.
     * @param {string} term
     * @param {string} reading
     * @returns {string}
     */
    _convertReading(term, reading) {
        switch (this._readingMode) {
            case 'hiragana':
                return convertKatakanaToHiragana(reading);
            case 'katakana':
                return convertHiraganaToKatakana(reading);
            case 'romaji':
                if (this._japaneseWanakanaModule !== null) {
                    if (reading.length > 0) {
                        return this._japaneseWanakanaModule.convertToRomaji(reading);
                    } else if (isStringEntirelyKana(term)) {
                        return this._japaneseWanakanaModule.convertToRomaji(term);
                    }
                }
                return reading;
            case 'none':
                return '';
            default:
                return reading;
        }
    }

    /**
     * @param {import('text-source').TextSource} textSource
     * @returns {?number}
     */
    _getSentenceOffset(textSource) {
        if (textSource.type === 'range') {
            const {range} = textSource;
            const node = this._getParentElement(range.startContainer);
            if (node !== null && node instanceof HTMLElement) {
                const {offset} = node.dataset;
                if (typeof offset === 'string') {
                    const value = Number.parseInt(offset, 10);
                    if (Number.isFinite(value)) {
                        return Math.max(0, value) + range.startOffset;
                    }
                }
            }
        }
        return null;
    }

    /**
     * @param {?Node} node
     * @returns {?Element}
     */
    _getParentElement(node) {
        const {ELEMENT_NODE} = Node;
        while (true) {
            if (node === null) { return null; }
            if (node.nodeType === ELEMENT_NODE) { return /** @type {Element} */ (node); }
            node = node.parentNode;
        }
    }

    /**
     * @param {import('settings').ParsingReadingMode} value
     */
    _setReadingMode(value) {
        this._readingMode = value;
        if (value === 'romaji') {
            this._loadJapaneseWanakanaModule();
        }
    }

    /** */
    _loadJapaneseWanakanaModule() {
        if (this._japaneseWanakanaModuleImport !== null) { return; }
        this._japaneseWanakanaModuleImport = import('../language/ja/japanese-wanakana.js');
        void this._japaneseWanakanaModuleImport.then((value) => { this._japaneseWanakanaModule = value; });
    }
}
