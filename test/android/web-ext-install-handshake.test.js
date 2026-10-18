import {describe, expect, test} from 'vitest';
import {execFileSync} from 'node:child_process';
import {runWebExtInstallHandshake} from './web-ext-install-handshake.js';

const baseOptions = {
    device: 'emulator-5554',
    packageName: 'org.mozilla.firefox',
    sourceDir: '/tmp/firefox-extension',
    timeoutMs: 2_000,
};

/**
 * @param {string} script
 * @param {{timeoutMs?: number, diagnosticTimeoutMs?: number, command?: string, commandArgs?: string[], onOutput?: (line: string) => void, onBeforeFailureCleanup?: () => Promise<void>, cwd?: string}} [overrides]
 * @returns {Promise<string[]>}
 */
function runScript(script, overrides = {}) {
    return runWebExtInstallHandshake({
        ...baseOptions,
        command: process.execPath,
        commandArgs: ['-e', script],
        ...overrides,
    });
}

describe.skipIf(process.platform === 'win32')('Firefox Android web-ext install handshake', () => {
    test('accepts an acknowledged temporary add-on installation and shuts down web-ext', async () => {
        const output = await runScript("console.log('Installed /data/local/tmp/extension.xpi as a temporary add-on'); setInterval(() => {}, 1000);");
        expect(output).toContain('Installed /data/local/tmp/extension.xpi as a temporary add-on');
    });

    test('accepts an unterminated install acknowledgement from a live runner', async () => {
        const output = await runScript("process.stdout.write('Installed /data/local/tmp/extension.xpi as a temporary add-on'); setInterval(() => {}, 1000);");
        expect(output).toContain('Installed /data/local/tmp/extension.xpi as a temporary add-on');
    });

    test('rejects runner error output even when it later prints an install marker', async () => {
        await expect(runScript("console.error('Error: remote install failed'); console.log('Installed /data/local/tmp/extension.xpi as a temporary add-on'); setInterval(() => {}, 1000);"))
            .rejects.toThrow('web-ext reported an error');
    });

    test('rejects runner error output emitted during shutdown', async () => {
        await expect(runScript("console.log('Installed /data/local/tmp/extension.xpi as a temporary add-on'); process.on('SIGTERM', () => { console.error('Error: debugger disconnected during shutdown'); process.exit(0); }); setInterval(() => {}, 1000);"))
            .rejects.toThrow('web-ext reported an error');
    });

    test('rejects a successful process exit without an install acknowledgement', async () => {
        await expect(runScript("console.log('Waiting for RemoteDebuggingServer');"))
            .rejects.toThrow('exited before Firefox Android confirmed extension installation');
    });

    test('rejects a runner that exits after printing its install acknowledgement', async () => {
        await expect(runScript("console.log('Installed /data/local/tmp/extension.xpi as a temporary add-on'); process.exit(23);"))
            .rejects.toThrow('web-ext exited after reporting installation (code=23');
    });

    test.skipIf(process.platform === 'win32')('times out a hanging handshake and cleans up the whole process group', async () => {
        const grandchildScript = "process.on('SIGTERM',()=>{}); console.log('grandchild-ready'); setInterval(()=>{},1000);";
        const childScript = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:['ignore','pipe','ignore']}); let readiness=''; child.stdout.on('data',(chunk)=>{readiness+=chunk.toString(); if(readiness.includes('grandchild-ready\\n')) { console.log('child-pid='+child.pid); console.log('Waiting for RemoteDebuggingServer'); }}); setInterval(()=>{},1000);`;
        /** @type {string[]} */
        const output = [];
        const realNow = Date.now;
        let fixtureNow = realNow();
        Date.now = () => fixtureNow;
        const readinessWatchdog = setTimeout(() => { fixtureNow = realNow() + 101; }, 2_000);
        try {
            await expect(runScript(childScript, {
                timeoutMs: 100,
                command: process.execPath,
                commandArgs: ['-e', childScript],
                onOutput: (line) => {
                    output.push(line);
                    // The parent prints this only after the grandchild has installed its SIGTERM handler.
                    if (line.startsWith('child-pid=')) { fixtureNow = realNow() + 101; }
                },
            })).rejects.toThrow('Timed out after 100 ms waiting for Firefox Android remote debugger install acknowledgement');
        } finally {
            clearTimeout(readinessWatchdog);
            Date.now = realNow;
        }
        const pidLine = output.find((line) => line.startsWith('child-pid='));
        expect(pidLine).toBeDefined();
        const childPid = Number(pidLine?.slice('child-pid='.length));
        await expectProcessToExit(childPid);
    });

    test('captures diagnostics before cleanup on timeout and preserves the timeout when diagnostics reject', async () => {
        let diagnosticCalled = false;
        await expect(runScript("console.log('Waiting for RemoteDebuggingServer'); setInterval(() => {}, 1000);", {
            timeoutMs: 100,
            onBeforeFailureCleanup: async () => {
                diagnosticCalled = true;
                throw new Error('diagnostic unavailable');
            },
        })).rejects.toThrow('Timed out after 100 ms waiting for Firefox Android remote debugger install acknowledgement');
        expect(diagnosticCalled).toBe(true);
    });

    test('bounds a hung diagnostic and still cleans up the runner', async () => {
        const startedAt = Date.now();
        await expect(runScript("console.log('Waiting for RemoteDebuggingServer'); setInterval(() => {}, 1000);", {
            timeoutMs: 100,
            diagnosticTimeoutMs: 50,
            onBeforeFailureCleanup: async () => await new Promise(() => {}),
        })).rejects.toThrow('Timed out after 100 ms waiting for Firefox Android remote debugger install acknowledgement');
        expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    test('captures error-line failures while the runner is still alive', async () => {
        let runnerPid = 0;
        let runnerWasAlive = false;
        const script = "console.log('runner-pid='+process.pid); console.error('Error: socket unavailable'); setInterval(() => {}, 1000);";
        await expect(runScript(script, {
            onOutput: (line) => {
                if (line.startsWith('runner-pid=')) { runnerPid = Number(line.slice('runner-pid='.length)); }
            },
            onBeforeFailureCleanup: async () => {
                process.kill(runnerPid, 0);
                runnerWasAlive = true;
            },
        })).rejects.toThrow('web-ext reported an error');
        expect(runnerWasAlive).toBe(true);
    });

    test('captures early-exit failures while a Firefox child process is still alive', async () => {
        let childPid = 0;
        let childWasAlive = false;
        const script = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"],{stdio:'ignore'}); console.log('child-pid='+child.pid); process.exit(0);";
        await expect(runScript(script, {
            onOutput: (line) => {
                if (line.startsWith('child-pid=')) { childPid = Number(line.slice('child-pid='.length)); }
            },
            onBeforeFailureCleanup: async () => {
                process.kill(childPid, 0);
                childWasAlive = true;
            },
        })).rejects.toThrow('exited before Firefox Android confirmed extension installation');
        expect(childWasAlive).toBe(true);
        await expectProcessToExit(childPid);
    });

    test('does not run diagnostics after install acknowledgement', async () => {
        let diagnosticCalled = false;
        await runScript("console.log('Installed /data/local/tmp/extension.xpi as a temporary add-on'); setInterval(() => {}, 1000);", {
            onBeforeFailureCleanup: async () => { diagnosticCalled = true; },
        });
        expect(diagnosticCalled).toBe(false);
    });
});

/** @param {number} pid */
async function expectProcessToExit(pid) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
            const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding: 'utf8'}).trim();
            if (state.length === 0 || state.startsWith('Z')) { return; }
        } catch {
            return;
        }
        await new Promise((resolve) => {
            setTimeout(resolve, 25);
        });
    }
    throw new Error(`Process ${String(pid)} remained alive after handshake timeout cleanup.`);
}

// The Android smoke runner uses POSIX process groups and must reject before spawning on Windows.
test.runIf(process.platform === 'win32')('rejects unsupported Windows process cleanup before starting a runner', async () => {
    await expect(runScript("throw new Error('runner must not spawn');")).rejects.toThrow('requires POSIX process-group signaling');
});
