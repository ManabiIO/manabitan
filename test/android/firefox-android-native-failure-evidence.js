import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstat, mkdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const collectionBudgetMs = 40_000;

/**
 * Capture bounded native state before runtime-owned browser tabs are closed.
 * Every artifact is best-effort and records its own timestamp and outcome.
 * @param {{adbDevice: string, outputDirectory: string, stage: string, runCommand?: (args: string[], options: import('node:child_process').ExecFileOptions) => Promise<{stdout: Buffer|string}>}} options
 * @returns {Promise<{stage: string, capturedAtIso: string, artifacts: Record<string, Record<string, unknown>>}>}
 */
export async function collectAndroidNativeFailureEvidence({adbDevice, outputDirectory, stage, runCommand = (args, options) => execFileAsync('adb', args, options)}) {
    assert.ok(adbDevice, 'Native failure evidence requires the selected adb serial');
    const startedAtIso = new Date().toISOString();
    const parent = path.dirname(outputDirectory);
    await mkdir(parent, {recursive: true});
    const resolvedParent = await realpath(parent);
    const resolvedDirectory = path.resolve(resolvedParent, path.basename(outputDirectory));
    await mkdir(resolvedDirectory, {recursive: true});
    assert.equal(await realpath(resolvedDirectory), resolvedDirectory, 'Native evidence directory resolved outside its owned target');
    const runPath = path.join(resolvedDirectory, `${startedAtIso.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`);
    await mkdir(runPath);
    const deadline = Date.now() + collectionBudgetMs;
    const remoteHierarchyPath = `/sdcard/manabitan-android-capability-${randomUUID()}.xml`;

    /** @type {Record<string, {args: string[], filename: string, encoding?: 'buffer'}>} */
    const commands = {
        screenshot: {args: ['exec-out', 'screencap', '-p'], filename: 'screenshot.png', encoding: 'buffer'},
        activity: {args: ['shell', 'dumpsys', 'activity', 'activities'], filename: 'activity-activities.txt'},
        windows: {args: ['shell', 'dumpsys', 'window', 'windows'], filename: 'window-windows.txt'},
        uiHierarchy: {args: ['shell', 'uiautomator', 'dump', remoteHierarchyPath], filename: 'ui-hierarchy.xml'},
    };
    /** @type {Record<string, Record<string, unknown>>} */
    const artifacts = {};
    for (const [name, command] of Object.entries(commands)) {
        const capturedAtIso = new Date().toISOString();
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            artifacts[name] = {status: 'error', capturedAtIso, error: 'Native failure evidence collection deadline exceeded'};
            continue;
        }
        try {
            const options = {timeout: remainingMs, maxBuffer: 16 * 1024 * 1024, encoding: command.encoding};
            let bytes;
            if (name === 'uiHierarchy') {
                await runCommand(['-s', adbDevice, ...command.args], options);
                const dumpRemainingMs = deadline - Date.now();
                if (dumpRemainingMs <= 0) { throw new Error('Native failure evidence collection deadline exceeded before hierarchy readback'); }
                ({stdout: bytes} = await runCommand(['-s', adbDevice, 'exec-out', 'cat', remoteHierarchyPath], {...options, timeout: dumpRemainingMs}));
            } else {
                ({stdout: bytes} = await runCommand(['-s', adbDevice, ...command.args], options));
            }
            const target = path.join(runPath, command.filename);
            try {
                assert.equal((await lstat(target)).isSymbolicLink(), false, `Refusing symlinked native evidence artifact: ${target}`);
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { throw error; }
            }
            const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
            await writeFile(target, data, {flag: 'wx'});
            artifacts[name] = {status: 'success', capturedAtIso, path: path.relative(resolvedDirectory, target), bytes: data.byteLength, binary: Buffer.isBuffer(bytes)};
        } catch (error) {
            artifacts[name] = {status: 'error', capturedAtIso, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)};
        }
    }
    return {stage, capturedAtIso: startedAtIso, artifacts};
}
