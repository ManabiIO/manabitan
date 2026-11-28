/* SPDX-License-Identifier: GPL-3.0-or-later */

import {compareBrowserGlossaries, glossaryHash} from './glossary-fields.mjs'

export const LOOKUP_CAP = 16

const pairKey = (term, reading) => JSON.stringify([term, reading])
const isDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function verifiedGlossaryOracle(dataset, spec, expected, attestation) {
    const digest = expected?.digest
    if (!isDigest(digest) || attestation?.equal !== true || attestation.dataset !== dataset ||
        attestation.archiveSha256 !== spec.sha || attestation.terms !== spec.terms ||
        attestation.receiptDigest !== digest || attestation.reconstructedDigest !== digest ||
        !Array.isArray(attestation.groups) || attestation.groups.length === 0) {
        throw new Error('Pinned glossary attestation identity mismatch for ' + dataset)
    }
    const rowsByKey = new Map()
    for (const {expression, reading, rows} of attestation.groups) {
        const key = pairKey(expression, reading)
        if (rowsByKey.has(key) || !Array.isArray(rows) || rows.length === 0 ||
            !rows.every(row => isDigest(row.glossaryCanonicalSha256))) {
            throw new Error('Invalid glossary source rows for ' + key)
        }
        rowsByKey.set(key, rows)
    }
    const expectedKeys = Object.keys(expected.expected ?? {})
    if (expectedKeys.length !== rowsByKey.size || expectedKeys.some(key => {
        const hashes = expected.expected[key]
        const rows = rowsByKey.get(key)
        return !Array.isArray(hashes) || !rows ||
            JSON.stringify([...hashes].sort()) !== JSON.stringify(rows.map(row => row.glossaryCanonicalSha256).sort())
    })) {
        throw new Error('Expected glossary multisets do not match pinned source rows for ' + dataset)
    }
    return {digest, expected: expected.expected, rowsByKey}
}

export function validateBrowserGlossaries(entries, title, oracle) {
    const errors = []
    const validEntries = []
    const observations = new Map()
    for (const [entryIndex, entry] of entries.entries()) {
        if (!Array.isArray(entry?.headwords) || entry.headwords.length === 0 || !Array.isArray(entry.definitions)) {
            errors.push({entryIndex, reason: 'Malformed term entry', entry})
            continue
        }
        const definitions = []
        const referenced = new Set()
        for (const [definitionIndex, definition] of entry.definitions.entries()) {
            const indices = definition?.headwordIndices
            if (definition?.dictionary !== title || !Array.isArray(definition.entries) || definition.entries.length === 0 ||
                !Array.isArray(indices) || indices.length === 0 || new Set(indices).size !== indices.length ||
                indices.some(index => {
                    const head = entry.headwords[index]
                    return !Number.isInteger(index) || index < 0 || index >= entry.headwords.length ||
                        typeof head?.term !== 'string' || head.term.length === 0 || typeof head.reading !== 'string'
                })) {
                errors.push({entryIndex, definitionIndex, reason: 'Invalid hydrated definition or headword association', definition})
                continue
            }
            definitions.push(definition)
            const hash = glossaryHash(definition.entries)
            for (const index of indices) {
                referenced.add(index)
                const {term, reading} = entry.headwords[index]
                const key = pairKey(term, reading)
                if (!observations.has(key)) observations.set(key, [])
                observations.get(key).push({entryIndex, definitionIndex, hash, definition})
            }
        }
        for (const [index, headword] of entry.headwords.entries()) {
            if (!referenced.has(index)) errors.push({entryIndex, index, reason: 'Unassociated headword', headword})
        }
        validEntries.push({headwords: entry.headwords, definitions})
    }
    const comparison = compareBrowserGlossaries(validEntries, title, oracle.expected)
    const groups = comparison.groups.map(group => {
        if (group.equal) return group
        const key = JSON.stringify(group.headword)
        return {...group, sourceRows: oracle.rowsByKey.get(key) ?? [], actualDefinitions: observations.get(key) ?? []}
    })
    return {equal: errors.length === 0 && comparison.equal, errors, groups}
}

export function validateNativeGlossaries(digest, oracle) {
    return {equal: digest === oracle.digest, expectedDigest: oracle.digest, actualDigest: digest ?? null}
}
