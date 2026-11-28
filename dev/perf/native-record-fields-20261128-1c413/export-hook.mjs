import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

export const diagnosticExport = '\nexport {getSynchronousRecordFieldReferences as diagnosticRecordFieldReferences}\n'

export function installRecordFieldExport(sourceRoot, expectedHash) {
    const path = resolve(sourceRoot, 'ext/js/dictionary/term-record-opfs-store.js')
    const url = pathToFileURL(path).href
    const original = readFileSync(path, 'utf8')
    const sha256 = (value) => createHash('sha256').update(value).digest('hex')
    assert.equal(sha256(original), expectedHash)
    const instrumented = original + diagnosticExport
    let seen = 0
    const hook = registerHooks({
        load(request, context, nextLoad) {
            const result = nextLoad(request, context)
            if (request !== url) return result
            assert.equal(sha256(result.source), expectedHash)
            ++seen
            return {...result, source: instrumented}
        },
    })
    return {
        receipt: {path, originalSha256: expectedHash, appendedExport: diagnosticExport, instrumentedSha256: sha256(instrumented), productFunctionBodiesUnchanged: true},
        finish() {
            hook.deregister()
            assert.equal(seen, 1, 'One actual current module received only the diagnostic named export')
        },
    }
}
