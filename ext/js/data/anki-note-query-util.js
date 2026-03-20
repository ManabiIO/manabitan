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

import {getRootDeckName} from './anki-util.js';

/**
 * @param {string} text
 * @returns {string}
 */
function escapeAnkiSearchValue(text) {
    return text.replace(/"/g, '');
}

/**
 * @param {string} key
 * @param {string} value
 * @param {boolean} [negative=false]
 * @returns {string}
 */
function createAnkiSearchToken(key, value, negative = false) {
    return `"${negative ? '-' : ''}${key}:${escapeAnkiSearchValue(value)}"`;
}

/**
 * @param {import('anki').Note} note
 * @returns {?{name: string, value: string}}
 */
export function getAnkiNotePrimaryField(note) {
    if (typeof note !== 'object' || note === null) { return null; }
    const {fields} = note;
    if (typeof fields !== 'object' || fields === null) { return null; }

    for (const [name, value] of Object.entries(fields)) {
        if (typeof value === 'string') {
            return {name, value};
        }
    }

    return null;
}

/**
 * @param {import('anki').Note} note
 * @returns {{
 *   duplicateScope: 'collection'|'deck',
 *   deckName: string|null,
 *   checkChildren: boolean,
 *   checkAllModels: boolean,
 * }}
 */
export function normalizeAnkiDuplicateScope(note) {
    const options = (
        typeof note === 'object' &&
        note !== null &&
        typeof note.options === 'object' &&
        note.options !== null
    ) ? note.options : null;
    const duplicateScopeRaw = typeof options?.duplicateScope === 'string' ? options.duplicateScope : 'collection';
    const duplicateScopeOptions = (
        typeof options?.duplicateScopeOptions === 'object' &&
        options.duplicateScopeOptions !== null
    ) ? options.duplicateScopeOptions : null;

    let deckName = typeof duplicateScopeOptions?.deckName === 'string' ? duplicateScopeOptions.deckName : '';
    if (deckName.length === 0) {
        deckName = typeof note.deckName === 'string' ? note.deckName : '';
    }
    let checkChildren = duplicateScopeOptions?.checkChildren === true;
    const checkAllModels = duplicateScopeOptions?.checkAllModels === true;

    switch (duplicateScopeRaw) {
        case 'deck-root':
            deckName = getRootDeckName(deckName);
            checkChildren = true;
            return {
                duplicateScope: 'deck',
                deckName,
                checkChildren,
                checkAllModels,
            };
        case 'deck':
            return {
                duplicateScope: 'deck',
                deckName,
                checkChildren,
                checkAllModels,
            };
        default:
            return {
                duplicateScope: 'collection',
                deckName: null,
                checkChildren: false,
                checkAllModels,
            };
    }
}

/**
 * @param {import('anki').Note} note
 * @param {'exact'|'any'} [fieldValueMode='exact']
 * @returns {?{
 *   query: string,
 *   fieldName: string,
 *   fieldNameLower: string,
 *   fieldValue: string,
 *   duplicateScope: 'collection'|'deck',
 *   deckName: string|null,
 *   checkChildren: boolean,
 *   checkAllModels: boolean,
 *   modelName: string,
 * }}
 */
export function createAnkiNoteDuplicateSearchDetails(note, fieldValueMode = 'exact') {
    const primaryField = getAnkiNotePrimaryField(note);
    if (primaryField === null) { return null; }

    const {duplicateScope, deckName, checkChildren, checkAllModels} = normalizeAnkiDuplicateScope(note);
    const modelName = typeof note.modelName === 'string' ? note.modelName : '';

    /** @type {string[]} */
    const queryParts = [];
    if (duplicateScope === 'deck') {
        if (typeof deckName !== 'string' || deckName.length === 0) { return null; }
        queryParts.push(createAnkiSearchToken('deck', deckName));
        if (!checkChildren) {
            queryParts.push(createAnkiSearchToken('deck', `${deckName}::*`, true));
        }
    }

    if (!checkAllModels) {
        if (modelName.length === 0) { return null; }
        queryParts.push(createAnkiSearchToken('note', modelName));
    }

    queryParts.push(createAnkiSearchToken(primaryField.name.toLowerCase(), fieldValueMode === 'any' ? '*' : primaryField.value));

    return {
        query: queryParts.join(' '),
        fieldName: primaryField.name,
        fieldNameLower: primaryField.name.toLowerCase(),
        fieldValue: primaryField.value,
        duplicateScope,
        deckName,
        checkChildren,
        checkAllModels,
        modelName,
    };
}
