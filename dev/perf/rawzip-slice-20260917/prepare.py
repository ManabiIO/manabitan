from pathlib import Path

ROOT = Path.cwd()

def replace(path, old, new):
    p = ROOT / path
    text = p.read_text()
    assert text.count(old) == 1, (path, old[:120], text.count(old))
    p.write_text(text.replace(old, new))

flag = 'experimentalRawZipSliceCopy'
replace(
    'ext/js/dictionary/term-bank-experiments.js',
    '    return Object.freeze({\n',
    f'    return Object.freeze({{\n        {flag}: options.{flag} === true,\n',
)
replace(
    'types/ext/dictionary-importer.d.ts',
    'export type ImportExperiments = {\n',
    f'export type ImportExperiments = {{\n    {flag}?: boolean;\n',
)
replace(
    'ext/js/dictionary/term-bank-source-pipeline.js',
    '    /** @param {ArrayBuffer|Blob} archiveContent */\n    constructor(archiveContent) {',
    '''    /**
     * @param {ArrayBuffer|Blob} archiveContent
     * @param {boolean} [sliceCopy]
     */
    constructor(archiveContent, sliceCopy = false) {''',
)
replace(
    'ext/js/dictionary/term-bank-source-pipeline.js',
    '        this._archiveBytesPromise = null;\n',
    '        this._archiveBytesPromise = null;\n        /** @type {boolean} */\n        this._sliceCopy = sliceCopy === true;\n',
)
replace(
    'ext/js/dictionary/term-bank-source-pipeline.js',
    '        return Uint8Array.from(archiveBytes.subarray(dataOffset, dataOffset + compressedSize));',
    '''        return this._sliceCopy ?
            archiveBytes.slice(dataOffset, dataOffset + compressedSize) :
            Uint8Array.from(archiveBytes.subarray(dataOffset, dataOffset + compressedSize));''',
)
replace(
    'ext/js/dictionary/dictionary-importer.js',
    '            new RawZipPayloadReader(archiveContent) :',
    '            new RawZipPayloadReader(archiveContent, this._termBankExperiments.experimentalRawZipSliceCopy) :',
)

(ROOT / 'test/raw-zip-slice-copy.test.js').write_text('''/*
 * Copyright (C) 2026  Yomitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {RawZipPayloadReader} from '../ext/js/dictionary/term-bank-source-pipeline.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

function makeArchive(payload) {
    const filename = new TextEncoder().encode('term_bank_1.json')
    const archive = new Uint8Array(30 + filename.length + payload.length + 7)
    const view = new DataView(archive.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, 8, true)
    view.setUint16(26, filename.length, true)
    view.setUint16(28, 0, true)
    archive.set(filename, 30)
    archive.set(payload, 30 + filename.length)
    const file = {
        filename: 'term_bank_1.json',
        offset: 0,
        compressedSize: payload.length,
        compressionMethod: 8,
        rawFilename: filename,
    }
    return {archive, file}
}

describe('raw ZIP native slice experiment', () => {
    test('requires literal true and defaults off', () => {
        expect(snapshotTermBankExperiments().experimentalRawZipSliceCopy).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            expect(snapshotTermBankExperiments(/** @type {any} */ ({experimentalRawZipSliceCopy: value})).experimentalRawZipSliceCopy).toBe(false)
        }
        expect(snapshotTermBankExperiments({experimentalRawZipSliceCopy: true}).experimentalRawZipSliceCopy).toBe(true)
    })

    test.each([false, true])('returns exact independently owned payload bytes, slice=%s', async (sliceCopy) => {
        const payload = Uint8Array.from({length: 4097}, (_, i) => (i * 73 + 19) & 255)
        const {archive, file} = makeArchive(payload)
        const reader = new RawZipPayloadReader(archive.buffer, sliceCopy)
        const signal = new AbortController().signal
        const first = await reader.read(/** @type {any} */ (file), signal)
        const second = await reader.read(/** @type {any} */ (file), signal)
        expect(first).toEqual(payload)
        expect(second).toEqual(payload)
        expect(first.buffer).not.toBe(archive.buffer)
        expect(second.buffer).not.toBe(archive.buffer)
        expect(second.buffer).not.toBe(first.buffer)
        first.fill(0)
        expect(second).toEqual(payload)
        expect(archive.subarray(30 + file.rawFilename.length, 30 + file.rawFilename.length + payload.length)).toEqual(payload)
    })

    test.each([false, true])('keeps local-header and bounds validation identical, slice=%s', async (sliceCopy) => {
        const payload = Uint8Array.of(1, 2, 3, 4, 5)
        const {archive, file} = makeArchive(payload)
        const signal = new AbortController().signal
        archive[0] = 0
        await expect(new RawZipPayloadReader(archive.buffer, sliceCopy).read(/** @type {any} */ (file), signal)).rejects.toThrow('local header')
        const valid = makeArchive(payload)
        valid.file.compressedSize += 999
        await expect(new RawZipPayloadReader(valid.archive.buffer, sliceCopy).read(/** @type {any} */ (valid.file), signal)).rejects.toThrow('out of bounds')
    })
})
''')
print('Staged default-off raw ZIP slice-copy candidate; fallback remains Uint8Array.from')
