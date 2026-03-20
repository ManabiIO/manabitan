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

import {getStandardFieldMarkers} from './anki-template-util.js';

const knownAnkiNoteTypePresets = new Map([
    ['kiku', 'kiku-lapis'],
    ['lapis', 'kiku-lapis'],
    ['senren', 'senren'],
    ['senren 洗練', 'senren'],
    ['crop theft vocab', 'crop-theft-vocab'],
]);

const markerAliases = new Map([
    ['expression', ['phrase', 'term', 'word']],
    ['reading', ['expression-reading', 'term-reading', 'word-reading']],
    ['furigana', ['expression-furigana', 'term-furigana', 'word-furigana']],
    ['glossary', ['definition', 'meaning']],
    ['audio', ['sound', 'word-audio', 'term-audio', 'expression-audio']],
    ['dictionary', ['dict']],
    ['pitch-accents', ['pitch', 'pitch-accent', 'pitch-pattern']],
    ['sentence', ['example-sentence']],
    ['frequency-harmonic-rank', ['freq', 'frequency', 'freq-sort', 'freqency-sort']],
    ['popup-selection-text', ['selection', 'selection-text']],
    ['pitch-accent-positions', ['pitch-position']],
    ['pitch-accent-categories', ['pitch-categories']],
]);

/**
 * @param {{
 *   modelName: string,
 *   fieldNames: string[],
 *   dictionaryEntryType: import('dictionary').DictionaryEntryType,
 *   oldFields?: ?import('settings').AnkiFields,
 *   dynamicFieldMarkers?: string[],
 * }} details
 * @returns {import('settings').AnkiFields}
 */
export function buildAnkiFieldsForModel({
    modelName,
    fieldNames,
    dictionaryEntryType,
    oldFields = null,
    dynamicFieldMarkers = [],
}) {
    const preset = getKnownAnkiNoteTypePreset(modelName, dictionaryEntryType, dynamicFieldMarkers);

    /** @type {import('settings').AnkiFields} */
    const fields = {};
    for (let i = 0, ii = fieldNames.length; i < ii; ++i) {
        const fieldName = fieldNames[i];
        fields[fieldName] = {
            value: (
                preset !== null ?
                getPresetFieldValue(preset, fieldName) :
                getDefaultAnkiFieldValue(fieldName, i, dictionaryEntryType, oldFields)
            ),
            overwriteMode: 'coalesce',
        };
    }
    return fields;
}

/**
 * @param {string} fieldName
 * @param {number} index
 * @param {import('dictionary').DictionaryEntryType} dictionaryEntryType
 * @param {?import('settings').AnkiFields} oldFields
 * @returns {string}
 */
export function getDefaultAnkiFieldValue(fieldName, index, dictionaryEntryType, oldFields) {
    if (
        typeof oldFields === 'object' &&
        oldFields !== null &&
        Object.prototype.hasOwnProperty.call(oldFields, fieldName)
    ) {
        return oldFields[fieldName].value;
    }

    if (index === 0) {
        return (dictionaryEntryType === 'kanji' ? '{character}' : '{expression}');
    }

    const markers = getStandardFieldMarkers(dictionaryEntryType);
    const hyphenPattern = /-/g;
    for (const marker of markers) {
        const names = [marker];
        const aliases = markerAliases.get(marker);
        if (typeof aliases !== 'undefined') {
            names.push(...aliases);
        }

        let pattern = '^(?:';
        for (let i = 0, ii = names.length; i < ii; ++i) {
            const name = names[i];
            if (i > 0) { pattern += '|'; }
            pattern += name.replace(hyphenPattern, '[-_ ]*');
        }
        pattern += ')$';
        const patternRegExp = new RegExp(pattern, 'i');

        if (patternRegExp.test(fieldName)) {
            return `{${marker}}`;
        }
    }

    return '';
}

/**
 * @param {string} modelName
 * @param {import('dictionary').DictionaryEntryType} dictionaryEntryType
 * @param {string[]} dynamicFieldMarkers
 * @returns {?Record<string, string>}
 */
function getKnownAnkiNoteTypePreset(modelName, dictionaryEntryType, dynamicFieldMarkers) {
    if (dictionaryEntryType !== 'term') { return null; }

    const presetKey = knownAnkiNoteTypePresets.get(normalizeAnkiModelName(modelName));
    if (typeof presetKey === 'undefined') { return null; }

    const primaryDefinitionMarker = getPrimaryDefinitionMarker(dynamicFieldMarkers);
    switch (presetKey) {
        case 'kiku-lapis':
            return {
                Expression: '{expression}',
                ExpressionFurigana: '{furigana-plain}',
                ExpressionReading: '{reading}',
                ExpressionAudio: '{audio}',
                SelectionText: '{popup-selection-text}',
                MainDefinition: primaryDefinitionMarker,
                DefinitionPicture: '',
                Sentence: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}',
                SentenceFurigana: '',
                SentenceAudio: '',
                Picture: '',
                Glossary: '{glossary}',
                Hint: '',
                IsWordAndSentenceCard: '',
                IsClickCard: '',
                IsSentenceCard: '',
                IsAudioCard: '',
                PitchPosition: '{pitch-accent-positions}',
                PitchCategories: '{pitch-accent-categories}',
                Frequency: '{frequencies}',
                FreqSort: '{frequency-harmonic-rank}',
                MiscInfo: '{document-title}',
            };
        case 'senren':
            return {
                word: '{expression}',
                reading: '{reading}',
                sentence: '<span class="group">{cloze-prefix}<span class="highlight">{cloze-body}</span>{cloze-suffix}</span>',
                sentenceFurigana: '<span class="group">{sentence-furigana}</span>',
                sentenceTranslation: '',
                sentenceCard: '',
                audioCard: '',
                notes: '',
                selectionText: '{popup-selection-text}',
                definition: primaryDefinitionMarker,
                wordAudio: '{audio}',
                sentenceAudio: '',
                picture: '',
                glossary: '{glossary}',
                pitchAccents: '{pitch-accents}',
                pitchPositions: '{pitch-accent-positions}',
                pitchCategories: '{pitch-accent-categories}',
                frequencies: '{frequencies}',
                freqSort: '{frequency-harmonic-rank}',
                miscInfo: '{document-title}',
                dictionaryPreference: '',
            };
        case 'crop-theft-vocab':
            return {
                'Word': '{expression}',
                'Reading': '{reading}',
                'PitchPattern': '{pitch-accents}',
                'Audio': '{audio}',
                'Definition': '{glossary-brief}',
                'Example Sentence': '{sentence}',
                'Example Target': '{search-query}',
                'Frequency': '{frequency-harmonic-rank}',
                'Notes': '',
            };
        default:
            return null;
    }
}

/**
 * @param {Record<string, string>} preset
 * @param {string} fieldName
 * @returns {string}
 */
function getPresetFieldValue(preset, fieldName) {
    return Object.prototype.hasOwnProperty.call(preset, fieldName) ? preset[fieldName] : '';
}

/**
 * @param {string[]} dynamicFieldMarkers
 * @returns {string}
 */
function getPrimaryDefinitionMarker(dynamicFieldMarkers) {
    for (const marker of dynamicFieldMarkers) {
        if (marker.startsWith('single-glossary-')) {
            return `{${marker}}`;
        }
    }
    return '';
}

/**
 * @param {string} modelName
 * @returns {string}
 */
function normalizeAnkiModelName(modelName) {
    return modelName
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}
