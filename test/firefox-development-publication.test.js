import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {runInNewContext} from 'node:vm';
import {expect, test} from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/publish-firefox-development.yml'), 'utf8');
const abort = workflow.match(/ {6}- name: Abort on sign error\n {8}if: \|\n((?: {10}.+\n)+) {8}run:/u);
if (abort === null) { throw new Error('Missing Firefox signing failure gate'); }
const condition = abort[1].trim();
const run = promisify(execFile);
const commitBlock = workflow.match(/ {6}- name: Commit files\n([\s\S]+?)(?=\n {6}- name:)/u)?.[1];
const commitScript = commitBlock?.split('        run: |\n')[1];

async function metadataRepository() {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'manabitan-feed-commit-')));
    await run('git', ['init', '--quiet', '--template='], {cwd: directory});
    await run('git', ['config', 'commit.gpgsign', 'false'], {cwd: directory});
    await run('git', ['config', 'core.hooksPath', '.git/hooks'], {cwd: directory});
    await writeFile(join(directory, 'updates.json'), '{}\n');
    await run('git', ['add', 'updates.json'], {cwd: directory});
    await run('git', ['-c', 'user.name=Feed test', '-c', 'user.email=feed@example.invalid', 'commit', '--quiet', '-m', 'baseline'], {cwd: directory});
    const {stdout} = await run('git', ['rev-parse', 'HEAD'], {cwd: directory});
    return {directory, baseline: stdout.trim()};
}

/**
 * @param {string} directory
 * @returns {ReturnType<typeof run>}
 */
function commitFeed(directory) {
    if (typeof commitScript !== 'string') { throw new Error('Missing metadata commit script'); }
    return run('bash', ['-e', '-c', commitScript], {cwd: directory, env: {...process.env, RELEASE_TAG: '26.11.6.0'}});
}

test.each([
    {name: 'signed artifact produced', enabled: 'true', outcome: 'success', outputs: {}, fail: false},
    {name: 'remote version exists without local publication proof', enabled: 'true', outcome: 'failure', outputs: {sameVersionAlreadyUploadedError: 'true'}, fail: true},
    {name: 'signing timeout', enabled: 'true', outcome: 'failure', outputs: {timeoutError: 'true'}, fail: true},
    {name: 'unclassified signing error', enabled: 'true', outcome: 'failure', outputs: {}, fail: true},
    {name: 'optional channel unconfigured', enabled: 'false', outcome: 'skipped', outputs: {}, fail: false},
])('Firefox offline publication: $name', ({enabled, outcome, outputs, fail}) => {
    const actual = runInNewContext(condition, {steps: {signingConfig: {outputs: {enabled}}, ffSignXpi: {outcome, outputs}}});
    expect(actual).toBe(fail);
});

test('manual offline publication attaches signed-XPI provenance to the selected release', () => {
    const provenance = workflow.slice(workflow.indexOf('  provenance:\n'));
    expect(provenance).toContain('upload-tag-name: $' + '{{ inputs.tag }}');
});

test('all offline versions share one publication concurrency group without interrupting an active signer', () => {
    expect(workflow).toMatch(/concurrency:\n {2}group: firefox-development-delivery\n {2}cancel-in-progress: false/u);
});

test('feed commit failures cannot be converted to successful publication', () => {
    expect(commitBlock).not.toContain('continue-on-error: true');
    expect(commitBlock).toContain('git diff --cached --quiet');
});

test('an unchanged verified feed is a successful no-op', async () => {
    const {directory, baseline} = await metadataRepository();
    await commitFeed(directory);
    const {stdout} = await run('git', ['rev-parse', 'HEAD'], {cwd: directory});
    expect(stdout.trim()).toBe(baseline);
});

test('a changed verified feed creates a metadata commit', async () => {
    const {directory, baseline} = await metadataRepository();
    await writeFile(join(directory, 'updates.json'), '{"updated":true}\n');
    await commitFeed(directory);
    const {stdout} = await run('git', ['rev-parse', 'HEAD'], {cwd: directory});
    expect(stdout.trim()).not.toBe(baseline);
    expect(await readFile(join(directory, 'updates.json'), 'utf8')).toBe('{"updated":true}\n');
});

test('an actual Git commit rejection fails the publication step', async () => {
    const {directory, baseline} = await metadataRepository();
    const hooks = join(directory, '.git', 'hooks');
    await mkdir(hooks);
    expect(await realpath(hooks)).toBe(hooks);
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', {flag: 'wx', mode: 0o755});
    await writeFile(join(directory, 'updates.json'), '{"updated":true}\n');
    await expect(commitFeed(directory)).rejects.toThrow();
    const {stdout} = await run('git', ['rev-parse', 'HEAD'], {cwd: directory});
    expect(stdout.trim()).toBe(baseline);
});
