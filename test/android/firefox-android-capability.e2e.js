import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstat, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import path, {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {runWebExtInstallHandshake} from './web-ext-install-handshake.js';
import {findWebExtRdpPort, GeckoRdpProtocolError, probeInstalledAddon} from './firefox-android-rdp.js';
import {collectAndroidNativeFailureEvidence} from './firefox-android-native-failure-evidence.js';
import {prepareAndroidNativeReadiness} from './firefox-android-native-readiness.js';
import {qualifyAndroidDictionaryRuntime} from './firefox-android-runtime-qualification.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const execFileAsync = promisify(execFile);
const outputPath = resolve(root, process.env.MANABITAN_ANDROID_CAPABILITY_REPORT || path.join(root, 'builds', 'firefox-android-capability-report.json'));
const runtimeQualificationTimeoutMs = Number(process.env.MANABITAN_ANDROID_RUNTIME_QUALIFICATION_TIMEOUT_MS || 600_000);
assert.ok(Number.isFinite(runtimeQualificationTimeoutMs) && runtimeQualificationTimeoutMs > 0, 'MANABITAN_ANDROID_RUNTIME_QUALIFICATION_TIMEOUT_MS must be a finite positive number');
/** @typedef {{status: string, timeoutMs: number, stages: Array<{name?: string, value?: unknown}>, errors: string[], verifiedCapabilities: string[], unverifiedCapabilities: string[]}} RuntimeQualificationReport */
/** @typedef {{startedAtIso: string, finishedAtIso: string, status: string, verificationScope: string, adbDevice: string, androidVersion: string, androidApiLevel: string, firefoxPackage: string, firefoxVersion: string, sourceCommit: string, buildIdentity: {sourceDir: string, manifestSha256: string, packageTreeSha256: string, extensionId: string, extensionName: string, version: string|number}, extensionId: string, rdpPort: number|null, rdpTargetIdentity: Record<string, unknown>|null, addonContext: Record<string, unknown>|null, nativeReadiness: Record<string, unknown>|null, contextProbeStatus: string, contextBlocker: string, protocolErrorResponse: Record<string, unknown>|null, executedCapabilities: string[], unverifiedCapabilities: string[], failureReason: string, runtimeQualification: RuntimeQualificationReport}} CapabilityReport */
/** @type {CapabilityReport} */
const report = {
    startedAtIso: new Date().toISOString(),
    finishedAtIso: '',
    status: 'running',
    verificationScope: 'actual-gecko-rdp-actor-discovery',
    adbDevice: '',
    androidVersion: '',
    androidApiLevel: '',
    firefoxPackage: process.env.MANABITAN_ANDROID_FIREFOX_PACKAGE || 'org.mozilla.firefox',
    firefoxVersion: '',
    sourceCommit: '',
    buildIdentity: {sourceDir: '', manifestSha256: '', packageTreeSha256: '', extensionId: '', extensionName: '', version: ''},
    extensionId: '',
    rdpPort: null,
    rdpTargetIdentity: null,
    addonContext: null,
    nativeReadiness: null,
    contextProbeStatus: 'not-run',
    contextBlocker: '',
    protocolErrorResponse: null,
    executedCapabilities: [],
    unverifiedCapabilities: ['extension-context-evaluation', 'dictionary-import', 'dictionary-lookup', 'anki-mining', 'dictionary-update'],
    failureReason: '',
    runtimeQualification: {status: 'not-run', timeoutMs: runtimeQualificationTimeoutMs, stages: [], errors: [], verifiedCapabilities: [], unverifiedCapabilities: ['dictionary-import', 'dictionary-lookup', 'anki-mining', 'dictionary-update']},
};

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} [options]
 * @returns {Promise<string>}
 */
async function run(command, args, options = {}) {
    const result = await execFileAsync(command, args, {cwd: root, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, ...options});
    return String(result.stdout || '').trim();
}

/** @returns {Promise<void>} */
async function main() {
    try {
        const adbDevices = await run('adb', ['devices']);
        const devices = adbDevices.split('\n').slice(1)
            .map((line) => line.trim().split(/\s+/))
            .filter((parts) => parts.length > 1 && parts[1] === 'device')
            .map((parts) => parts[0]);
        assert.equal(devices.length, 1, `Expected one Android emulator, found ${JSON.stringify(devices)}`);
        report.adbDevice = devices[0];
        report.sourceCommit = await run('git', ['rev-parse', 'HEAD']);
        report.androidVersion = await run('adb', ['-s', report.adbDevice, 'shell', 'getprop', 'ro.build.version.release']);
        report.androidApiLevel = await run('adb', ['-s', report.adbDevice, 'shell', 'getprop', 'ro.build.version.sdk']);

        const sourceDir = await realpath(String(process.env.MANABITAN_ANDROID_SOURCE_DIR || '').trim() || path.join(root, 'builds', 'manabitan-firefox-android'));
        const manifestBytes = await readFile(path.join(sourceDir, 'manifest.json'));
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        report.extensionId = manifest.browser_specific_settings?.gecko?.id || manifest.applications?.gecko?.id || '';
        assert.ok(report.extensionId, 'Built Firefox Android manifest has no Gecko extension id');
        report.buildIdentity = {
            sourceDir,
            manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
            packageTreeSha256: await hashBuildTree(sourceDir),
            extensionId: report.extensionId,
            extensionName: manifest.name,
            version: manifest.version,
        };

        const packageDetails = await run('adb', ['-s', report.adbDevice, 'shell', 'dumpsys', 'package', report.firefoxPackage]);
        assert.ok(packageDetails.includes(`Package [${report.firefoxPackage}]`), 'Firefox Android is not installed');
        report.firefoxVersion = /versionName=([^\s]+)/.exec(packageDetails)?.[1] || 'unknown';
        await run('bash', [path.join(root, 'test/android/enable-firefox-remote-debugging.sh'), report.adbDevice, report.firefoxPackage]);

        await runWebExtInstallHandshake({
            device: report.adbDevice,
            packageName: report.firefoxPackage,
            sourceDir,
            timeoutMs: Number(process.env.MANABITAN_ANDROID_WEB_EXT_TIMEOUT_MS || 45_000),
            onInstallAcknowledgedTimeoutMs: runtimeQualificationTimeoutMs,
            cwd: root,
            onOutput: (line) => console.log(`[firefox-android-capability] web-ext: ${line}`),
            onInstallAcknowledged: async (outputLines) => {
                report.executedCapabilities.push('temporary-addon-installation');
                report.rdpPort = findWebExtRdpPort(outputLines);
                assert.ok(report.rdpPort, 'web-ext did not announce its Android RDP TCP port after install acknowledgement');
                report.addonContext = await probeInstalledAddon(report.rdpPort, report.extensionId, (capability) => report.executedCapabilities.push(capability), /** @param {Record<string, unknown>} evidence */ (evidence) => { report.addonContext = evidence; }, async (session) => {
                    report.runtimeQualification.status = 'running';
                    report.contextProbeStatus = 'passed';
                    report.executedCapabilities.push('gecko-rdp-evaluate-extension-context');
                    report.verificationScope = 'actual-gecko-rdp-extension-context+android-runtime-qualification';
                    report.unverifiedCapabilities = report.unverifiedCapabilities.filter((capability) => capability !== 'extension-context-evaluation');
                    assert.ok(session.backgroundTarget, 'Accepted runtime context has no background target');
                    const acceptedTarget = session.backgroundTarget;
                    report.rdpTargetIdentity = {
                        extensionId: report.extensionId,
                        targetActor: acceptedTarget.actor ?? null,
                        targetType: acceptedTarget.targetType ?? acceptedTarget.type ?? null,
                        innerWindowId: acceptedTarget.innerWindowId ?? null,
                        url: acceptedTarget.url ?? null,
                        consoleActor: acceptedTarget.consoleActor ?? null,
                    };
                    let runtimeReport;
                    try {
                        runtimeReport = await qualifyAndroidDictionaryRuntime({
                            extensionId: session.extensionId,
                            backgroundTarget: session.backgroundTarget,
                            evaluate: session.evaluate,
                            waitForTarget: session.waitForTarget,
                            fixtureDirectory: path.join(root, 'test', 'data', 'dictionaries', 'valid-dictionary1'),
                            adbDevice: report.adbDevice,
                            runtimeQualificationTimeoutMs,
                            prepareNativeReadiness: async () => {
                                try {
                                    const nativeReadiness = await prepareAndroidNativeReadiness({
                                        adbDevice: report.adbDevice,
                                        packageName: report.firefoxPackage,
                                        extensionName: String(manifest.name || ''),
                                        outputDirectory: path.join(root, 'builds', 'firefox-android-native-readiness'),
                                    });
                                    report.nativeReadiness = nativeReadiness;
                                    return nativeReadiness;
                                } catch (error) {
                                    if (isRecord(error) && isRecord(error.nativeReadiness)) { report.nativeReadiness = error.nativeReadiness; }
                                    throw error;
                                }
                            },
                            onFailureEvidence: (stage) => collectAndroidNativeFailureEvidence({
                                adbDevice: report.adbDevice,
                                outputDirectory: path.join(root, 'builds', 'firefox-android-capability-diagnostics'),
                                stage,
                            }),
                        });
                    } catch (error) {
                        report.runtimeQualification = isRecord(error) && isRecord(error.runtimeQualification) ? /** @type {RuntimeQualificationReport} */ (error.runtimeQualification) : {status: 'failure', timeoutMs: runtimeQualificationTimeoutMs, stages: [], errors: [error instanceof Error ? `${error.name}: ${error.message}` : String(error)], verifiedCapabilities: [], unverifiedCapabilities: ['dictionary-import', 'dictionary-lookup', 'anki-mining', 'dictionary-update']};
                        report.runtimeQualification.timeoutMs = runtimeQualificationTimeoutMs;
                        report.verificationScope = 'actual-gecko-rdp-extension-context+partial-android-runtime-qualification';
                        report.executedCapabilities.push(...report.runtimeQualification.verifiedCapabilities);
                        report.unverifiedCapabilities = [...new Set([...report.unverifiedCapabilities.filter((capability) => !report.runtimeQualification.verifiedCapabilities.includes(capability)), ...report.runtimeQualification.unverifiedCapabilities])];
                        throw error;
                    }
                    report.runtimeQualification = runtimeReport;
                    report.executedCapabilities.push(...runtimeReport.verifiedCapabilities);
                    report.unverifiedCapabilities = [...new Set(runtimeReport.unverifiedCapabilities)];
                }, 60_000);
                const target = report.addonContext;
                const targetForm = isRecord(target.targetForm) ? target.targetForm : {};
                const watcherResponse = isRecord(target.watcherResponse) ? target.watcherResponse : {};
                report.rdpTargetIdentity = {
                    extensionId: report.extensionId,
                    addonActor: target.addonActor,
                    watcherActor: watcherResponse.actor ?? watcherResponse.watcher,
                    targetActor: target.targetActor,
                    targetType: targetForm.targetType,
                    innerWindowId: targetForm.innerWindowId,
                    url: targetForm.url,
                    consoleActor: target.consoleActor,
                };
                report.verificationScope = 'actual-gecko-rdp-actor-discovery';
                const evaluationReply = target.evaluation;
                if (evaluationReply === null) {
                    report.contextProbeStatus = 'not-exposed';
                    report.contextBlocker = `Raw actor responses did not expose a console actor. descriptor=${JSON.stringify(target.descriptorResponse)} target=${JSON.stringify(target.targetForm)} legacy=${JSON.stringify(target.legacyTargetResponse)} attach=${JSON.stringify(target.attachResponse)}`;
                } else {
                    assert.ok(isRecord(evaluationReply), 'Gecko RDP evaluation evidence is malformed');
                    const evaluationResult = evaluationReply.result;
                    assert.ok(isRecord(evaluationResult), 'Gecko RDP evaluation result event is malformed');
                    assert.notEqual(evaluationResult.hasException, true, 'Gecko RDP extension-context evaluation raised an exception');
                    const remoteResult = isRecord(evaluationResult.result) ? evaluationResult.result : null;
                    const evaluationText = remoteResult?.value ?? evaluationResult.result;
                    let evaluation = null;
                    if (typeof evaluationText === 'string') {
                        try { evaluation = JSON.parse(evaluationText); } catch { /* Protocol evidence remains in the raw response. */ }
                    } else if (typeof evaluationText === 'object' && evaluationText !== null) {
                        evaluation = evaluationText;
                    }
                    assert.equal(evaluation?.hasExtensionRuntime, true, 'Gecko RDP evaluation did not run in an extension API context');
                    assert.equal(evaluation.runtimeId, report.extensionId, 'Evaluated runtime id does not match the built extension');
                    report.verificationScope = report.runtimeQualification.status === 'success' ? 'actual-gecko-rdp-extension-context+android-runtime-qualification' : 'actual-gecko-rdp-extension-context+partial-android-runtime-qualification';
                    report.contextProbeStatus = 'passed';
                    if (!report.executedCapabilities.includes('gecko-rdp-evaluate-extension-context')) { report.executedCapabilities.push('gecko-rdp-evaluate-extension-context'); }
                    report.unverifiedCapabilities = report.unverifiedCapabilities.filter((capability) => capability !== 'extension-context-evaluation');
                }
            },
        });
        report.status = 'success';
    } catch (error) {
        report.status = 'failure';
        report.failureReason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (isRecord(error) && isRecord(error.evidence)) { report.addonContext = error.evidence; }
        if (error instanceof GeckoRdpProtocolError) { report.protocolErrorResponse = error.packet; }
    } finally {
        report.finishedAtIso = new Date().toISOString();
        try {
            await mkdir(dirname(outputPath), {recursive: true});
            const outputDirectory = await realpath(dirname(outputPath));
            const resolvedOutput = resolve(outputDirectory, path.basename(outputPath));
            let shouldWrite = true;
            try {
                if ((await lstat(resolvedOutput)).isSymbolicLink()) {
                    shouldWrite = false;
                    report.status = 'failure';
                    report.failureReason = `Refusing to overwrite a symlinked capability report path: ${resolvedOutput}`;
                }
            } catch (error) {
                if (!isNodeError(error, 'ENOENT')) {
                    shouldWrite = false;
                    report.status = 'failure';
                    report.failureReason = `Could not inspect capability report path: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
            if (shouldWrite) {
                await writeFile(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`);
                console.log(`[firefox-android-capability] report=${resolvedOutput} status=${report.status}`);
            }
        } catch (error) {
            report.status = 'failure';
            report.failureReason = `Could not write capability report: ${error instanceof Error ? error.message : String(error)}`;
            console.error(`[firefox-android-capability] ${report.failureReason}`);
        }
    }
    if (report.status !== 'success') { throw new Error(report.failureReason); }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hash the exact built unpacked package tree and reject symlinks so this identity does not
 * depend on files outside the build directory.
 * @param {string} directory
 * @returns {Promise<string>}
 */
async function hashBuildTree(directory) {
    const hash = createHash('sha256');
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        const entryStat = await lstat(entryPath);
        if (entryStat.isSymbolicLink()) { throw new Error(`Built package contains symlink: ${entryPath}`); }
        hash.update(entry.name);
        if (entryStat.isDirectory()) {
            hash.update(await hashBuildTree(entryPath));
        } else if (entryStat.isFile()) {
            hash.update(await readFile(entryPath));
        } else {
            throw new Error(`Built package contains an unsupported file type: ${entryPath}`);
        }
    }
    return hash.digest('hex');
}

/**
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isNodeError(error, code) {
    return isRecord(error) && error.code === code;
}

await main();
