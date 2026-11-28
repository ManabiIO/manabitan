import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync, writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'

const root = '/workspace/scratch/2ed731c9ad68/native-score-plan'
const baseline = '49b426371ace2542710ab2b7a3e0e0915b6c4e35'
const file = 'ext/js/dictionary/term-record-opfs-store.js'
const output = '/workspace/scratch/2ed731c9ad68/native-score-evidence/origin-style-ast-bridge.json'
const {parse} = createRequire(path.join(root, 'package.json'))('espree')
const before = execFileSync('git', ['show', `${baseline}:${file}`], {cwd: root, encoding: 'utf8'})
const after = readFileSync(path.join(root, file), 'utf8')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const options = {ecmaVersion: 'latest', sourceType: 'module'}
const asts = [parse(before, options), parse(after, options)]

function visit(node, callback) {
    if (!node || typeof node !== 'object') { return }
    if (Array.isArray(node)) {
        for (const item of node) { visit(item, callback) }
        return
    }
    callback(node)
    for (const item of Object.values(node)) { visit(item, callback) }
}

function bindings(pattern, names) {
    if (!pattern) { return }
    if (pattern.type === 'Identifier') { names.push(pattern.name) }
    if (pattern.type === 'RestElement') { bindings(pattern.argument, names) }
    if (pattern.type === 'AssignmentPattern') { bindings(pattern.left, names) }
    if (pattern.type === 'ArrayPattern') {
        for (const item of pattern.elements) { bindings(item, names) }
    }
    if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) {
            bindings(property.type === 'RestElement' ? property.argument : property.value, names)
        }
    }
}

for (const [index, ast] of asts.entries()) {
    const names = []
    const declarations = []
    visit(ast, (node) => {
        if (node.type === 'VariableDeclarator') {
            bindings(node.id, names)
            if (node.id.type === 'Identifier' && node.id.name === 'sourceScorePlan') { declarations.push(node) }
        }
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
            bindings(node.id, names)
            for (const parameter of node.params) { bindings(parameter, names) }
        }
        if (node.type === 'CatchClause') { bindings(node.param, names) }
        if (['ClassDeclaration', 'ClassExpression'].includes(node.type)) { bindings(node.id, names) }
        if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) {
            bindings(node.local, names)
        }
    })
    assert(!names.includes('undefined'), 'The module must not bind or shadow undefined')
    assert.equal(declarations.length, 1)
    const initializer = declarations[0].init
    assert.equal(initializer.type, 'ConditionalExpression')
    const alternate = initializer.alternate
    if (index === 0) {
        assert.equal(alternate.type, 'Identifier')
        assert.equal(alternate.name, 'undefined')
    } else {
        assert.equal(alternate.type, 'UnaryExpression')
        assert.equal(alternate.operator, 'void')
        assert.equal(alternate.argument.type, 'Literal')
        assert.equal(alternate.argument.value, 0)
    }
    initializer.alternate = {type: 'Identifier', name: '__proven_undefined_constant__'}
}

const metadata = new Set(['start', 'end', 'loc', 'range', 'raw', 'tokens', 'comments'])
function canonical(value) {
    if (typeof value === 'bigint') { return {$bigint: value.toString()} }
    if (value instanceof RegExp) { return {$regexp: value.source, flags: value.flags} }
    if (Array.isArray(value)) { return value.map(canonical) }
    if (!value || typeof value !== 'object') { return value }
    return Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)).map(([key, item]) => [key, canonical(item)]))
}
const normalized = asts.map((ast) => JSON.stringify(canonical(ast)))
assert.equal(normalized[0], normalized[1], 'Executable runtime AST differs beyond the proven undefined constant spelling')
const changedRuntime = execFileSync('git', ['diff', '--name-only', baseline, '--', 'ext'], {cwd: root, encoding: 'utf8'}).trim().split('\n')
assert.deepEqual(changedRuntime, [file])
const proof = {
    complete: true,
    parityCommit: baseline,
    runtimeFile: file,
    beforeSha256: sha(before),
    afterSha256: sha(after),
    normalizedAstSha256: sha(normalized[0]),
    exactAstExceptSingleConstantSpelling: true,
    constantProof: 'The module contains no binding named undefined. The sole sourceScorePlan alternate changes from the immutable global undefined value to void 0. Both expressions have the same value and no side effects.',
    otherChanges: 'Comments and layout only in the complete runtime AST. Test-file changes require their own test/lint/type validation and are not part of this runtime bridge.',
    sourceOfCorrectness: 'The 204-group production replay remains bound to the immutable parity commit; this receipt only connects its runtime behavior to the later lint cleanup.',
}
writeFileSync(output, JSON.stringify(proof, null, 2) + '\n', {flag: 'wx'})
process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
