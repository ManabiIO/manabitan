/* SPDX-License-Identifier: GPL-3.0-or-later */

const check = (condition, message) => {
    if (!condition) throw new Error(message)
}
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
const readBytes = async (url) => {
    const response = await fetch(url, {cache: 'no-store'})
    check(response.ok, `Failed to read ${url}: ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
}

self.onmessage = async ({data: {arm, manifest, identities}}) => {
    const workerStartedAt = performance.now()
    const groups = []
    let rows = 0
    let inputBytes = 0
    let sectionHashCount = 0
    let hashMs = 0
    let initializationMs = null
    try {
        check(arm === 'js' || arm === 'triple', 'Unknown checksum arm')
        let algorithm
        let helperLoadMs = 0
        let moduleReadMs = 0
        let compileAndInitializeMs = 0
        let wasmBytes = null
        let memoryBytes = 0

        // No checksum or vector comparison runs before this first measured pass.
        // Dynamic module acquisition and native compilation belong to startup.
        const initializationStartedAt = performance.now()
        if (arm === 'js') {
            const helper = await import('/repo/ext/js/dictionary/term-key-hash.js')
            helperLoadMs = performance.now() - initializationStartedAt
            algorithm = (a, b, c) => [helper.hashTermKeyBytes(a), helper.hashTermKeyBytes(b), helper.hashTermKeyBytes(c)]
        } else {
            const helper = await import('/repo/dev/perf/native-sidecar-hash-three-stream/native-three.mjs')
            helperLoadMs = performance.now() - initializationStartedAt
            const readStartedAt = performance.now()
            wasmBytes = await readBytes('/repo/dev/perf/native-sidecar-hash-three-stream/xxh32-three.wasm')
            moduleReadMs = performance.now() - readStartedAt
            const compileStartedAt = performance.now()
            const native = await helper.createThreeStreamChecksum(wasmBytes)
            compileAndInitializeMs = performance.now() - compileStartedAt
            algorithm = native.hashThree
            memoryBytes = native.memoryBytes
        }
        initializationMs = performance.now() - initializationStartedAt
        const wasmSha256 = wasmBytes === null ? null : await sha256(wasmBytes)
        if (wasmSha256 !== null) check(wasmSha256 === identities.wasmSha256, 'Native module identity mismatch')

        const outputWords = []
        for (const group of manifest.dictionaries) {
            check(group.inputs.length % 3 === 0, 'Incomplete checksum triplet')
            let groupHashMs = 0
            let groupBytes = 0
            for (let index = 0; index < group.inputs.length; index += 3) {
                const metadata = group.inputs.slice(index, index + 3)
                check(metadata.map((entry) => entry.section).join(',') === 'base,derived,records', 'Unexpected section order')
                const source = []
                for (const entry of metadata) {
                    const bytes = await readBytes(`/input/${encodeURIComponent(entry.filename)}`)
                    check(bytes.byteLength === entry.bytes, 'Input length mismatch')
                    check(await sha256(bytes) === entry.sha256, 'Input SHA-256 mismatch')
                    source.push(bytes)
                    groupBytes += bytes.byteLength
                }
                // The real sink receives base/derived subviews of one ordinary
                // owned lookup container with a 16-byte prefix. Reconstruct its
                // backing/offset layout outside the checksum timer. Prefix bytes
                // are never hashed. Record fields retain their own owned buffer.
                const lookup = new Uint8Array(16 + source[0].byteLength + source[1].byteLength)
                lookup.set(source[0], 16)
                lookup.set(source[1], 16 + source[0].byteLength)
                const base = new Uint8Array(lookup.buffer, 16, source[0].byteLength)
                const derived = new Uint8Array(lookup.buffer, 16 + source[0].byteLength, source[1].byteLength)
                const startedAt = performance.now()
                const actual = algorithm(base, derived, source[2])
                groupHashMs += performance.now() - startedAt
                // Compare persisted expected values after timing. Calling the JS
                // comparator here would warm the next group and bias the study.
                for (let part = 0; part < 3; part++) {
                    check(actual[part] === metadata[part].xxh32, `Checksum mismatch at ${group.groupIndex}/${index}/${part}`)
                    outputWords.push(actual[part])
                }
                sectionHashCount += 3
            }
            rows += group.rows
            inputBytes += groupBytes
            hashMs += groupHashMs
            groups.push({groupIndex: group.groupIndex, rows: group.rows, bytes: groupBytes, sections: group.inputs.length, hashMs: groupHashMs})
        }
        const outputBytes = new Uint8Array(outputWords.length * 4)
        const outputView = new DataView(outputBytes.buffer)
        outputWords.forEach((word, index) => outputView.setUint32(index * 4, word, true))
        self.postMessage({complete: true, arm, rows, inputBytes, sectionHashCount, groups,
            warmupCalls: 0, repetitions: 1, initializationMs, helperLoadMs, moduleReadMs, compileAndInitializeMs,
            hashMs, totalMs: initializationMs + hashMs, workerWallMs: performance.now() - workerStartedAt,
            wasmSha256, memoryBytes, outputHashesSha256: await sha256(outputBytes),
            workerUserAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory ?? null, crossOriginIsolated,
            timeOrigin: performance.timeOrigin,
        })
    } catch (error) {
        self.postMessage({complete: false, arm, groups, rows, inputBytes, sectionHashCount, hashMs, initializationMs,
            workerWallMs: performance.now() - workerStartedAt, error: String(error?.stack ?? error)})
    }
}
