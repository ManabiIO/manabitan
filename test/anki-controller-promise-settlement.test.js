import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';

test('getAnkiData does not leak a rejected cleanup promise', () => {
    const fixture = fileURLToPath(new URL('fixtures/anki-data-promise-settlement.mjs', import.meta.url));
    execFileSync(process.execPath, ['--unhandled-rejections=strict', fixture], {
        stdio: 'pipe',
        timeout: 30_000,
    });
});
