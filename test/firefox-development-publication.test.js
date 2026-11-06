import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {runInNewContext} from 'node:vm';
import {expect, test, vi} from 'vitest';

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

const releaseCheck = workflow.match(/ {6}- name: Verify the selected release upload destination\n[\s\S]+? {10}node --input-type=module <<'JAVASCRIPT'\n([\s\S]+?) {10}JAVASCRIPT/u)?.[1];
if (typeof releaseCheck !== 'string') { throw new Error('Missing release upload identity check'); }
const releaseTag = '26.11.6.0';
const uploadUrl = 'https://uploads.github.com/repos/ManabiIO/manabitan/releases/123/assets{?name,label}';

/**
 * @param {unknown} request
 * @param {string} [version]
 * @returns {Promise<unknown>}
 */
function checkRelease(request, version = releaseTag) {
    return runInNewContext(`(async () => {${releaseCheck}\n})()`, {
        fetch: request,
        process: {env: {
            GITHUB_API_URL: 'https://api.github.com',
            GITHUB_REPOSITORY: 'ManabiIO/manabitan',
            GH_TOKEN: 'test-token',
            RELEASE_TAG: version,
            RELEASE_UPLOAD_URL: uploadUrl,
        }},
    });
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

test('signing and uploading require the selected published release destination', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({tag_name: releaseTag, draft: false, upload_url: uploadUrl}));
    await checkRelease(request);
    expect(request.mock.calls[0][0]).toBe(`https://api.github.com/repos/ManabiIO/manabitan/releases/tags/${releaseTag}`);
    expect(workflow.indexOf('Verify the selected release upload destination')).toBeLessThan(workflow.indexOf('Sign Firefox xpi'));
});

test.each([
    {name: 'draft release', tag_name: releaseTag, draft: true, upload_url: uploadUrl},
    {name: 'different version', tag_name: '26.11.6.1', draft: false, upload_url: uploadUrl},
    {name: 'different upload destination', tag_name: releaseTag, draft: false, upload_url: uploadUrl.replace('/123/', '/456/')},
])('rejects a $name before external publication', async (release) => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(release));
    await expect(checkRelease(request)).rejects.toThrow(/Upload destination/u);
});

test.each([403, 404, 500])('release HTTP %i cannot be mistaken for publication readiness', async (status) => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, {status}));
    await expect(checkRelease(request)).rejects.toThrow(/Release lookup failed/u);
});

test.each(['0.0.0.0', '26.11.06.0', '26.11.6.65536', '26.11.6.$(false)'])('release version %s fails before any API call', async (version) => {
    const request = vi.fn();
    await expect(checkRelease(request, version)).rejects.toThrow(/four-part release version/u);
    expect(request).not.toHaveBeenCalled();
});
