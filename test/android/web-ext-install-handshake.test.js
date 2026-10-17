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
 * @param {{timeoutMs?: number, command?: string, commandArgs?: string[], onOutput?: (line: string) => void, cwd?: string}} [overrides]
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

describe('Firefox Android web-ext install handshake', () => {
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
        const childScript = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"],{stdio:'ignore'}); console.log('child-pid='+child.pid); console.log('Waiting for RemoteDebuggingServer'); setInterval(()=>{},1000);";
        /** @type {string[]} */
        const output = [];
        await expect(runScript(childScript, {
            timeoutMs: 100,
            command: process.execPath,
            commandArgs: ['-e', childScript],
            onOutput: (line) => output.push(line),
        })).rejects.toThrow('Timed out after 100 ms waiting for Firefox Android remote debugger install acknowledgement');
        const pidLine = output.find((line) => line.startsWith('child-pid='));
        expect(pidLine).toBeDefined();
        const childPid = Number(pidLine?.slice('child-pid='.length));
        await expectProcessToExit(childPid);
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
