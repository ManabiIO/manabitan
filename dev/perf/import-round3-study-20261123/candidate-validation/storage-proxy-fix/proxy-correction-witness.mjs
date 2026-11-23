import {pathToFileURL} from 'node:url'
import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'

const [baselineRoot, originalRoot, candidateRoot, output] = process.argv.slice(2)
const results = []
for (const [arm, root] of [['develop-baseline', baselineRoot], ['original-809', originalRoot], ['corrected-809', candidateRoot]]) {
    const source = path.join(root, 'ext/js/dictionary/term-record-opfs-store.js')
    const {TermRecordOpfsStore} = await import(pathToFileURL(source).href)
    const references = {uniqueIndexList: Uint32Array.of(0, 0), offsets: Float64Array.of(16), lengths: Uint32Array.of(7)}
    const invalidReferences = {...references, offsets: Float64Array.of(Number.NaN)}
    const expression = new TextEncoder().encode('term')
    const target = {
        dictionary: 'Proxy validation witness', rowCount: 2,
        expressionBytesList: [expression, expression], readingBytesList: [expression, expression],
        readingEqualsExpressionList: Uint8Array.of(1, 1), scoreList: new Int32Array(2), sequenceList: Int32Array.of(-1, -1),
        resolvedContentReferences: references,
    }
    // The own data descriptor contains valid references, while ordinary reads
    // return equally shaped references with an invalid numeric content offset.
    const chunk = new Proxy(target, {
        get(object, key, receiver) {
            return key === 'resolvedContentReferences' ? invalidReferences : Reflect.get(object, key, receiver)
        },
    })
    const store = new TermRecordOpfsStore()
    const appended = []
    store._appendEncodedChunk = async (...args) => {
        appended.push({count: args[2], contentOffsetBase: args[4], recordFields: [...args[6]], recordFieldsFormat: args[7]})
    }
    let error = null
    try {
        await store._encodeAndAppendArtifactChunkForState({}, chunk, 1, new Float64Array(0), new Uint32Array(0), null, 'raw')
    } catch (caught) {
        error = {name: caught.name, message: caught.message}
    }
    results.push({arm, sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'), error, appended})
}
const receipt = {description: 'Two-row correctness-only witness; actual validation and record/lookup encoders execute, append interception records bytes without opening storage. No timing.', results}
if (output) await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify(receipt))
