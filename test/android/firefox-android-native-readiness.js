import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, realpath, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const maximumReadinessMs = 60_000;
const adbCallTimeoutMs = 4_000;
const ownedSheetButtonId = 'org.mozilla.firefox:id/confirm_button';
const ownedSheetTitleId = 'org.mozilla.firefox:id/title';
const onboardingActions = [
    {titles: ['Welcome to Firefox', 'Get ready to run free', 'Launch the ultimate Android browser'], buttonTexts: ['Continue'], action: 'continue-terms-of-use'},
    {titles: ['Say goodbye to creepy trackers', 'Open all your links with built-in privacy', 'Get automatic tracking protection by default'], buttonTexts: ['Not now', 'Skip'], action: 'decline-default-browser'},
    {titles: ['Instantly pick up where you left off', 'Sync everywhere you use Firefox'], buttonTexts: ['Not now', 'Skip'], action: 'decline-sync'},
    {titles: ['Help us build a better internet', 'Help us grow Firefox', 'One last thing'], buttonTexts: ['No Thanks', 'No thanks', 'No', 'Skip'], action: 'decline-marketing'},
    {titles: ['Notifications help you stay safer with Firefox', 'Make every search more private'], buttonTexts: ['Not now', 'Skip'], action: 'decline-notifications'},
    {titles: ['Choose your address bar', 'Where do you want your address bar?'], buttonTexts: ['Continue'], action: 'continue-with-selected-toolbar-default'},
];

/** @typedef {{packageName: string, text: string, resourceId: string, className: string, clickable: boolean, enabled: boolean, bounds: {left: number, top: number, right: number, bottom: number}|null, parentIndex: number|null}} NativeNode */
/** @typedef {{timeout: number, killSignal: 'SIGKILL', maxBuffer: number, encoding: 'utf8'|null, windowsHide: boolean}} NativeExecOptions */
/** @typedef {{label: string, capturedAtIso: string, files: Record<string, {status: string, path?: string, bytes?: number, binary?: boolean, error?: string}>, foregroundActivity: string|null}} NativeCapture */
/** @typedef {{startedAtIso: string, finishedAtIso: string|null, device: string, packageName: string, extensionName: string, actions: Array<Record<string, unknown>>, captures: NativeCapture[], ready: boolean, observations?: number, failureCapture?: NativeCapture, failureCaptureError?: string, reportPath?: string, reportWriteError?: string}} NativeReadinessEvidence */

/**
 * @param {string} value
 * @returns {string}
 */
function xmlAttribute(value) {
    return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

/**
 * @param {string} xml
 * @returns {NativeNode[]}
 */
export function parseAndroidNativeHierarchy(xml) {
    const nodes = [];
    /** @type {number[]} */
    const parents = [];
    for (const match of xml.matchAll(/<\/?node\b[^>]*\/?>/g)) {
        const token = match[0];
        if (token.startsWith('</')) {
            parents.pop();
            continue;
        }
        const attributes = Object.fromEntries([...token.matchAll(/([\w:-]+)="([^"]*)"/g)].map((item) => [item[1], xmlAttribute(item[2])]));
        const boundsMatch = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attributes.bounds || '');
        const index = nodes.length;
        nodes.push({
            packageName: attributes.package || '',
            text: attributes.text || '',
            resourceId: attributes['resource-id'] || '',
            className: attributes.class || '',
            clickable: attributes.clickable === 'true',
            enabled: attributes.enabled === 'true',
            bounds: boundsMatch ? {left: Number(boundsMatch[1]), top: Number(boundsMatch[2]), right: Number(boundsMatch[3]), bottom: Number(boundsMatch[4])} : null,
            parentIndex: parents.at(-1) ?? null,
        });
        if (!token.endsWith('/>')) { parents.push(index); }
    }
    return nodes;
}

/**
 * @param {NativeNode} node
 * @returns {boolean}
 */
function hasPositiveNativeBounds(node) {
    const {bounds} = node;
    return Boolean(bounds && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isSafeInteger) && bounds.left >= 0 && bounds.top >= 0 && bounds.right > bounds.left && bounds.bottom > bounds.top);
}

/**
 * @param {NativeNode[]} nodes
 * @param {number} nodeIndex
 * @param {number} ancestorIndex
 * @returns {boolean}
 */
function hasNativeAncestor(nodes, nodeIndex, ancestorIndex) {
    let parentIndex = nodes[nodeIndex]?.parentIndex ?? null;
    while (parentIndex !== null) {
        if (parentIndex === ancestorIndex) { return true; }
        parentIndex = nodes[parentIndex]?.parentIndex ?? null;
    }
    return false;
}

/**
 * Recognizes Firefox's native toolbar using resource IDs and hierarchy structure only.
 * @param {NativeNode[]} nodes
 * @param {string} packageName
 * @returns {boolean}
 */
export function hasRecognizedNativeBrowserUi(nodes, packageName) {
    const ownedNodes = nodes.map((node, index) => ({node, index})).filter(({node}) => node.packageName === packageName && hasPositiveNativeBounds(node));
    const legacyToolbar = ownedNodes.some(({node}) => /(?:^|:id\/)(?:url_bar|mozac_browser_toolbar_url_view|browser_toolbar|home_toolbar)$/.test(node.resourceId));
    if (legacyToolbar) { return true; }

    const browserLayout = ownedNodes.filter(({node}) => node.resourceId === `${packageName}:id/browserLayout`);
    const toolbar = ownedNodes.filter(({node}) => node.resourceId === `${packageName}:id/composable_toolbar`);
    const addressBar = ownedNodes.filter(({node}) => node.resourceId === 'ADDRESSBAR_URL_BOX');
    const engineView = ownedNodes.filter(({node}) => node.resourceId === `${packageName}:id/engineView`);
    return browserLayout.some((layout) => toolbar.some((bar) => {
        const toolbarInLayout = hasNativeAncestor(nodes, bar.index, layout.index);
        const addressBarInToolbar = addressBar.some((address) => hasNativeAncestor(nodes, address.index, bar.index));
        const engineInLayout = engineView.some((engine) => hasNativeAncestor(nodes, engine.index, layout.index));
        return toolbarInLayout && addressBarInToolbar && engineInLayout;
    }));
}

/**
 * @param {NativeNode[]} nodes
 * @param {string} packageName
 * @param {string} extensionName
 * @returns {{title: string, resourceId: string, text: string, bounds: {left: number, top: number, right: number, bottom: number}, tapCenter: {x: number, y: number}}|null}
 */
export function findOwnedAddedSheetButton(nodes, packageName, extensionName) {
    const titles = nodes.filter((node) => node.packageName === packageName && node.resourceId === ownedSheetTitleId && node.text === `${extensionName} was added`);
    if (titles.length === 0) { return null; }
    assert.equal(titles.length, 1, 'Multiple owned extension-added titles were found in the native UI hierarchy');
    const buttons = nodes.filter((node) => node.packageName === packageName && node.resourceId === ownedSheetButtonId && node.className === 'android.widget.Button' && node.text === 'OK' && node.enabled && node.clickable);
    assert.equal(buttons.length, 1, 'Owned extension-added title did not have exactly one enabled clickable confirmation button');
    const bounds = buttons[0].bounds;
    assert.ok(bounds && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isSafeInteger) && bounds.left >= 0 && bounds.top >= 0 && bounds.right > bounds.left && bounds.bottom > bounds.top, 'Owned extension-added confirmation button has invalid native bounds');
    return {title: titles[0].text, resourceId: buttons[0].resourceId, text: buttons[0].text, bounds, tapCenter: {x: Math.floor((bounds.left + bounds.right) / 2), y: Math.floor((bounds.top + bounds.bottom) / 2)}};
}

/**
 * @param {NativeNode[]} nodes
 * @param {string} packageName
 * @returns {{title: string, buttonText: string, resourceId: string, bounds: {left: number, top: number, right: number, bottom: number}, tapCenter: {x: number, y: number}, action: string}|null}
 */
function findKnownOnboardingAction(nodes, packageName) {
    const visibleTitles = nodes.filter((node) => node.packageName === packageName && onboardingActions.some(({titles}) => titles.includes(node.text)));
    if (visibleTitles.length === 0) { return null; }
    assert.equal(visibleTitles.length, 1, 'Native onboarding hierarchy has multiple recognized page titles');
    const page = onboardingActions.find(({titles}) => titles.includes(visibleTitles[0].text));
    assert.ok(page);
    const labels = nodes.map((node, index) => ({node, index})).filter(({node}) => node.packageName === packageName && page.buttonTexts.includes(node.text));
    const buttons = new Map();
    for (const {node, index} of labels) {
        if (node.enabled && node.clickable) {
            buttons.set(index, {node, label: node.text});
            continue;
        }
        let parentIndex = node.parentIndex;
        while (parentIndex !== null) {
            const parent = nodes[parentIndex];
            if (!parent || parent.packageName !== packageName) { break; }
            if (parent.enabled && parent.clickable && /(?:^|\.)Button$/.test(parent.className)) {
                const prior = buttons.get(parentIndex);
                assert.ok(!prior || prior.label === node.text, `One Firefox onboarding button contains conflicting safe labels on page "${visibleTitles[0].text}"`);
                buttons.set(parentIndex, {node: parent, label: node.text});
                break;
            }
            parentIndex = parent.parentIndex;
        }
    }
    assert.equal(buttons.size, 1, `Recognized onboarding page "${visibleTitles[0].text}" did not have exactly one enabled clickable safe control`);
    const selected = [...buttons.values()][0];
    const button = selected.node;
    const bounds = button.bounds;
    assert.ok(bounds && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isSafeInteger) && bounds.left >= 0 && bounds.top >= 0 && bounds.right > bounds.left && bounds.bottom > bounds.top, 'Firefox onboarding control has invalid native bounds');
    return {title: visibleTitles[0].text, buttonText: selected.label, resourceId: button.resourceId, bounds, tapCenter: {x: Math.floor((bounds.left + bounds.right) / 2), y: Math.floor((bounds.top + bounds.bottom) / 2)}, action: page.action};
}

/**
 * @param {(args: string[], options: NativeExecOptions) => Promise<{stdout: Buffer|string}>} runCommand
 * @param {string} device
 * @param {number} deadline
 * @param {string} label
 * @param {string[]} args
 * @param {() => number} now
 * @param {'utf8'|null} encoding
 * @returns {Promise<{stdout: Buffer|string}>}
 */
async function adb(runCommand, device, deadline, label, args, now, encoding = 'utf8') {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) { throw new Error('Native readiness exceeded its 60 second deadline'); }
    return await runCommand(['-s', device, ...args], {timeout: Math.min(adbCallTimeoutMs, remainingMs), killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, encoding: label === 'screenshot' ? null : encoding, windowsHide: true}).catch((error) => {
        throw new Error(`Native readiness adb ${label} failed: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
    });
}

/**
 * @param {{adbDevice: string, packageName: string, extensionName: string, outputDirectory: string, runCommand?: (args: string[], options: NativeExecOptions) => Promise<{stdout: Buffer|string}>, now?: () => number, sleep?: (milliseconds: number) => Promise<void>}} options
 * @returns {Promise<NativeReadinessEvidence>}
 */
export async function prepareAndroidNativeReadiness({adbDevice, packageName, extensionName, outputDirectory, runCommand = (args, options) => execFileAsync('adb', args, options), now = Date.now, sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); })}) {
    assert.match(adbDevice, /^emulator-[\w.-]+$/, 'Native readiness requires the selected CI emulator serial');
    assert.equal(packageName, 'org.mozilla.firefox', 'Native readiness only supports the verified Firefox Android package');
    assert.ok(extensionName && !/[\r\n]/.test(extensionName), 'Native readiness requires the built extension name');
    const startedAtIso = new Date().toISOString();
    const deadline = now() + maximumReadinessMs;
    const workDeadline = deadline - 16_000;
    const parent = path.dirname(outputDirectory);
    await mkdir(parent, {recursive: true});
    const resolvedParent = await realpath(parent);
    const resolvedDirectory = path.resolve(resolvedParent, path.basename(outputDirectory));
    await mkdir(resolvedDirectory, {recursive: true});
    assert.equal(await realpath(resolvedDirectory), resolvedDirectory, 'Native readiness evidence path resolved outside its owned target');
    const runPath = path.join(resolvedDirectory, `${startedAtIso.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID()}`);
    await mkdir(runPath);
    /** @type {NativeReadinessEvidence} */
    const evidence = {startedAtIso, finishedAtIso: null, device: adbDevice, packageName, extensionName, actions: [], captures: [], ready: false};
    const remoteHierarchyPath = `/sdcard/manabitan-native-readiness-${randomUUID()}.xml`;
    let originalError = null;

    /**
     * @param {string} label
     * @param {number} [captureDeadline]
     * @returns {Promise<{hierarchy: string|null, captureEvidence: NativeCapture}>}
     */
    const capture = async (label, captureDeadline = workDeadline) => {
        const capturedAtIso = new Date().toISOString();
        /** @type {NativeCapture['files']} */
        const files = {};
        /**
         * @param {string} name
         * @param {string[]} args
         * @param {boolean} [binary]
         * @returns {Promise<string|null>}
         */
        const captureOne = async (name, args, binary = false) => {
            try {
                const {stdout} = await adb(runCommand, adbDevice, captureDeadline, name, args, now, name === 'screenshot' ? null : 'utf8');
                const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
                const target = path.join(runPath, `${label}-${name}${name === 'screenshot' ? '.png' : (name === 'hierarchy' ? '.xml' : '.txt')}`);
                await writeFile(target, bytes, {flag: 'wx'});
                files[name] = {status: 'success', path: path.relative(resolvedDirectory, target), bytes: bytes.byteLength, binary: binary || Buffer.isBuffer(stdout)};
                return bytes.toString('utf8');
            } catch (error) {
                files[name] = {status: 'error', error: error instanceof Error ? error.message : String(error)};
                return null;
            }
        };
        await captureOne('screenshot', ['exec-out', 'screencap', '-p'], true);
        const activity = await captureOne('activity', ['shell', 'dumpsys', 'activity', 'activities']);
        await captureOne('windows', ['shell', 'dumpsys', 'window', 'windows']);
        let hierarchy = null;
        try {
            await adb(runCommand, adbDevice, captureDeadline, 'hierarchy-dump', ['shell', 'uiautomator', 'dump', remoteHierarchyPath], now);
            hierarchy = await captureOne('hierarchy', ['exec-out', 'cat', remoteHierarchyPath]);
        } catch (error) {
            files.hierarchy = {status: 'error', error: error instanceof Error ? error.message : String(error)};
        }
        const captureEvidence = /** @type {NativeCapture} */ ({label, capturedAtIso, files, foregroundActivity: activity ? /mResumedActivity[^\n]*/.exec(activity)?.[0] || /topResumedActivity[^\n]*/.exec(activity)?.[0] || null : null});
        evidence.captures.push(captureEvidence);
        return {hierarchy, captureEvidence};
    };

    /**
     * @param {string} name
     * @param {Record<string, unknown>} detail
     * @param {string[]} command
     * @returns {Promise<void>}
     */
    const action = async (name, detail, command) => {
        const atIso = new Date().toISOString();
        await adb(runCommand, adbDevice, deadline, name, command, now);
        evidence.actions.push({name, atIso, ...detail});
    };

    try {
        let snapshot = await capture('before');
        if (!snapshot.hierarchy) { throw new Error('Could not inspect the native UI hierarchy before readiness actions'); }
        let nodes = parseAndroidNativeHierarchy(snapshot.hierarchy);
        if (nodes.every((node) => !node.packageName)) { throw new Error('Native UI hierarchy contained no identifiable foreground package'); }
        if (nodes.some((node) => node.packageName && node.packageName !== packageName)) { throw new Error(`Native UI hierarchy contains an unexpected package: ${[...new Set(nodes.map((node) => node.packageName).filter(Boolean))].join(', ')}`); }
        const ownedSheet = findOwnedAddedSheetButton(nodes, packageName, extensionName);
        if (ownedSheet) {
            await action('dismiss-owned-extension-added-sheet', {title: ownedSheet.title, buttonResourceId: ownedSheet.resourceId, buttonText: ownedSheet.text, bounds: ownedSheet.bounds, tapCenter: ownedSheet.tapCenter}, ['shell', 'input', 'tap', String(ownedSheet.tapCenter.x), String(ownedSheet.tapCenter.y)]);
            snapshot = await capture('after-owned-sheet-dismissal');
            if (!snapshot.hierarchy) { throw new Error('Native UI hierarchy could not be checked after dismissing the owned extension-added sheet'); }
            nodes = parseAndroidNativeHierarchy(snapshot.hierarchy);
            if (nodes.every((node) => !node.packageName) || nodes.some((node) => node.packageName && node.packageName !== packageName)) {
                throw new Error('Native UI hierarchy changed to an unrecognized package after dismissing the owned extension-added sheet');
            }
            if (findOwnedAddedSheetButton(nodes, packageName, extensionName)) { throw new Error('The owned extension-added sheet remained visible after its validated button tap'); }
        }

        const meaningfulBrowserUiBeforeIntent = hasRecognizedNativeBrowserUi(nodes, packageName);
        const recognizedOnboardingBeforeIntent = nodes.some((node) => node.packageName === packageName && onboardingActions.some(({titles}) => titles.includes(node.text)));
        if (!meaningfulBrowserUiBeforeIntent && !recognizedOnboardingBeforeIntent) {
            throw new Error('Unrecognized Firefox native UI state after install acknowledgement; refusing to launch browser intent');
        }

        // ACTION_VIEW for HTTPS is the ordinary exported Fenix browser entry point. The URL is inert example content.
        await action('open-normal-browser-with-action-view', {intentAction: 'android.intent.action.VIEW', uri: 'https://example.com/', packageName, evidence: 'Fenix Android 158 IntentReceiverActivity manifest declares VIEW + BROWSABLE + DEFAULT HTTP(S) handlers'}, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'https://example.com/', '-p', packageName]);

        let stableBrowserObservations = 0;
        let observations = 0;
        while (now() < workDeadline) {
            const current = await capture(`readiness-observation-${observations + 1}`);
            observations += 1;
            if (!current.hierarchy) { throw new Error('Native UI hierarchy unavailable while waiting for Firefox browser readiness'); }
            nodes = parseAndroidNativeHierarchy(current.hierarchy);
            const packages = [...new Set(nodes.map((node) => node.packageName).filter(Boolean))];
            if (packages.length === 0 || packages.some((value) => value !== packageName)) { throw new Error(`Native readiness encountered an unexpected or unidentified foreground package: ${packages.join(', ')}`); }
            const sheet = findOwnedAddedSheetButton(nodes, packageName, extensionName);
            if (sheet) {
                await action('dismiss-delayed-owned-extension-added-sheet', {title: sheet.title, buttonResourceId: sheet.resourceId, buttonText: sheet.text, bounds: sheet.bounds, tapCenter: sheet.tapCenter}, ['shell', 'input', 'tap', String(sheet.tapCenter.x), String(sheet.tapCenter.y)]);
                stableBrowserObservations = 0;
                continue;
            }
            const meaningfulBrowserUi = hasRecognizedNativeBrowserUi(nodes, packageName);
            const onboarding = findKnownOnboardingAction(nodes, packageName);
            if (onboarding) {
                await action(onboarding.action, {title: onboarding.title, buttonText: onboarding.buttonText, buttonResourceId: onboarding.resourceId, bounds: onboarding.bounds, tapCenter: onboarding.tapCenter}, ['shell', 'input', 'tap', String(onboarding.tapCenter.x), String(onboarding.tapCenter.y)]);
                stableBrowserObservations = 0;
                continue;
            }
            if (meaningfulBrowserUi) {
                stableBrowserObservations += 1;
                if (stableBrowserObservations >= 2) {
                    evidence.ready = true;
                    evidence.observations = observations;
                    break;
                }
            } else {
                stableBrowserObservations = 0;
                const unknownControls = nodes.filter((node) => node.packageName === packageName && node.clickable && node.enabled).map(({text, resourceId, className, bounds}) => ({text, resourceId, className, bounds}));
                if (observations >= 3) { throw new Error(`Unrecognized Firefox first-run or browser UI state: ${JSON.stringify({packages, controls: unknownControls})}`); }
            }
            await sleep(Math.min(500, Math.max(0, workDeadline - now())));
        }
        if (!evidence.ready) { throw new Error('Native Firefox browser readiness exceeded its 60 second deadline'); }
    } catch (error) {
        originalError = error instanceof Error ? error : new Error(String(error));
        try {
            const final = await capture('failure', deadline);
            evidence.failureCapture = final.captureEvidence;
        } catch (captureError) {
            evidence.failureCaptureError = captureError instanceof Error ? captureError.message : String(captureError);
        }
    }
    evidence.finishedAtIso = new Date().toISOString();
    const reportPath = path.join(runPath, 'native-readiness.json');
    if (originalError) {
        try {
            await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, {flag: 'wx'});
            evidence.reportPath = path.relative(resolvedDirectory, reportPath);
        } catch (reportError) {
            evidence.reportWriteError = reportError instanceof Error ? reportError.message : String(reportError);
        }
        throw Object.assign(originalError, {nativeReadiness: evidence});
    }
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, {flag: 'wx'});
    evidence.reportPath = path.relative(resolvedDirectory, reportPath);
    return evidence;
}
