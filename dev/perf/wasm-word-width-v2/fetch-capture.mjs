import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {fileURLToPath} from 'node:url'

const scripts = path.dirname(fileURLToPath(import.meta.url))
const specBytes = fs.readFileSync(path.join(scripts, 'capture-artifact.json'))
const spec = JSON.parse(specBytes)
const [repository, captureDir, receiptFile] = process.argv.slice(2)
assert(repository && captureDir && receiptFile, 'Expected repository captureDir receiptFile')
assert.equal(repository.toLowerCase(), spec.repository.toLowerCase())
const token = process.env.GITHUB_TOKEN
assert(token, 'GITHUB_TOKEN is required to read the frozen artifact')
const api = 'https://api.github.com'
const headers = {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}
async function json(endpoint) {
    const response = await fetch(`${api}/repos/${repository}${endpoint}`, {headers, redirect: 'error'})
    assert(response.ok, `GitHub metadata request failed with HTTP ${response.status}`)
    return await response.json()
}
const metadata = await json(`/actions/artifacts/${spec.artifactId}`)
assert.equal(metadata.id, spec.artifactId)
assert.equal(metadata.name, spec.artifactName)
assert.equal(metadata.size_in_bytes, spec.artifactBytes)
assert.equal(metadata.digest, `sha256:${spec.artifactSha256}`)
assert.equal(metadata.expired, false)
assert.equal(metadata.workflow_run.id, spec.runId)
assert.equal(metadata.workflow_run.head_sha, spec.sourceHeadSha)
assert.equal(metadata.workflow_run.head_branch, spec.sourceBranch)
const run = await json(`/actions/runs/${spec.runId}/attempts/${spec.runAttempt}`)
assert.equal(run.id, spec.runId)
assert.equal(run.run_attempt, spec.runAttempt)
assert.equal(run.head_sha, spec.sourceHeadSha)
assert.equal(run.repository.full_name.toLowerCase(), spec.repository.toLowerCase())

const destination = path.resolve(captureDir)
fs.mkdirSync(destination, {recursive: true})
assert.equal(fs.readdirSync(destination).length, 0, 'Capture destination must be empty')
const archive = path.join(path.dirname(destination), `capture-${spec.artifactId}.zip`)
let download = await fetch(`${api}/repos/${repository}/actions/artifacts/${spec.artifactId}/zip`, {headers, redirect: 'manual'})
if (download.status >= 300 && download.status < 400) {
    const location = download.headers.get('location')
    assert(location && new URL(location).protocol === 'https:')
    // The GitHub token is never forwarded to the signed artifact storage URL.
    download = await fetch(location, {redirect: 'follow'})
}
assert(download.ok && download.body, `Artifact download failed with HTTP ${download.status}`)
const hash = crypto.createHash('sha256')
let bytes = 0
const observer = new Transform({
    transform(chunk, encoding, callback) {
        hash.update(chunk)
        bytes += chunk.length
        callback(null, chunk)
    },
})
await pipeline(Readable.fromWeb(download.body), observer, fs.createWriteStream(archive))
const sha256 = hash.digest('hex')
assert.equal(bytes, spec.artifactBytes)
assert.equal(sha256, spec.artifactSha256)
const extract = spawnSync('python3', ['-c', `
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    members = archive.infolist()
    assert len(members) <= 64
    assert sum(item.file_size for item in members) <= 64 * 1024 * 1024
    for item in members:
        name = PurePosixPath(item.filename)
        assert not name.is_absolute() and '..' not in name.parts
        assert stat.S_IFMT(item.external_attr >> 16) != stat.S_IFLNK
    archive.extractall(sys.argv[2])
`, archive, destination], {encoding: 'utf8'})
assert.equal(extract.status, 0, extract.stderr)
const reportBytes = fs.readFileSync(path.join(destination, 'report.json'))
const report = JSON.parse(reportBytes)
assert.equal(report.complete, true)
assert.equal(report.dictionary, 'jmdict')
assert.equal(report.fixture.sha256, spec.fixtureSha256)
assert.equal(report.parserWasmSha256, spec.parserWasmSha256)
assert.equal(report.summary.rows, spec.termRows)
assert.equal(report.groups.length, spec.groups)
for (let index = 1; index <= spec.groups; ++index) assert(fs.existsSync(path.join(destination, `group-${String(index).padStart(2, '0')}.bin.gz`)))
const receipt = {
    spec,
    node: process.version,
    currentWorkflowHeadSha: process.env.GITHUB_SHA ?? null,
    sourceRun: {id: run.id, attempt: run.run_attempt, headSha: run.head_sha},
    downloadedArchive: {bytes, sha256},
    captureReportSha256: crypto.createHash('sha256').update(reportBytes).digest('hex'),
    fetchScriptSha256: crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    specificationSha256: crypto.createHash('sha256').update(specBytes).digest('hex'),
}
fs.mkdirSync(path.dirname(path.resolve(receiptFile)), {recursive: true})
fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
fs.unlinkSync(archive)
console.log(JSON.stringify(receipt))
