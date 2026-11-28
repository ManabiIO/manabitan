/* SPDX-License-Identifier: GPL-3.0-or-later */
// Source-only workflow preparation. No product import, workload or clock reader.
import assert from 'node:assert/strict'
import {cp, mkdir, readFile, realpath, statfs, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {fileDigest, hostBinding, pathWithin, requireSealedDefinition, sha,
    validatePreparedInputs, verifyHarnessFiles} from './corpus/receipt-adapter.mjs'

export function storageBudget(policy, freeBytes, filesystemType) {
    assert.equal(policy.status, 'sealed')
    assert.equal(policy.observationsPerReplication, 42)
    assert.equal(policy.finalSinkBytesPerObservation, 43315677)
    assert.equal(policy.fieldBufferBytesPerObservation, 4239960)
    const retained = BigInt(policy.observationsPerReplication) *
        BigInt(policy.finalSinkBytesPerObservation + policy.fieldBufferBytesPerObservation)
    assert.equal(retained, BigInt(policy.totalRetainedRawBytes))
    const minimum = BigInt(policy.minimumFreeBytesBeforeReplication)
    assert.ok(minimum >= retained + BigInt(policy.freeReserveBytes) + BigInt(policy.fixedOverheadAllowanceBytes))
    assert.equal(policy.freeReserveBytes, 4 * 1024 ** 3)
    assert.equal(policy.minimumFreeBytesBeforeEachObservation, policy.freeReserveBytes)
    assert.ok(BigInt(freeBytes) >= minimum, 'Insufficient prepared-host capacity for all 42 retained original sinks')
    assert.notEqual(BigInt(filesystemType), 0x01021994n, 'The workload sink cannot be tmpfs')
    return {passed: true, freeBytes: String(freeBytes), filesystemType: String(filesystemType),
        retainedRawBytes: String(retained), minimumFreeBytes: String(minimum),
        freeReserveBytes: String(policy.freeReserveBytes),
        fixedOverheadAllowanceBytes: String(policy.fixedOverheadAllowanceBytes),
        allOriginalRawSinksRetained: true, deletionActions: 0}
}

export async function prepare(argumentsList) {
    const [operation, planArgument, workspaceArgument, replication] = argumentsList
    assert.ok(operation === 'stage' || operation === 'preflight')
    const planBytes = await readFile(resolve(planArgument))
    const expectedPlanSha = sha(planBytes)
    const plan = JSON.parse(planBytes)
    requireSealedDefinition(plan)
    const host = await hostBinding(plan, replication)
    const workspace = resolve(workspaceArgument)
    if (operation === 'stage') {
        const source = dirname(fileURLToPath(import.meta.url))
        assert.equal(plan.preparationReceipt.relativePath, 'screen-kit/references/preparation.json')
        const preparation = join(source, 'references', 'preparation.json')
        assert.equal((await fileDigest(preparation)).sha256, plan.preparationReceipt.sha256)
        await mkdir(workspace, {recursive: false})
        await cp(source, join(workspace, 'screen-kit'), {recursive: true, errorOnExist: true, force: false})
        await verifyHarnessFiles(workspace, plan)
        const target = pathWithin(workspace, plan.preparationReceipt.relativePath)
        assert.equal((await fileDigest(target)).sha256, plan.preparationReceipt.sha256)
        await writeFile(join(workspace, 'frozen-plan.json'), planBytes, {flag: 'wx'})
        await mkdir(join(workspace, 'preparation'))
        await writeFile(join(workspace, 'preparation', 'host.json'), JSON.stringify(host, null, 2) + '\n', {flag: 'wx'})
        return
    }
    assert.equal(await realpath(workspace), workspace)
    const prepared = {}
    for (const arm of ['A', 'B', 'C']) prepared[arm] = await validatePreparedInputs({plan, workspace, arm, mode: 'untimed', replication})
    const space = await statfs(workspace, {bigint: true})
    const capacity = storageBudget(plan.storagePolicy, space.bavail * space.bsize, space.type)
    // This preflight reads sources and capacity only. The six fixed untimed
    // warmups are the first importer executions and the integration gate.
    await writeFile(join(workspace, 'preparation', 'complete.json'), JSON.stringify({passed: true, host,
        planSha256: expectedPlanSha, prepared, capacity, dictionaryImports: 0, performanceMeasurements: false}, null, 2) + '\n', {flag: 'wx'})
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    await prepare(process.argv.slice(2))
}
