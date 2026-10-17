import {afterEach, describe, expect, test} from 'vitest';
import {chmod, mkdir, mkdtemp, readFile, realpath, rename, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'enable-firefox-remote-debugging.sh');
/** @type {string[]} */
const temporaryDirectories = [];

afterEach(async () => {
    const trashPath = path.join(os.homedir(), '.Trash');
    await mkdir(trashPath, {recursive: true});
    const trashDirectory = await realpath(trashPath);
    await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rename(directory, path.join(trashDirectory, path.basename(directory)))));
});

describe('Firefox Android remote debugging preference helper', () => {
    test('quiesces Firefox before writing preferences, updates pending backup, and defers launch verification until after ACK', async () => {
        const fixture = await createFixture({hasBackup: true});
        runHelper(fixture);

        const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).join(' '));
        const disableIndex = commands.findIndex((command) => command.includes('pm disable-user --user 0 org.mozilla.firefox'));
        const firstPreferenceWriteIndex = commands.findIndex((command) => command.includes('cat /data/local/tmp/manabitan-fenix-preferences-') && command.includes('> /data/data/org.mozilla.firefox/shared_prefs/fenix_preferences.xml'));
        expect(disableIndex).toBeGreaterThan(-1);
        expect(firstPreferenceWriteIndex).toBeGreaterThan(disableIndex);
        expect(commands.some((command) => command.includes('monkey -p org.mozilla.firefox 1'))).toBe(true);
        expect(commands.some((command) => command.includes('pm enable --user 0 org.mozilla.firefox'))).toBe(true);
        expect(commands.some((command) => command.includes('monkey -p org.mozilla.firefox 1') && commands.indexOf(command) > firstPreferenceWriteIndex)).toBe(false);
        expect(commands.some((command) => command.includes('--verify-after-launch'))).toBe(false);

        const preference = await readFile(fixture.preferencePath, 'utf8');
        expect(preference).toContain('name="pref_key_remote_debugging" value="true"');
        const backup = await readFile(fixture.backupPath, 'utf8');
        expect(backup).toContain('name="pref_key_remote_debugging" value="true"');
    });

    test('fails closed on unexpected preference ownership and restores package enabled state', async () => {
        const fixture = await createFixture({wrongOwner: true});
        expect(() => runHelper(fixture)).toThrow(/Unexpected ownership or mode/);

        const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).join(' '));
        expect(commands.some((command) => command.includes('pm disable-user --user 0 org.mozilla.firefox'))).toBe(true);
        expect(commands.some((command) => command.includes('pm enable --user 0 org.mozilla.firefox'))).toBe(true);
        expect(commands.some((command) => command.includes('cat /data/local/tmp/manabitan-fenix-preferences-') && command.includes('> /data/data/org.mozilla.firefox/shared_prefs/fenix_preferences.xml'))).toBe(false);
    });

    test('refuses to edit when Firefox remains alive after package disable', async () => {
        const fixture = await createFixture({processStaysAlive: true});
        expect(() => runHelper(fixture)).toThrow(/process remained alive/);

        const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).join(' '));
        expect(commands.some((command) => command.includes('cat /data/local/tmp/manabitan-fenix-preferences-') && command.includes('> /data/data/org.mozilla.firefox/shared_prefs/fenix_preferences.xml'))).toBe(false);
        expect(commands.some((command) => command.includes('pm enable --user 0 org.mozilla.firefox'))).toBe(true);
    });

    test('rejects a false preference after the install ACK', async () => {
        const fixture = await createFixture();
        expect(() => runHelper(fixture, '--verify-after-launch')).toThrow(/did not retain pref_key_remote_debugging=true/);
    });
});

/**
 * @param {{wrongOwner?: boolean, processStaysAlive?: boolean, hasBackup?: boolean}} [options]
 * @returns {Promise<{directory: string, logPath: string, preferencePath: string, backupPath: string, adbPath: string}>}
 */
async function createFixture(options = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'manabitan-fenix-helper-test-'));
    temporaryDirectories.push(directory);
    const preferencePath = path.join(directory, 'fenix_preferences.xml');
    const backupPath = path.join(directory, 'fenix_preferences.xml.bak');
    const logPath = path.join(directory, 'adb.jsonl');
    await writeFile(preferencePath, '<?xml version="1.0" encoding="utf-8"?><map><boolean name="pref_key_remote_debugging" value="false"/></map>');
    if (options.hasBackup) {
        await writeFile(backupPath, '<?xml version="1.0" encoding="utf-8"?><map><boolean name="pref_key_remote_debugging" value="false"/></map>');
    }
    const adbPath = path.join(directory, 'adb');
    const adbSource = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.MOCK_ADB_LOG;
const preferencePath = process.env.MOCK_ADB_PREF;
const mapRemotePath = (value) => value === '/data/data/org.mozilla.firefox/shared_prefs/fenix_preferences.xml' ? preferencePath : value === '/data/data/org.mozilla.firefox/shared_prefs/fenix_preferences.xml.bak' ? require('node:path').join(require('node:path').dirname(preferencePath), 'fenix_preferences.xml.bak') : require('node:path').join(require('node:path').dirname(preferencePath), require('node:path').basename(value));
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const shellIndex = args.indexOf('shell');
const command = shellIndex >= 0 ? args.slice(shellIndex + 1).join(' ') : args.slice(2).join(' ');
const emit = (value) => process.stdout.write(value + '\\n');
if (args.includes('root') || args.includes('wait-for-device')) { emit(''); }
else if (command === 'id -u') emit('0');
else if (command.startsWith('monkey ')) emit('Events injected: 1');
else if (command.startsWith('cmd package list packages -U')) emit('package:org.mozilla.firefox uid:10001');
else if (command.startsWith('dumpsys package ')) emit('User 0: installed=true enabled=0');
else if (command.startsWith('test -f ')) { const p = command.slice('test -f '.length); if (!fs.existsSync(mapRemotePath(p))) process.exit(1); }
else if (command.startsWith('am force-stop ') || command.startsWith('pm disable-user ') || command.startsWith('pm enable ') || command.startsWith('pm default-state ') || command.startsWith('chown ') || command.startsWith('chmod ') || command.startsWith('restorecon ')) emit('');
else if (command.startsWith('pidof ')) { if (${options.processStaysAlive ? 'true' : 'false'}) emit('2567'); else process.exit(1); }
else if (command.startsWith('toybox stat ')) emit('${options.wrongOwner ? '10002' : '10001'} 10001 600');
else if (command.startsWith('ls -Z ')) emit('u:object_r:app_data_file:s0');
else if (command.startsWith('command -v restorecon')) emit('/system/bin/restorecon');
else if (args[2] === 'pull') { fs.copyFileSync(mapRemotePath(args[3]), args[4]); }
else if (args[2] === 'push') { fs.copyFileSync(args[3], mapRemotePath(args[4])); }
else if (command.startsWith('cat ')) { const match = command.match(/^cat (\\S+) > (\\S+)$/); if (!match) process.exit(2); fs.copyFileSync(mapRemotePath(match[1]), mapRemotePath(match[2])); }
else { process.stderr.write('Unexpected mocked adb invocation: ' + args.join(' ') + '\\n'); process.exit(2); }
`;
    await writeFile(adbPath, adbSource);
    await chmod(adbPath, 0o755);
    const sleepPath = path.join(directory, 'sleep');
    await writeFile(sleepPath, '#!/usr/bin/env sh\nexit 0\n');
    await chmod(sleepPath, 0o755);
    return {directory, logPath, preferencePath, backupPath, adbPath};
}

/**
 * @param {Awaited<ReturnType<typeof createFixture>>} fixture
 * @param {string} [mode]
 * @returns {void}
 */
function runHelper(fixture, mode = 'configure') {
    execFileSync('bash', [helperPath, 'emulator-5554', 'org.mozilla.firefox', mode], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${fixture.directory}:${process.env.PATH}`,
            MOCK_ADB_LOG: fixture.logPath,
            MOCK_ADB_PREF: fixture.preferencePath,
            MANABITAN_ANDROID_ENABLE_FIREFOX_REMOTE_DEBUGGING: '1',
        },
        timeout: 10_000,
    });
}
