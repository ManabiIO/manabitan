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

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseJson} from '../ext/js/core/json.js';
import {buildAnkiFieldsForModel} from '../ext/js/data/anki-note-type-field-util.js';
import {getStandardFieldMarkers} from '../ext/js/data/anki-template-util.js';

/**
 * @typedef {{id: string, modelNames: string[], expected: Record<string, string>, source: {revision: string}}} NoteTypeContract
 * @typedef {{name: string, fields: string[]}} UpstreamModel
 * @typedef {{id: string, status: string, error?: string, revision?: string, sha256?: string, models?: UpstreamModel[]}} UpstreamResult
 * @typedef {{results: UpstreamResult[]}} UpstreamReport
 */

export const contracts = /** @type {NoteTypeContract[]} */ (parseJson(readFileSync(new URL('../test/data/anki-note-types/contracts.json', import.meta.url), 'utf8')));

const dynamicFieldMarkers = ['single-frequency-number-frequency-only', 'single-glossary-primary', 'single-glossary-secondary'];
const availableMarkers = new Set([...getStandardFieldMarkers('term'), ...dynamicFieldMarkers]);

/**
 * @param {NoteTypeContract} contract
 * @param {UpstreamModel} model
 * @returns {import('settings').AnkiFields}
 */
export function checkModel(contract, model) {
    assert.ok(contract.modelNames.includes(model.name), `${contract.id}: unreviewed model name ${model.name}`);
    assert.equal(new Set(model.fields).size, model.fields.length, `${contract.id}: duplicate field`);
    assert.deepEqual([...model.fields].sort(), Object.keys(contract.expected).sort(), `${contract.id}: upstream fields changed; review additions/removals, including intentional blanks`);
    const fields = buildAnkiFieldsForModel({modelName: model.name, fieldNames: model.fields, dictionaryEntryType: 'term', dynamicFieldMarkers});
    assert.deepEqual(Object.keys(fields), model.fields, `${contract.id}: missing/reordered output fields`);
    assert.equal(fields[model.fields[0]].value, '{expression}', `${contract.id}: first field is not the word identifier`);
    for (const [name, expected] of Object.entries(contract.expected)) {
        assert.deepEqual(fields[name], {value: expected, overwriteMode: 'coalesce'}, `${contract.id}.${name}: incorrect field mapping`);
        for (const [, marker] of fields[name].value.matchAll(/\{([^{}]+)\}/g)) {
            assert.ok(availableMarkers.has(marker), `${contract.id}.${name}: unsupported marker ${marker}`);
        }
    }
    return fields;
}

/**
 * @param {UpstreamReport} report
 * @returns {void}
 * @throws {AggregateError} One or more upstream contracts failed.
 */
export function checkReport(report) {
    assert.equal(report.results.length, contracts.length, 'Missing or extra upstream results');
    assert.equal(new Set(report.results.map(({id}) => id)).size, contracts.length, 'Duplicate result IDs');
    const failures = [];
    for (const contract of contracts) {
        try {
            const result = report.results.find(({id}) => id === contract.id);
            assert.ok(result, `${contract.id}: result is missing`);
            assert.equal(result.status, 'downloaded', `${contract.id}: ${result.error ?? 'package was not downloaded'}`);
            assert.ok(Array.isArray(result.models), `${contract.id}: model list is missing`);
            const models = result.models.filter(({name}) => contract.modelNames.includes(name));
            assert.equal(models.length, 1, `${contract.id}: expected exactly one matching note type; found ${result.models.map(({name}) => name).join(', ')}`);
            checkModel(contract, models[0]);
            console.log(`PASS ${contract.id}: ${result.revision}, ${models[0].fields.length} fields, sha256:${result.sha256}`);
        } catch (error) {
            failures.push(error);
            console.error(String(error));
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} upstream mapping contracts failed`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 3, 'Usage: node dev/anki-note-type-compatibility.js <download-report.json>');
    checkReport(/** @type {UpstreamReport} */ (parseJson(readFileSync(process.argv[2], 'utf8'))));
}
