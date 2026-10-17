/*
 * Copyright (C) 2023-2025  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import {execFile} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {access, mkdir, readdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {safePerformance} from '../../ext/js/core/safe-performance.js';
import {runWebExtInstallHandshake} from './web-ext-install-handshake.js';
import {extractFirefoxAndroidApkUrls, extractFirefoxAndroidStableReleaseVersions, selectPreferredFirefoxAndroidApkUrl} from './firefox-android-release-utils.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const execFileAsync = promisify(execFile);

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
    if (value instanceof Error && typeof value.message === 'string') {
        return value.message;
    }
    return String(value);
}

/**
 * @param {string} message
 * @throws {Error}
 */
function fail(message) {
    throw new Error(message);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

/**
 * @returns {{
 *   startedAtIso: string,
 *   finishedAtIso: string,
 *   status: 'running'|'success'|'failure',
 *   failureReason: string,
 *   adbDevice: string,
 *   firefoxPackage: string,
 *   sourceDir: string,
 *   firefoxApkUrl: string,
 *   phases: Array<{name: string, details: string, durationMs: number}>
 * }}
 */
function createReport() {
    return {
        startedAtIso: new Date().toISOString(),
        finishedAtIso: '',
        status: 'running',
        failureReason: '',
        adbDevice: '',
        firefoxPackage: '',
        sourceDir: '',
        firefoxApkUrl: '',
        androidDiagnostics: null,
        phases: [],
    };
}

/**
 * @param {ReturnType<typeof createReport>} report
 * @param {string} name
 * @param {string} details
 * @param {number} startMs
 * @param {number} endMs
 */
function addPhase(report, name, details, startMs, endMs) {
    const durationMs = Math.max(0, endMs - startMs);
    report.phases.push({name, details, durationMs});
    console.log(`[firefox-android-e2e] phase: ${name} (${durationMs.toFixed(1)} ms)`);
}

/**
 * @param {ReturnType<typeof createReport>} report
 * @returns {string}
 */
function renderReportHtml(report) {
    const isFailure = report.status === 'failure';
    const bannerClass = isFailure ? 'failed' : 'passed';
    const statusLabel = isFailure ? 'FAILED' : 'PASSED';
    const phasesHtml = report.phases.map((phase, index) => `
        <section class="phase">
            <h3>Phase ${String(index + 1)}: ${escapeHtml(phase.name)}</h3>
            <div><strong>Duration:</strong> ${phase.durationMs.toFixed(1)} ms</div>
            <pre>${escapeHtml(phase.details)}</pre>
        </section>
    `).join('\n');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Firefox Android Extension E2E Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 24px; color: #e5e7eb; background: #0f172a; }
    .banner { padding: 12px 16px; border-radius: 8px; font-weight: 700; margin-bottom: 20px; }
    .banner.failed { background: #7f1d1d; color: #fecaca; }
    .banner.passed { background: #14532d; color: #bbf7d0; }
    .meta { margin-bottom: 16px; }
    .meta div { margin: 2px 0; }
    .phase { border: 1px solid #334155; border-radius: 8px; padding: 12px; margin-bottom: 12px; background: #111827; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; }
  </style>
</head>
<body>
  <div class="banner ${bannerClass}">${statusLabel}</div>
  <div class="meta">
    <div><strong>Started:</strong> ${escapeHtml(report.startedAtIso)}</div>
    <div><strong>Finished:</strong> ${escapeHtml(report.finishedAtIso)}</div>
    <div><strong>Status:</strong> ${escapeHtml(report.status)}</div>
    <div><strong>Failure:</strong> ${escapeHtml(report.failureReason || 'none')}</div>
    <div><strong>ADB Device:</strong> ${escapeHtml(report.adbDevice || 'unknown')}</div>
    <div><strong>Firefox package:</strong> ${escapeHtml(report.firefoxPackage || 'unknown')}</div>
    <div><strong>Source directory:</strong> ${escapeHtml(report.sourceDir || 'unknown')}</div>
    <div><strong>Firefox APK URL:</strong> ${escapeHtml(report.firefoxApkUrl || 'not-used')}</div>
  </div>
  ${phasesHtml}
  ${report.androidDiagnostics ? `<section class="phase"><h2>Android failure diagnostics</h2><pre>${escapeHtml(JSON.stringify(report.androidDiagnostics, null, 2))}</pre></section>` : ''}
</body>
</html>`;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function runCommand(command, args) {
    try {
        const {stdout, stderr} = await execFileAsync(command, args, {cwd: root, env: process.env, maxBuffer: 50 * 1024 * 1024});
        if (typeof stderr === 'string' && stderr.trim().length > 0) {
            console.log(`[firefox-android-e2e] ${command} stderr: ${stderr.trim()}`);
        }
        return String(stdout || '');
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const errorRecord = (typeof e === 'object' && e !== null) ? /** @type {Record<string, unknown>} */ (e) : {};
        const stdout = typeof errorRecord.stdout === 'string' ? errorRecord.stdout.trim() : '';
        const stderr = typeof errorRecord.stderr === 'string' ? errorRecord.stderr.trim() : '';
        fail(`Command failed: ${command} ${args.join(' ')} error=${message} stdout=${stdout} stderr=${stderr}`);
    }
}

/**
 * @returns {Promise<string[]>}
 */
async function listAdbDevices() {
    const output = await runCommand('adb', ['devices']);
    /** @type {string[]} */
    const devices = [];
    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('List of devices attached')) { continue; }
        const parts = line.split(/\s+/);
        if (parts.length >= 2 && parts[1] === 'device') {
            devices.push(parts[0]);
        }
    }
    return devices;
}

/**
 * @param {string[]} devices
 * @returns {string}
 */
function selectAdbDevice(devices) {
    const explicit = String(process.env.MANABITAN_ANDROID_ADB_DEVICE || '').trim();
    if (explicit.length > 0) {
        if (!devices.includes(explicit)) {
            fail(`Requested ADB device "${explicit}" not found. Devices=${JSON.stringify(devices)}`);
        }
        return explicit;
    }
    if (devices.length === 1) { return devices[0]; }
    if (devices.length === 0) { fail('No Android device detected in adb devices output.'); }
    fail(`Multiple Android devices detected; set MANABITAN_ANDROID_ADB_DEVICE. Devices=${JSON.stringify(devices)}`);
    return '';
}

/**
 * @param {string} device
 * @param {string} packageName
 * @returns {Promise<boolean>}
 */
async function isPackageInstalled(device, packageName) {
    const output = await runCommand('adb', ['-s', device, 'shell', 'pm', 'list', 'packages', packageName]);
    return output.includes(packageName);
}

/**
 * @returns {Promise<string>}
 */
async function resolveLatestFirefoxApkUrl() {
    const baseUrl = 'https://ftp.mozilla.org/pub/fenix/releases/';
    const listingResponse = await fetch(baseUrl);
    if (!listingResponse.ok) {
        fail(`Failed to fetch Firefox Android release listing: ${listingResponse.status} ${listingResponse.statusText}`);
    }
    const listingHtml = await listingResponse.text();
    const stableVersions = extractFirefoxAndroidStableReleaseVersions(listingHtml, baseUrl);
    if (stableVersions.length === 0) {
        fail('No stable Firefox Android release versions found in listing.');
    }
    const latestVersion = stableVersions[stableVersions.length - 1];
    const archDirectoryUrl = new URL(`${latestVersion}/android/fenix-${latestVersion}-android-x86_64/`, baseUrl).href;
    const archListingResponse = await fetch(archDirectoryUrl);
    if (!archListingResponse.ok) {
        fail(`Failed to fetch Firefox Android x86_64 listing for ${latestVersion}: ${archListingResponse.status} ${archListingResponse.statusText}`);
    }
    const archListingHtml = await archListingResponse.text();
    const apkCandidates = extractFirefoxAndroidApkUrls(archListingHtml, archDirectoryUrl);
    if (apkCandidates.length === 0) {
        fail(`No APK file found in Firefox Android x86_64 listing for ${latestVersion}.`);
    }
    const preferredApk = selectPreferredFirefoxAndroidApkUrl(apkCandidates, latestVersion);
    if (typeof preferredApk !== 'string') {
        fail(`Could not determine a preferred Firefox Android x86_64 APK for ${latestVersion}.`);
    }
    return preferredApk;
}

/**
 * @param {string} url
 * @param {string} outPath
 * @returns {Promise<void>}
 */
async function downloadFile(url, outPath) {
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
        fail(`Failed to download APK: ${response.status} ${response.statusText} url=${url}`);
    }
    await mkdir(path.dirname(outPath), {recursive: true});
    await pipeline(Readable.fromWeb(response.body), createWriteStream(outPath));
}

/**
 * @returns {Promise<string>}
 */
async function resolveFirefoxAndroidSourceDir() {
    const configuredSourceDir = String(process.env.MANABITAN_ANDROID_SOURCE_DIR || '').trim();
    if (configuredSourceDir.length > 0) {
        await access(configuredSourceDir);
        return configuredSourceDir;
    }
    const buildsDir = path.join(root, 'builds');
    const entries = await readdir(buildsDir, {withFileTypes: true});
    /** @type {Array<{path: string, mtimeMs: number}>} */
    const candidates = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        if (!entry.name.endsWith('-firefox-android')) { continue; }
        const candidatePath = path.join(buildsDir, entry.name);
        const stats = await stat(candidatePath);
        candidates.push({path: candidatePath, mtimeMs: Number(stats.mtimeMs || 0)});
    }
    if (candidates.length === 0) {
        fail(`Could not find firefox-android build output in ${buildsDir}. Run: npm run build -- --target firefox-android`);
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].path;
}

/**
 * @param {{device: string, packageName: string, sourceDir: string, timeoutMs: number}} options
 * @returns {Promise<string[]>}
 */
async function runWebExtSmoke({device, packageName, sourceDir, timeoutMs}) {
    return await runWebExtInstallHandshake({
        device,
        packageName,
        sourceDir,
        timeoutMs,
        cwd: root,
        onOutput: (line) => {
            console.log(`[firefox-android-e2e] web-ext: ${line}`);
        },
    });
}

/**
 * Captures bounded, read-only emulator state at the failed install deadline.
 * @param {string} device
 * @param {string} packageName
 * @returns {Promise<Record<string, {capturedAtIso: string, output: string, error?: string}>>}
 */
async function captureFirefoxDiagnostics(device, packageName) {
    const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
    if (!device.startsWith('emulator-')) { throw new Error(`Refusing Android diagnostics on non-emulator device ${device}.`); }
    if (!packagePattern.test(packageName)) { throw new Error(`Refusing Android diagnostics for invalid package name ${packageName}.`); }
    /** @type {Record<string, {capturedAtIso: string, output: string, error?: string}>} */
    const result = {};
    const capture = async (name, args, filter = (value) => value) => {
        const capturedAtIso = new Date().toISOString();
        try {
            const {stdout} = await execFileAsync('adb', ['-s', device, ...args], {cwd: root, env: process.env, timeout: 8_000, maxBuffer: 4 * 1024 * 1024});
            result[name] = {capturedAtIso, output: filter(String(stdout || '')).slice(0, 40_000)};
        } catch (error) {
            result[name] = {capturedAtIso, output: '', error: errorMessage(error)};
        }
    };
    const onlyLines = (pattern, limit, fromEnd = false) => (value) => {
        const lines = value.split('\n').filter((line) => pattern.test(line));
        return (fromEnd ? lines.slice(-limit) : lines.slice(0, limit)).join('\n');
    };
    await capture('package', ['shell', 'dumpsys', 'package', packageName], onlyLines(/versionName=|versionCode=|firstInstallTime=|lastUpdateTime=/i, 40));
    await capture('activity', ['shell', 'dumpsys', 'activity', 'activities'], onlyLines(/mResumedActivity|topResumedActivity|org\.mozilla\.(?:firefox|fenix)/i, 80, true));
    await capture('process', ['shell', 'ps', '-A'], onlyLines(new RegExp(packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 60));
    await capture('debugger-sockets', ['shell', 'cat', '/proc/net/unix'], onlyLines(/mozilla|debugger/i, 100));
    await capture('remote-debugging-pref-root', ['shell', 'id', '-u']);
    if (result['remote-debugging-pref-root'].output.trim() === '0') {
        await capture('remote-debugging-pref', ['shell', 'cat', `/data/data/${packageName}/shared_prefs/fenix_preferences.xml`], onlyLines(/pref_key_remote_debugging|remote_debugging/i, 80));
    } else {
        const diagnostic = result['remote-debugging-pref-root'];
        result['remote-debugging-pref'] = {capturedAtIso: new Date().toISOString(), output: '', error: `ADB shell uid was not root: ${diagnostic.output.trim() || diagnostic.error || 'unknown'}`};
    }
    await capture('logcat', ['logcat', '-d', '-t', '2000', '-v', 'threadtime'], onlyLines(/org\.mozilla\.(?:firefox|fenix)|GeckoView|FATAL EXCEPTION|AndroidRuntime|crash|fatal/i, 300, true));
    return result;
}

/**
 * @returns {Promise<void>}
 */
async function main() {
    const report = createReport();
    const reportPath = process.env.MANABITAN_FIREFOX_ANDROID_E2E_REPORT ?? path.join(root, 'builds', 'firefox-android-e2e-report.html');
    const reportJsonPath = reportPath.replace(/\.html$/i, '.json');
    report.androidDiagnostics = null;
    /** @type {Error|undefined} */
    let runError;
    const firefoxPackage = String(process.env.MANABITAN_ANDROID_FIREFOX_PACKAGE || 'org.mozilla.firefox').trim();
    report.firefoxPackage = firefoxPackage;
    try {
        const adbDetectStart = safePerformance.now();
        const devices = await listAdbDevices();
        const device = selectAdbDevice(devices);
        report.adbDevice = device;
        const adbDetectEnd = safePerformance.now();
        addPhase(report, 'Detect ADB device', `Detected Android device ${device}; all devices=${JSON.stringify(devices)}`, adbDetectStart, adbDetectEnd);

        const packageCheckStart = safePerformance.now();
        let firefoxInstalled = await isPackageInstalled(device, firefoxPackage);
        const autoInstallFirefox = String(process.env.MANABITAN_ANDROID_AUTO_INSTALL_FIREFOX || '').trim() === '1';
        let firefoxApkUrl = String(process.env.MANABITAN_ANDROID_FIREFOX_APK_URL || '').trim();
        if (!firefoxInstalled && autoInstallFirefox) {
            if (firefoxApkUrl.length === 0) {
                firefoxApkUrl = await resolveLatestFirefoxApkUrl();
            }
            report.firefoxApkUrl = firefoxApkUrl;
            const apkPath = path.join(root, 'builds', 'firefox-android-x86_64.apk');
            await downloadFile(firefoxApkUrl, apkPath);
            await runCommand('adb', ['-s', device, 'install', '-r', '-d', apkPath]);
            firefoxInstalled = await isPackageInstalled(device, firefoxPackage);
        }
        if (!firefoxInstalled) {
            fail(`Firefox Android package "${firefoxPackage}" is not installed on device ${device}. Set MANABITAN_ANDROID_AUTO_INSTALL_FIREFOX=1 to auto-install.`);
        }
        const packageCheckEnd = safePerformance.now();
        addPhase(
            report,
            'Ensure Firefox Android package',
            `Firefox package ${firefoxPackage} is installed on ${device}. autoInstall=${String(autoInstallFirefox)} apkUrl=${firefoxApkUrl || 'not-used'}`,
            packageCheckStart,
            packageCheckEnd,
        );

        if (String(process.env.MANABITAN_ANDROID_ENABLE_FIREFOX_REMOTE_DEBUGGING || '').trim() === '1') {
            const remoteDebuggingStart = safePerformance.now();
            await runCommand('bash', [path.join(dirname, 'enable-firefox-remote-debugging.sh'), device, firefoxPackage]);
            const remoteDebuggingEnd = safePerformance.now();
            addPhase(report, 'Prepare Firefox Android remote debugging', `Updated the Fenix preference while Firefox was disabled and process-free on ${device}.`, remoteDebuggingStart, remoteDebuggingEnd);
        }

        const resolveSourceDirStart = safePerformance.now();
        const sourceDir = await resolveFirefoxAndroidSourceDir();
        report.sourceDir = sourceDir;
        const resolveSourceDirEnd = safePerformance.now();
        addPhase(report, 'Resolve extension source directory', `Using extension source directory: ${sourceDir}`, resolveSourceDirStart, resolveSourceDirEnd);

        const timeoutMs = Number(process.env.MANABITAN_ANDROID_WEB_EXT_TIMEOUT_MS || 45_000);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            fail(`Invalid MANABITAN_ANDROID_WEB_EXT_TIMEOUT_MS: ${String(process.env.MANABITAN_ANDROID_WEB_EXT_TIMEOUT_MS || '')}`);
        }
        const webExtSmokeStart = safePerformance.now();
        const webExtOutputTail = await runWebExtInstallHandshake({
            device,
            packageName: firefoxPackage,
            sourceDir,
            timeoutMs,
            cwd: root,
            onOutput: (line) => console.log(`[firefox-android-e2e] web-ext: ${line}`),
            onBeforeFailureCleanup: async () => { report.androidDiagnostics = await captureFirefoxDiagnostics(device, firefoxPackage); },
        });
        const webExtSmokeEnd = safePerformance.now();
        addPhase(
            report,
            'Run Firefox Android web-ext smoke',
            `web-ext confirmed Firefox remote debugger installation of the temporary add-on. outputTail=${JSON.stringify(webExtOutputTail.slice(-20))}`,
            webExtSmokeStart,
            webExtSmokeEnd,
        );

        if (String(process.env.MANABITAN_ANDROID_ENABLE_FIREFOX_REMOTE_DEBUGGING || '').trim() === '1') {
            const preferenceVerifyStart = safePerformance.now();
            await runCommand('bash', [path.join(dirname, 'enable-firefox-remote-debugging.sh'), device, firefoxPackage, '--verify-after-launch']);
            const preferenceVerifyEnd = safePerformance.now();
            addPhase(report, 'Verify Firefox Android remote debugging after ACK', `Fenix retained pref_key_remote_debugging=true after launching and acknowledging the temporary add-on on ${device}.`, preferenceVerifyStart, preferenceVerifyEnd);
        }

        report.status = 'success';
        console.log('[firefox-android-e2e] PASS: Firefox Android extension smoke run succeeded.');
    } catch (e) {
        report.status = 'failure';
        report.failureReason = errorMessage(e);
        runError = new Error(`[firefox-android-e2e] ${report.failureReason}`);
    } finally {
        report.finishedAtIso = new Date().toISOString();
        await mkdir(path.dirname(reportPath), {recursive: true});
        await writeFile(reportPath, renderReportHtml(report), 'utf8');
        await writeFile(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
        console.log(`[firefox-android-e2e] Wrote report: ${reportPath}`);
        console.log(`[firefox-android-e2e] Wrote report json: ${reportJsonPath}`);
    }
    if (runError) {
        throw runError;
    }
}

await main();
