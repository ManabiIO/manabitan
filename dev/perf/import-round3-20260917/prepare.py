from pathlib import Path

ROOT = Path.cwd()

def replace(path, old, new):
    p = ROOT / path
    text = p.read_text()
    assert text.count(old) == 1, (path, old[:100], text.count(old))
    p.write_text(text.replace(old, new))

flags = ['experimentalContentBlocks2MiB', 'experimentalContentBlocks8MiB']
replace(
    'ext/js/dictionary/term-bank-experiments.js',
    '    return Object.freeze({\n',
    '    return Object.freeze({\n' + ''.join(f'        {name}: options.{name} === true,\n' for name in flags),
)
replace(
    'types/ext/dictionary-importer.d.ts',
    'export type ImportExperiments = {\n',
    'export type ImportExperiments = {\n' + ''.join(f'    {name}?: boolean;\n' for name in flags),
)
replace(
    'ext/js/dictionary/term-bank-experiments.js',
    '/**\n * Must match EXPERIMENT_* in wasm/term-bank-parser.c.',
    '''/**
 * Experimental content blocks preserve the production 4 MiB layout unless
 * exactly one literal-true opt-in is present. Explicit importer details still
 * take precedence over this experiment policy.
 * @param {import('dictionary-importer').ImportExperiments} options
 * @returns {number|null}
 */
export function getExperimentalTermContentBlockTargetBytes(options) {
    const block2 = options.experimentalContentBlocks2MiB === true
    const block8 = options.experimentalContentBlocks8MiB === true
    if (block2 === block8) { return null }
    return (block2 ? 2 : 8) * 1024 * 1024
}

/**
 * Must match EXPERIMENT_* in wasm/term-bank-parser.c.''',
)
replace(
    'ext/js/dictionary/dictionary-importer.js',
    "import {snapshotTermBankExperiments} from './term-bank-experiments.js';",
    "import {getExperimentalTermContentBlockTargetBytes, snapshotTermBankExperiments} from './term-bank-experiments.js';",
)
old = '''        const termContentBlockTargetBytes = Number.isFinite(details.termContentBlockTargetBytes) ?
            Math.max(64 * 1024, Math.min(16 * 1024 * 1024, Math.trunc(/** @type {number} */ (details.termContentBlockTargetBytes)))) :
            null;'''
new = '''        const explicitTermContentBlockTargetBytes = Number.isFinite(details.termContentBlockTargetBytes) ?
            Math.max(64 * 1024, Math.min(16 * 1024 * 1024, Math.trunc(/** @type {number} */ (details.termContentBlockTargetBytes)))) :
            null;
        const termContentBlockTargetBytes = explicitTermContentBlockTargetBytes ??
            getExperimentalTermContentBlockTargetBytes(this._termBankExperiments);'''
replace('ext/js/dictionary/dictionary-importer.js', old, new)

(ROOT / 'test/term-content-block-experiments.test.js').write_text('''/*
 * Copyright (C) 2026  Yomitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {getExperimentalTermContentBlockTargetBytes, snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */

describe('term-content block-size experiments', () => {
    test.each(['experimentalContentBlocks2MiB', 'experimentalContentBlocks8MiB'])('%s requires literal true', (key) => {
        const name = /** @type {keyof Experiments} */ (key)
        expect(snapshotTermBankExperiments()[name]).toBe(false)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            const options = /** @type {Experiments} */ (/** @type {unknown} */ ({[name]: value}))
            expect(snapshotTermBankExperiments(options)[name]).toBe(false)
        }
        expect(snapshotTermBankExperiments({[name]: true})[name]).toBe(true)
    })

    test('preserves the production target unless exactly one experiment is enabled', () => {
        expect(getExperimentalTermContentBlockTargetBytes(snapshotTermBankExperiments())).toBeNull()
        expect(getExperimentalTermContentBlockTargetBytes(snapshotTermBankExperiments({experimentalContentBlocks2MiB: true}))).toBe(2 * 1024 * 1024)
        expect(getExperimentalTermContentBlockTargetBytes(snapshotTermBankExperiments({experimentalContentBlocks8MiB: true}))).toBe(8 * 1024 * 1024)
        expect(getExperimentalTermContentBlockTargetBytes(snapshotTermBankExperiments({experimentalContentBlocks2MiB: true, experimentalContentBlocks8MiB: true}))).toBeNull()
    })

    test('has no mutable state across alternating snapshots', () => {
        const input = {experimentalContentBlocks2MiB: true}
        const first = snapshotTermBankExperiments(input)
        input.experimentalContentBlocks2MiB = false
        expect(getExperimentalTermContentBlockTargetBytes(first)).toBe(2 * 1024 * 1024)
        expect(getExperimentalTermContentBlockTargetBytes(snapshotTermBankExperiments(input))).toBeNull()
        expect(getExperimentalTermContentBlockTargetBytes(snapshotTermBankExperiments({experimentalContentBlocks8MiB: true}))).toBe(8 * 1024 * 1024)
        expect(getExperimentalTermContentBlockTargetBytes(snapshotTermBankExperiments())).toBeNull()
    })
})
''')
print('Staged default-off 2 MiB / 8 MiB content-block experiments; existing lookup flags unchanged')
