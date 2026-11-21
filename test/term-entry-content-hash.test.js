/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'

import {hashTermEntryContentBytes, hashTermEntryContentBytesPair, hashPairToHex} from '../ext/js/dictionary/term-entry-content-hash.js'

// Independent vectors generated with upstream libxxhash 0.8.3 XXH32,
// seeds 0x811c9dc5 and 0x9e3779b9, over byte(i) = (131*i + 17*length + (i >> 3)) & 255.
// Keeping fixed values protects persisted hashes when writer and reader share code.
const VECTORS = [
    [0, 1786691832, 3449911982],
    [1, 369118841, 1959344397],
    [2, 164109134, 1343756741],
    [3, 3442112906, 1616667414],
    [4, 265225298, 4230702640],
    [5, 4218716495, 1111030367],
    [6, 1888358984, 3764009445],
    [7, 1538831536, 3501830257],
    [8, 3658161665, 59955230],
    [9, 957509007, 886787925],
    [10, 774206446, 3436596958],
    [11, 4183459966, 1361589584],
    [12, 3120621086, 1767060274],
    [13, 2222386417, 1645421151],
    [14, 3914993701, 3964271096],
    [15, 3345665980, 51304357],
    [16, 2490509838, 344898396],
    [17, 812069692, 3821045881],
    [18, 1298953353, 606526474],
    [19, 2149853067, 1024892620],
    [20, 533293981, 786514678],
    [21, 2752422408, 800790058],
    [22, 1999356383, 3042627334],
    [23, 2345606411, 1764291716],
    [24, 3076940038, 3219253240],
    [25, 2458795988, 2311775305],
    [26, 127585539, 1347543485],
    [27, 3795108320, 1860481843],
    [28, 2530338641, 3348215516],
    [29, 3827372625, 804960503],
    [30, 943556284, 2807440521],
    [31, 3906497626, 480948925],
    [32, 3190204536, 2531867521],
    [33, 973548187, 3992484357],
    [34, 1985902724, 2249197982],
    [35, 3552862528, 4135448312],
    [36, 1044763794, 1677076941],
    [37, 2144948534, 3418373505],
    [38, 3193206093, 1951125289],
    [39, 1668100076, 1639832893],
    [40, 138123329, 1499860864],
    [41, 2046231038, 3464796595],
    [42, 856527869, 32811631],
    [43, 3714928671, 3951482742],
    [44, 2328650826, 4243616624],
    [45, 2946891474, 3986807601],
    [46, 588914063, 3992507927],
    [47, 656165188, 178770041],
    [48, 1949753843, 1851852701],
    [49, 1377329518, 3172825962],
    [50, 1394931538, 3964102138],
    [51, 3283309306, 4084296057],
    [52, 1180099624, 657905399],
    [53, 1473809330, 3224219291],
    [54, 4091027690, 389086533],
    [55, 3607277603, 2770684348],
    [56, 2856056866, 2255171438],
    [57, 3356097603, 1861057748],
    [58, 2659771539, 1576113286],
    [59, 1359275190, 706612278],
    [60, 1205962954, 1421169785],
    [61, 1619319728, 1471165281],
    [62, 1234697087, 4118947692],
    [63, 632821226, 1450936541],
    [64, 3357809390, 2635564702],
    [127, 705630276, 1682537934],
    [128, 1939212314, 3463796822],
    [129, 3822030257, 2114471508],
    [255, 2573524543, 1128257793],
    [256, 2038453622, 500977205],
    [257, 2933553784, 340930876],
    [1023, 3920166034, 74589486],
    [1024, 2253831291, 349196577],
    [1025, 3017761286, 3051739601],
    [4095, 163658466, 1246015152],
    [4096, 3201798487, 4208199412],
    [4097, 4106331520, 2195097885],
    [65535, 562557757, 3944002416],
    [65536, 1582887585, 1821502994],
    [65537, 646967687, 1157557105],
    [262143, 2485207635, 3665706949],
    [262144, 1562283659, 4078881355],
    [262145, 2472867350, 114036469],
]

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function createPayload(length) {
    return Uint8Array.from({length}, (_, index) => (index * 131 + length * 17 + (index >> 3)) & 0xff)
}

describe('term content XXH32 pair', () => {
    test.each(VECTORS)('matches both independent hashes at %i bytes', (length, h1, h2) => {
        const payload = createPayload(length)
        expect(hashTermEntryContentBytesPair(payload)).toEqual([h1, h2])
        expect(hashTermEntryContentBytes(payload)).toBe(hashPairToHex(h1, h2))
    })

    test.each([1, 2, 3, 7, 15, 31])('respects a byte offset of %i and leaves the backing buffer unchanged', (offset) => {
        for (const [length, h1, h2] of VECTORS) {
            const owner = new Uint8Array(offset + length + 19).fill(0xa7)
            owner.set(createPayload(length), offset)
            const before = new Uint8Array(owner)
            const bytes = owner.subarray(offset, offset + length)
            expect(hashTermEntryContentBytesPair(bytes)).toEqual([h1, h2])
            expect(owner).toEqual(before)
        }
    })

    test('reads a stable shared subrange without changing its owner', () => {
        for (const [length, h1, h2] of VECTORS) {
            const owner = new Uint8Array(new SharedArrayBuffer(length + 27)).fill(0xd3)
            owner.set(createPayload(length), 5)
            const before = new Uint8Array(owner)
            expect(hashTermEntryContentBytesPair(owner.subarray(5, length + 5))).toEqual([h1, h2])
            expect(owner).toEqual(before)
        }
    })
})
