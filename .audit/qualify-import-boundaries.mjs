import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {join} from 'node:path'

const payload = JSON.parse(readFileSync('.audit/import-boundary-payload.json', 'utf8'))
const kind = process.argv[2]
const spec = payload.patches.find((item) => item.kind === kind)
assert.ok(spec, `Unknown qualification kind: ${kind}`)
const out = join(process.env.RUNNER_TEMP || '/tmp', `manabitan-boundary-${kind}`)
mkdirSync(out, {recursive: true})
const log = {}
function run(name, command, args, options = {}) {
    console.log(`START ${name}: ${command} ${args.join(' ')}`)
    const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options})
    const text = `${result.stdout || ''}\n${result.stderr || ''}`
    writeFileSync(join(out, `${name}.log`), text)
    log[name] = {status: result.status, signal: result.signal}
    assert.ifError(result.error)
    console.log(`END ${name}: exit=${result.status}`)
    if (result.status !== 0 && !options.allowFailure) {
        console.error(text.slice(-16000))
        throw new Error(`${name} failed (${result.status})`)
    }
    return {status: result.status, text, stdout: result.stdout || ''}
}
function git(args, options) {return run(`git-${args[0]}-${Object.keys(log).length}`, 'git', args, options).stdout.trim()}
try {
    assert.equal(git(['rev-parse', `${payload.base}^{commit}`]), payload.base)
    assert.equal(git(['hash-object', spec.source]), spec.sourceBlob, 'Source baseline changed')
    const patchPath = join(out, 'candidate.patch')
    // Repair two transport transcription errors, then verify the original
    // local artifact's SHA-256 before applying any test or production change.
    const encoded = spec.patch.replace('X3kf8vrG328', 'X3kf8vrGfr328').replace('PReIPmSr1efIP242', 'PReIPmSr1ef4v242')
    const patch = gunzipSync(Buffer.from(encoded, 'base64'))
    const expected = kind === 'css' ? 'ecf61022212c2a45bffe011a5d8da693ce900f96636914b9734e9a7e25a54ace' : '4022eba8f60ab5b855ead8890835ad4984c15fe0cf21d81fa6d3a7a1408b0a4d'
    assert.equal(createHash('sha256').update(patch).digest('hex'), expected, 'Patch transport differs from tested artifact')
    writeFileSync(patchPath, patch)
    git(['apply', '--check', patchPath])
    git(['apply', '--include=test/**', patchPath])
    if (kind === 'zip') {
        const file = spec.tests[0]
        const text = readFileSync(file, 'utf8')
        writeFileSync(file, text.replace(' * @param {string} [raw]\n */', ' * @param {string} [raw]\n * @returns {FilenameEntry}\n */'))
    }
    if (kind === 'css') {
        const baseline = run('baseline', process.execPath, ['--test', '--test-reporter=tap', spec.tests[1]], {allowFailure: true})
        assert.equal(baseline.status, 1)
        assert.match(baseline.text, new RegExp(`# tests ${spec.total}\\b`, 'u'))
        assert.match(baseline.text, /# fail [1-9][0-9]*\b/u)
    } else {
        const resultFile = join(out, 'baseline.json')
        const baseline = run('baseline', 'npx', ['vitest', 'run', spec.tests[0], '--reporter=json', `--outputFile=${resultFile}`, '--maxWorkers=1', '--no-file-parallelism'], {allowFailure: true})
        assert.equal(baseline.status, 1)
        const result = JSON.parse(readFileSync(resultFile, 'utf8'))
        assert.equal(result.numTotalTests, spec.total)
        assert.ok(result.numFailedTests > 0)
        assert.equal(result.numRuntimeErrorTestSuites, 0)
    }
    git(['apply', '--include=ext/**', patchPath])
    if (kind === 'css') {
        run('candidate-native', process.execPath, ['--test', '--test-reporter=tap', spec.tests[1]])
    }
    run('candidate-vitest', 'npx', ['vitest', 'run', spec.tests[0], '--maxWorkers=1', '--no-file-parallelism'])
    run('changed-eslint', 'npx', ['eslint', spec.source, ...spec.tests])
    run('typescript', 'npm', ['run', 'test:ts'])
    run('unit', 'npm', ['run', 'test:unit', '--', '--maxWorkers=1', '--no-file-parallelism'])
    run('license-report', 'npm', ['run', 'license-report:html'])
    run('build', 'npm', ['run', 'test:build'])
    git(['diff', '--check'])
    const files = [spec.source, ...spec.tests].sort()
    const hashes = Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
    writeFileSync(join(out, 'qualified-files.json'), JSON.stringify({base: payload.base, files, hashes}, null, 2) + '\n')
    // This separate index excludes audit transport and generated libraries.
    const env = {...process.env, GIT_INDEX_FILE: join(out, 'product.index')}
    git(['read-tree', payload.base], {env})
    git(['add', '--', ...files], {env})
    const tree = git(['write-tree'], {env})
    git(['config', 'user.name', 'github-actions[bot]'])
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
    const title = kind === 'css' ? 'fix(mdict): preserve escaped CSS scanner boundaries' : 'fix(import): preserve leading U+FEFF in ZIP filename aliases'
    const commit = git(['commit-tree', tree, '-p', payload.base, '-m', title])
    assert.deepEqual(git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n').sort(), files)
    assert.equal(git(['ls-remote', '--heads', 'origin', `refs/heads/${spec.branch}`]), '', 'Ref already exists; refusing to overwrite')
    git(['push', 'origin', `${commit}:refs/heads/${spec.branch}`])
    const summary = {kind, base: payload.base, branch: spec.branch, head: commit, files, hashes, checks: log}
    writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    console.log(`PUBLISHED ${JSON.stringify(summary)}`)
} finally {
    writeFileSync(join(out, 'checks.json'), JSON.stringify(log, null, 2) + '\n')
}
