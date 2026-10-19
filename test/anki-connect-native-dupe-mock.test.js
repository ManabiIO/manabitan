/*
 * Copyright (C) 2026 Manabitan authors
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

import {afterEach, expect, test} from 'vitest';
import {AnkiConnect} from '../ext/js/comm/anki-connect.js';
import {createAnkiMockState} from './e2e/anki-mock-state.js';
import {startAnkiMockHttpServer} from './e2e/anki-mock-http-server.js';

/** @type {Array<() => Promise<void>>} */
const closeServers = [];

afterEach(async () => {
    await Promise.all(closeServers.splice(0).map((close) => close()));
});

/**
 * @param {string} modelName
 * @param {Record<string, string>} fields
 * @param {string} [deckName]
 * @returns {import('anki').Note}
 */
function note(modelName, fields, deckName = 'Japanese') {
    return {
        modelName,
        fields,
        tags: [],
        deckName,
        options: {allowDuplicate: false, duplicateScope: 'collection', duplicateScopeOptions: {deckName: null, checkChildren: false, checkAllModels: false}},
    };
}

/**
 * @param {unknown[]} seedNotes
 * @returns {Promise<{client: AnkiConnect, state: ReturnType<typeof createAnkiMockState>}>}
 */
async function setup(seedNotes) {
    const state = createAnkiMockState();
    state.beginScenario('native-dupe-client-test', seedNotes);
    const server = await startAnkiMockHttpServer(state);
    closeServers.push(server.close);
    const client = new AnkiConnect();
    client.server = server.ankiConnectUrl;
    client.enabled = true;
    client.apiKey = 'mock-key';
    return {client, state};
}

const seed = [
    {noteId: 1, cardId: 11, modelName: 'Basic', deckName: 'Japanese', fields: {Expression: '猫', Meaning: 'cat'}},
    {noteId: 2, cardId: 12, modelName: 'Other', deckName: 'Japanese', fields: {Term: '猫', Back: 'other model'}},
    {noteId: 3, cardId: 13, modelName: 'Basic', deckName: 'Japanese', fields: {Expression: '猫', Meaning: 'secondary-only'}},
    {noteId: 4, cardId: 14, modelName: 'Basic', deckName: 'Japanese', fields: {Expression: 'alpha', Meaning: 'case-only'}},
    {noteId: 5, cardId: 15, modelName: 'Basic', deckName: 'Japanese', fields: {Expression: '<b>word</b>', Meaning: 'HTML'}},
    {noteId: 6, cardId: 16, modelName: 'Basic', deckName: 'Japanese::Child', fields: {Expression: 'scoped', Meaning: 'child'}},
    {noteId: 7, cardId: 17, modelName: 'Basic', deckName: 'Other', fields: {Expression: 'scoped', Meaning: 'other deck'}},
    {noteId: 8, cardId: 18, modelName: 'Basic', deckName: 'Japanese', fields: {Expression: 'not-cat', Meaning: 'cat'}},
    {noteId: 9, cardId: 19, modelName: 'Reversed', deckName: 'Japanese', fields: {Term: '猫', Back: 'different first-field name'}},
];

test('native duplicate mock uses model IDs and first-field values, including all-model queries', async () => {
    const {client, state} = await setup(seed);
    expect(await client.findNoteIds([
        note('Basic', {Expression: '猫', Meaning: 'incoming'}),
        {...note('Basic', {Expression: '猫'}), options: {allowDuplicate: false, duplicateScope: 'collection', duplicateScopeOptions: {deckName: null, checkChildren: false, checkAllModels: true}}},
        note('Basic', {Expression: 'Alpha'}),
        note('Basic', {Expression: 'cat'}),
        note('Basic', {Expression: 'word'}),
    ])).toEqual([[1, 3], [1, 2, 3, 9], [], [], [5]]);
    expect(state.getActionNames()).toContain('modelNamesAndIds');
});

test('native duplicate mock preserves exact and descendant deck scopes', async () => {
    const {client} = await setup(seed);
    const exact = note('Basic', {Expression: 'scoped'}, 'Japanese');
    exact.options = {allowDuplicate: false, duplicateScope: 'deck', duplicateScopeOptions: {deckName: 'Japanese', checkChildren: false, checkAllModels: false}};
    const children = structuredClone(exact);
    children.options.duplicateScopeOptions.checkChildren = true;
    const root = structuredClone(exact);
    root.options.duplicateScope = 'deck-root';
    expect(await client.findNoteIds([exact, children, root])).toEqual([[], [6], [6]]);
});

test('native duplicate mock parses escaped quote/backslash literals and grouped union followups', async () => {
    const {client, state} = await setup([
        {noteId: 21, cardId: 31, modelName: 'Basic', deckName: 'Japanese', fields: {Expression: 'say "hi" \\ path'}},
        {noteId: 22, cardId: 32, modelName: 'Basic', deckName: 'Japanese', fields: {Expression: 'two'}},
    ]);
    expect(await client.findNoteIds([note('Basic', {Expression: 'say "hi" \\ path'}), note('Basic', {Expression: 'two'})])).toEqual([[21], [22]]);
    const actions = state.getScenarioState().actions;
    const union = actions.find(({action, params}) => action === 'findNotes' && String(params.query || '').includes(' or '));
    expect(union).toBeDefined();
    expect(actions.some(({action, params}) => action === 'multi' && JSON.stringify(params).includes('nid:21,22'))).toBe(true);
});

test('legacy field-name query matching remains available', async () => {
    const {client} = await setup(seed);
    expect(await client.findNotes('Expression:"猫"')).toEqual([1, 3]);
});

test('model IDs are shared with dupe matching and prototype-like names remain own keys', async () => {
    const {state} = await setup([
        {noteId: 41, cardId: 51, modelName: '__proto__', deckName: 'Japanese', fields: {Front: 'prototype'}},
        {noteId: 42, cardId: 52, modelName: 'constructor', deckName: 'Japanese', fields: {Front: 'constructor'}},
    ]);
    const response = state.handleRequestBody({action: 'modelNamesAndIds', params: {}});
    const modelIds = /** @type {Record<string, number>} */ (response.result);
    expect(Object.hasOwn(modelIds, '__proto__')).toBe(true);
    expect(Object.hasOwn(modelIds, 'constructor')).toBe(true);
    for (const [modelName, noteId, value] of [['__proto__', 41, 'prototype'], ['constructor', 42, 'constructor']]) {
        const duplicate = state.handleRequestBody({action: 'findNotes', params: {query: `dupe:${modelIds[modelName]},${value}`}});
        expect(duplicate.result).toContain(noteId);
    }
});

test('native duplicate fixture decodes entities once in one bounded pass', async () => {
    const {state} = await setup([
        {noteId: 61, cardId: 71, modelName: 'Basic', deckName: 'Japanese', fields: {Front: '&amp;lt;'}},
    ]);
    const modelIds = /** @type {Record<string, number>} */ (state.handleRequestBody({action: 'modelNamesAndIds', params: {}}).result);
    const response = state.handleRequestBody({action: 'findNotes', params: {query: `dupe:${modelIds.Basic},&lt;`}});
    expect(response.result).toEqual([]);
});

test('native duplicate mock extracts fragment text without changing literal field values', async () => {
    const {client, state} = await setup([
        {noteId: 81, cardId: 91, modelName: 'Basic', deckName: 'Japanese', fields: {Front: 'MiXeD'}},
        {noteId: 82, cardId: 92, modelName: 'Basic', deckName: 'Japanese', fields: {Front: '<b>word</b>'}},
        {noteId: 83, cardId: 93, modelName: 'Basic', deckName: 'Japanese', fields: {Front: '<span><i>nested</i></span>'}},
        {noteId: 84, cardId: 94, modelName: 'Basic', deckName: 'Japanese', fields: {Front: '<b title=">">fragment</b>'}},
        {noteId: 85, cardId: 95, modelName: 'Basic', deckName: 'Japanese', fields: {Front: 'say "hi" \\ path'}},
        {noteId: 86, cardId: 96, modelName: 'Basic', deckName: 'Japanese', fields: {Front: '<i>&lt;b&gt;literal&lt;/b&gt;</i>'}},
    ]);
    const modelIds = /** @type {Record<string, number>} */ (state.handleRequestBody({action: 'modelNamesAndIds', params: {}}).result);
    /**
     * @param {string} value
     * @returns {unknown}
     */
    const query = (value) => state.handleRequestBody({action: 'findNotes', params: {query: `dupe:${modelIds.Basic},${value}`}}).result;
    expect(query('MiXeD')).toEqual([81]);
    expect(query('mixed')).toEqual([]);
    expect(query('word')).toEqual([82]);
    expect(query('nested')).toEqual([83]);
    expect(query('fragment')).toEqual([84]);
    expect(await client.findNoteIds([note('Basic', {Expression: 'say "hi" \\ path'})])).toEqual([[85]]);
    expect(query('&lt;b&gt;literal&lt;/b&gt;')).toEqual([86]);
});

test('native duplicate mock normalizes NBSP after one entity decode', async () => {
    const {state} = await setup([
        {noteId: 87, cardId: 97, modelName: 'Basic', deckName: 'Japanese', fields: {Front: 'one&nbsp;two'}},
        {noteId: 88, cardId: 98, modelName: 'Basic', deckName: 'Japanese', fields: {Front: 'one two'}},
        {noteId: 89, cardId: 99, modelName: 'Basic', deckName: 'Japanese', fields: {Front: 'one&amp;nbsp;two'}},
    ]);
    const modelIds = /** @type {Record<string, number>} */ (state.handleRequestBody({action: 'modelNamesAndIds', params: {}}).result);
    /**
     * @param {string} value
     * @returns {unknown}
     */
    const query = (value) => state.handleRequestBody({action: 'findNotes', params: {query: `"dupe:${modelIds.Basic},${value}"`}}).result;
    expect(query('one two')).toEqual([87, 88]);
    expect(query('one&nbsp;two')).toEqual([87, 88]);
    expect(query('one&amp;nbsp;two')).toEqual([89]);
});
