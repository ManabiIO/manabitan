import {spawn} from 'node:child_process';

const installMarkerPattern = /^Installed .+ as a temporary add-on$/;
const errorOutputPattern = /(?:^|\s)(?:error|failed|failure|timed out|timeout)(?:\s|:|$)/i;

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function delay(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalProcessTree(child, signal) {
    if (typeof child.pid !== 'number') { return; }
    try {
        // `detached` gives the runner and any descendants a private process group.
        process.kill(-child.pid, signal);
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') {
            try { child.kill(signal); } catch { /* The child may already have exited. */ }
        }
    }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {Promise<void>} closePromise
 * @returns {Promise<void>}
 */
async function stopProcessTree(child, closePromise) {
    signalProcessTree(child, 'SIGTERM');
    const closedAfterTerm = await Promise.race([
        closePromise.then(() => true),
        delay(2_000).then(() => false),
    ]);
    if (closedAfterTerm) {
        // The group leader can exit while a descendant ignores SIGTERM and
        // keeps running. Reap any such runner descendants before returning.
        signalProcessTree(child, 'SIGKILL');
        return;
    }

    signalProcessTree(child, 'SIGKILL');
    const closedAfterKill = await Promise.race([
        closePromise.then(() => true),
        delay(3_000).then(() => false),
    ]);
    if (!closedAfterKill) {
        throw new Error('web-ext process tree did not shut down after SIGTERM and SIGKILL.');
    }
}

/**
 * Runs web-ext until its remote debugger confirms extension installation.
 * @param {{device: string, packageName: string, sourceDir: string, timeoutMs: number, onOutput?: (line: string) => void, onBeforeFailureCleanup?: () => Promise<void>, diagnosticTimeoutMs?: number, command?: string, commandArgs?: string[], cwd?: string}} options
 * @returns {Promise<string[]>}
 */
export async function runWebExtInstallHandshake({device, packageName, sourceDir, timeoutMs, onOutput = () => {}, onBeforeFailureCleanup = async () => {}, diagnosticTimeoutMs = 60_000, command = 'npx', commandArgs, cwd = process.cwd()}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`Invalid web-ext install handshake timeout: ${String(timeoutMs)}`);
    }
    if (!Number.isFinite(diagnosticTimeoutMs) || diagnosticTimeoutMs <= 0) {
        throw new Error(`Invalid web-ext diagnostic timeout: ${String(diagnosticTimeoutMs)}`);
    }
    if (process.platform === 'win32') {
        throw new Error('Firefox Android web-ext process-tree cleanup requires POSIX process-group signaling.');
    }
    const args = commandArgs ?? [
        '--yes',
        'web-ext@10.8.0',
        'run',
        '--target',
        'firefox-android',
        '--adb-device',
        device,
        '--firefox-apk',
        packageName,
        '-s',
        sourceDir,
    ];
    const child = spawn(command, args, {
        cwd,
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {string[]} */
    const outputLines = [];
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let installAcknowledged = false;
    let processError;
    /** @type {{value: {code: number|null, signal: NodeJS.Signals|null}|undefined}} */
    const exitState = /** @type {{value: {code: number|null, signal: NodeJS.Signals|null}|undefined}} */ ({value: undefined});

    /** @param {string} chunk */
    const appendLines = (chunk) => {
        for (const rawLine of chunk.split('\n').slice(0, -1)) {
            const line = rawLine.trimEnd();
            if (line.length === 0) { continue; }
            outputLines.push(line);
            if (outputLines.length > 200) { outputLines.shift(); }
            onOutput(line);
            if (errorOutputPattern.test(line)) {
                processError ??= new Error(`web-ext reported an error before install confirmation: ${line}`);
            }
            if (installMarkerPattern.test(line)) { installAcknowledged = true; }
        }
    };

    const closePromise = new Promise(/** @type { (resolve: (value: void) => void) => void } */ ((resolve) => {
        child.once('close', (code, signal) => {
            if (stdoutBuffer.trim().length > 0) { appendLines(`${stdoutBuffer.trim()}\n`); }
            if (stderrBuffer.trim().length > 0) { appendLines(`${stderrBuffer.trim()}\n`); }
            stdoutBuffer = '';
            stderrBuffer = '';
            exitState.value = {code, signal};
            resolve();
        });
    }));
    child.once('exit', (code, signal) => {
        exitState.value ??= {code, signal};
    });

    child.stdout.on('data', (chunk) => {
        stdoutBuffer += String(chunk);
        const newlineIndex = stdoutBuffer.lastIndexOf('\n');
        if (newlineIndex !== -1) {
            appendLines(stdoutBuffer.slice(0, newlineIndex + 1));
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        }
        if (installMarkerPattern.test(stdoutBuffer.trimEnd())) { installAcknowledged = true; }
    });
    child.stderr.on('data', (chunk) => {
        stderrBuffer += String(chunk);
        const newlineIndex = stderrBuffer.lastIndexOf('\n');
        if (newlineIndex !== -1) {
            appendLines(stderrBuffer.slice(0, newlineIndex + 1));
            stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        }
        if (installMarkerPattern.test(stderrBuffer.trimEnd())) { installAcknowledged = true; }
    });
    child.once('error', (error) => { processError ??= error; });

    const deadline = Date.now() + timeoutMs;
    let runnerExitedBeforeCleanup = false;
    /** @type {unknown} */
    let handshakeFailure;
    /** @type {unknown} */
    let cleanupFailure;
    try {
        while (!installAcknowledged && !processError && !exitState.value) {
            if (Date.now() >= deadline) {
                throw new Error(`Timed out after ${timeoutMs} ms waiting for Firefox Android remote debugger install acknowledgement. Output tail=${JSON.stringify(outputLines.slice(-20))}`);
            }
            await Promise.race([closePromise, delay(Math.min(50, deadline - Date.now()))]);
        }
        if (processError) { throw processError; }
        if (!installAcknowledged) {
            throw new Error(`web-ext exited before Firefox Android confirmed extension installation (code=${String(exitState.value?.code)} signal=${String(exitState.value?.signal)}). Output tail=${JSON.stringify(outputLines.slice(-20))}`);
        }
        await Promise.race([closePromise, delay(10)]);
        if (exitState.value) {
            throw new Error(`web-ext exited after reporting installation (code=${String(exitState.value.code)} signal=${String(exitState.value.signal)}).`);
        }
        // Stop the runner before declaring success. Errors reported during teardown
        // also invalidate the handshake, including errors arriving after the marker.
    } catch (error) {
        handshakeFailure = error;
    } finally {
        if (handshakeFailure !== undefined) {
            let diagnosticTimer;
            try {
                await Promise.race([
                    Promise.resolve().then(onBeforeFailureCleanup).catch(() => {}),
                    new Promise((resolve) => { diagnosticTimer = setTimeout(resolve, diagnosticTimeoutMs); }),
                ]);
            } catch {
                // Diagnostics must never replace the fail-closed handshake failure.
            } finally {
                if (diagnosticTimer !== undefined) { clearTimeout(diagnosticTimer); }
            }
        }
        // Fenix stays open after install. Stop web-ext and all descendants, then wait
        // for stdio to close so a PASS cannot leave a runner holding the job open.
        runnerExitedBeforeCleanup = Boolean(exitState.value);
        try {
            await stopProcessTree(child, closePromise);
        } catch (cleanupError) {
            cleanupFailure = cleanupError;
        }
    }
    if (handshakeFailure !== undefined) { throw handshakeFailure; }
    if (cleanupFailure !== undefined) { throw cleanupFailure; }
    if (processError) { throw processError; }
    if (runnerExitedBeforeCleanup) {
        throw new Error(`web-ext exited after reporting installation (code=${String(exitState.value?.code)} signal=${String(exitState.value?.signal)}).`);
    }
    if (!installAcknowledged) {
        throw new Error(`web-ext exited before Firefox Android confirmed extension installation (code=${String(exitState.value?.code)} signal=${String(exitState.value?.signal)}). Output tail=${JSON.stringify(outputLines.slice(-20))}`);
    }
    return outputLines;
}
