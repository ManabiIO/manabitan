import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, test} from 'vitest';
import {collectAndroidNativeFailureEvidence} from './firefox-android-native-failure-evidence.js';

describe('Android native failure evidence collector', () => {
    test('preserves screenshot bytes and records independent command outcomes and capture stage', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'manabitan-android-evidence-'));
        const outputDirectory = path.join(root, 'builds', 'firefox-android-capability-diagnostics');
        const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
        const hierarchy = Buffer.from('<hierarchy/>');
        /** @type {string[][]} */
        const commands = [];
        /** @type {number[]} */
        const commandTimeouts = [];
        const evidence = await collectAndroidNativeFailureEvidence({
            adbDevice: 'emulator-test-serial',
            outputDirectory,
            stage: 'runtime-failure-before-owned-tab-cleanup',
            runCommand: async (args, options) => {
                commands.push(args);
                commandTimeouts.push(Number(options.timeout));
                const joined = args.join(' ');
                if (joined.endsWith('exec-out screencap -p')) { return {stdout: screenshot}; }
                if (joined.endsWith('shell dumpsys activity activities')) { throw new Error('activity unavailable'); }
                if (joined.endsWith('shell dumpsys window windows')) { return {stdout: 'mCurrentFocus=Window{fixture}'}; }
                if (joined.includes('shell uiautomator dump /sdcard/manabitan-android-capability-')) { return {stdout: 'dumped'}; }
                if (joined.includes('exec-out cat /sdcard/manabitan-android-capability-')) { return {stdout: hierarchy}; }
                throw new Error(`Unexpected adb invocation: ${joined}`);
            },
        });

        expect(evidence.stage).toBe('runtime-failure-before-owned-tab-cleanup');
        expect(evidence.capturedAtIso).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(evidence.artifacts).toMatchObject({
            screenshot: {status: 'success', bytes: screenshot.byteLength, binary: true},
            activity: {status: 'error', error: expect.stringContaining('activity unavailable')},
            windows: {status: 'success'},
            uiHierarchy: {status: 'success', bytes: hierarchy.byteLength},
        });
        expect(await readFile(path.join(outputDirectory, String(evidence.artifacts.screenshot.path)))).toEqual(screenshot);
        expect(await readFile(path.join(outputDirectory, String(evidence.artifacts.uiHierarchy.path)))).toEqual(hierarchy);
        expect(commands.every((args) => args[0] === '-s' && args[1] === 'emulator-test-serial')).toBe(true);
        expect(commandTimeouts.every((timeout) => timeout > 0 && timeout <= 40_000)).toBe(true);
        const dumpCommand = commands.find((args) => args.includes('uiautomator'));
        const readbackCommand = commands.find((args) => args.includes('cat'));
        expect(dumpCommand?.at(-1)).toMatch(/^\/sdcard\/manabitan-android-capability-[0-9a-f-]+\.xml$/);
        expect(readbackCommand?.at(-1)).toBe(dumpCommand?.at(-1));
    });
});
