/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {createGenerationMediaIndex, DictionaryGenerationMediaStore, restrictGenerationMediaIndex} from '../ext/js/dictionary/dictionary-generation-media-store.js'

const prefix = 'img/card'
const suffix = '.webp'
const generation = 'f67e29e0-ea36-4d71-9cb8-55aa1916db07'

/**
 * @param {number} id
 * @returns {NonNullable<ReturnType<typeof createGenerationMediaIndex>>}
 */
function planForId(id) {
    const plan = createGenerationMediaIndex([{
        path: `${prefix}${id}${suffix}`,
        packedOffset: 0,
        packedLength: 1,
        compressionMethod: 0,
        uncompressedLength: 1,
        signature: 0,
    }], 1)
    if (plan === null) { throw new Error('Expected a canonical media plan') }
    return plan
}

describe('Generation media canonical decimal paths', () => {
    test.each([1, 9, 10, 99, 100, 99999, 100000, 999999999, 1000000000, 4294967294, 4294967295])('retains the exact slot identity for ID %i', (id) => {
        const plan = planForId(id)
        expect(plan.descriptor.firstId).toBe(id)
        expect(plan.descriptor.slotCount).toBe(1)
        const selected = restrictGenerationMediaIndex(plan, [`${prefix}${id}${suffix}`])
        expect(selected).toEqual(plan)
        const view = new DataView(plan.index.buffer)
        expect(view.getUint32(16, true)).toBe(id)
    })

    test.each([
        '',
        '0',
        '00',
        '01',
        '+1',
        '-1',
        '-0',
        ' 1',
        '1 ',
        '\t1',
        '1\n',
        '1.0',
        '1e0',
        '1e+0',
        '0x1',
        '0b1',
        '0o1',
        '1_0',
        '1/2',
        'NaN',
        'Infinity',
        '\u0661',
        '\uff11',
        '1\u0000',
        '4294967296',
        '9999999999',
        '10000000000',
        '9007199254740991',
    ])('rejects the alternate or out-of-range spelling %j before media I/O', async (digits) => {
        const plan = planForId(1)
        const path = prefix + digits + suffix
        expect(restrictGenerationMediaIndex(plan, [path])).toBeNull()
        // No OPFS mock is installed. An incorrectly admitted path would try
        // to open its generation instead of returning an ordinary miss.
        await expect(new DictionaryGenerationMediaStore().read(generation, plan.descriptor, path)).resolves.toBeNull()
    })

    test.each(['Img/card1.webp', 'img/card1.WEBP', 'other/card1.webp', 'img/card1.webp/', 'img/card1.webp.webp'])('matches both namespace boundaries exactly for %j', async (path) => {
        const plan = planForId(1)
        expect(restrictGenerationMediaIndex(plan, [path])).toBeNull()
        await expect(new DictionaryGenerationMediaStore().read(generation, plan.descriptor, path)).resolves.toBeNull()
    })

    test('declines a directory whose positive ID exceeds uint32 before writing index fields', () => {
        const record = {
            path: `${prefix}4294967296${suffix}`,
            packedOffset: 0,
            packedLength: 1,
            compressionMethod: 0,
            uncompressedLength: 1,
            signature: 0,
        }
        expect(createGenerationMediaIndex([record], 1)).toBeNull()
    })

    test.each([4294967296, 9007199254740991])('retains descriptor rejection for a canonical safe ID %i outside uint32', async (id) => {
        const descriptor = {...planForId(1).descriptor, firstId: id}
        await expect(new DictionaryGenerationMediaStore().read(generation, descriptor, `${prefix}${id}${suffix}`)).rejects.toThrow('Invalid generation media identity')
    })

    test('retains a missing-path result for an empty suffix before descriptor validation', async () => {
        const descriptor = {...planForId(1).descriptor, suffix: ''}
        await expect(new DictionaryGenerationMediaStore().read(generation, descriptor, `${prefix}1`)).resolves.toBeNull()
    })
})
