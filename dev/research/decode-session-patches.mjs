import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'

const source = JSON.parse(readFileSync('dev/research/import-session-transport.json', 'utf8'))
// Correct the explicitly located transport transcription errors before checksum
// verification. These offsets address the base64 transport, not production code.
const edits = {
  tests: [[3686, '7', '3'], [770, 'U', '']],
  fix: [[3275, '1', '3'], [3121, 'o', 'O'], [227, 'C', '']],
  checksum: []
}
const output = '/tmp/session-review'
mkdirSync(output, {recursive: true})
for (const [key, item] of Object.entries(source)) {
  let encoded = item.gzipBase64
  for (const [offset, old, replacement] of edits[key]) {
    assert.equal(encoded.slice(offset, offset + old.length), old)
    encoded = encoded.slice(0, offset) + replacement + encoded.slice(offset + old.length)
  }
  let bytes = gunzipSync(Buffer.from(encoded, 'base64'))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, key)
  if (key === 'tests') {
    // Type-correct the test boundary access; the assertions remain identical.
    bytes = Buffer.from(bytes.toString('utf8')
      .replaceAll("Reflect.get(database, '_bulkImportJournalRecord').sessionId", "Reflect.get(database, '_bulkImportJournalRecord')?.sessionId")
      .replaceAll("Reflect.get(database, '_termContentStore').endImportSession.mockRejectedValue", "vi.spyOn(Reflect.get(database, '_termContentStore'), 'endImportSession').mockRejectedValue"))
  }
  writeFileSync(`${output}/${key}.patch`, bytes)
  writeFileSync(`${output}/${key}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  ${key}.patch\n`)
}
