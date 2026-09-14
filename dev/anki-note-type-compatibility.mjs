import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import {buildAnkiFieldsForModel} from '../ext/js/data/anki-note-type-field-util.js'
import {getStandardFieldMarkers} from '../ext/js/data/anki-template-util.js'

export const contracts = JSON.parse(readFileSync(new URL('../test/data/anki-note-types/contracts.json', import.meta.url), 'utf8'))
const dynamicFieldMarkers = ['single-frequency-number-frequency-only', 'single-glossary-primary', 'single-glossary-secondary']
const availableMarkers = new Set([...getStandardFieldMarkers('term'), ...dynamicFieldMarkers])

export function checkModel(contract, model) {
    assert.ok(contract.modelNames.includes(model.name), `${contract.id}: unreviewed model name ${model.name}`)
    assert.equal(new Set(model.fields).size, model.fields.length, `${contract.id}: duplicate field`)
    assert.deepEqual([...model.fields].sort(), Object.keys(contract.expected).sort(), `${contract.id}: upstream fields changed; review additions/removals, including intentional blanks`)
    const fields = buildAnkiFieldsForModel({modelName: model.name, fieldNames: model.fields, dictionaryEntryType: 'term', dynamicFieldMarkers})
    assert.deepEqual(Object.keys(fields), model.fields, `${contract.id}: missing/reordered output fields`)
    assert.equal(fields[model.fields[0]].value, '{expression}', `${contract.id}: first field is not the word identifier`)
    for (const [name, expected] of Object.entries(contract.expected)) {
        assert.deepEqual(fields[name], {value: expected, overwriteMode: 'coalesce'}, `${contract.id}.${name}: incorrect field mapping`)
        for (const [, marker] of expected.matchAll(/\{([^{}]+)\}/g)) {
            assert.ok(availableMarkers.has(marker), `${contract.id}.${name}: unsupported marker ${marker}`)
        }
    }
    return fields
}

export function checkReport(report) {
    assert.equal(report.results.length, contracts.length, 'Missing or extra upstream results')
    assert.equal(new Set(report.results.map(({id}) => id)).size, contracts.length, 'Duplicate result IDs')
    const failures = []
    for (const contract of contracts) {
        try {
            const result = report.results.find(({id}) => id === contract.id)
            assert.equal(result?.status, 'downloaded', `${contract.id}: ${result?.error ?? 'package was not downloaded'}`)
            const models = result.models.filter(({name}) => contract.modelNames.includes(name))
            assert.equal(models.length, 1, `${contract.id}: expected exactly one matching note type; found ${result.models.map(({name}) => name).join(', ')}`)
            checkModel(contract, models[0])
            console.log(`PASS ${contract.id}: ${result.revision}, ${models[0].fields.length} fields, sha256:${result.sha256}`)
        } catch (error) {
            failures.push(error)
            console.error(error.message)
        }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} upstream mapping contracts failed`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 3, 'Usage: node dev/anki-note-type-compatibility.mjs <download-report.json>')
    checkReport(JSON.parse(readFileSync(process.argv[2], 'utf8')))
}
