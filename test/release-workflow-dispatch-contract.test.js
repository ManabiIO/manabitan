import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'vitest';

const repositoryRoot = process.cwd();

/**
 * @param {string} workflowPath
 * @returns {string[]}
 */
function dispatchSteps(workflowPath) {
    const lines = readFileSync(join(repositoryRoot, workflowPath), 'utf8').split('\n');
    const result = [];
    for (let i = 0; i < lines.length; ++i) {
        if (!lines[i].includes('uses: aurelien-baudet/workflow-dispatch@')) { continue; }
        const block = [];
        for (let j = i + 1; j < lines.length && !lines[j].startsWith('      - '); ++j) {
            block.push(lines[j]);
        }
        result.push(block.join('\n'));
    }
    return result;
}

describe('release workflow dispatch ref contract', () => {
    test('stable release publishers run against the released tag', () => {
        const steps = dispatchSteps('.github/workflows/release.yml');
        expect(steps).toHaveLength(3);
        for (const step of steps) {
            expect(step).toContain('ref: $' + '{{ github.event.release.tag_name }}');
        }
    });

    test('stable Chrome retry dispatches preserve the tag through the delay workflow', () => {
        const chromeRetry = dispatchSteps('.github/workflows/publish-chrome.yml');
        const delayedRetry = dispatchSteps('.github/workflows/delay.yml');
        expect(chromeRetry).toHaveLength(1);
        expect(chromeRetry[0]).toContain('ref: $' + '{{ github.ref }}');
        expect(delayedRetry).toHaveLength(1);
        expect(delayedRetry[0]).toContain('ref: $' + '{{ github.ref }}');
    });

    test('development Chrome retry dispatch preserves its generated tag', () => {
        const chromeRetry = dispatchSteps('.github/workflows/publish-chrome-development.yml');
        expect(chromeRetry).toHaveLength(1);
        expect(chromeRetry[0]).toContain('ref: $' + '{{ github.ref }}');
    });

    test('development publishers dispatch against the generated release tag', () => {
        const steps = dispatchSteps('.github/workflows/create-prerelease-on-tag.yml');
        expect(steps).toHaveLength(2);
        for (const step of steps) {
            expect(step).toContain('ref: $' + '{{ needs.build.outputs.version }}');
        }
    });

    test('branch-dispatched releases attach provenance to the resolved release tag', () => {
        const source = readFileSync(join(repositoryRoot, '.github/workflows/create-prerelease-on-tag.yml'), 'utf8');
        const buildOutputs = source.match(/ {4}outputs:\n((?: {6}.+\n)+)/u)?.[1];
        expect(buildOutputs).toContain('version: $' + '{{ steps.releaseVersion.outputs.version }}');
        const provenance = source.slice(source.indexOf('  provenance:\n'));
        expect(provenance).toContain('upload-assets: true');
        expect(provenance).toContain('upload-tag-name: $' + '{{ needs.build.outputs.version }}');
    });

    test('release assets stay in a draft until provenance and remote verification succeed', () => {
        const source = readFileSync(join(repositoryRoot, '.github/workflows/create-prerelease-on-tag.yml'), 'utf8');
        const build = source.slice(source.indexOf('  build:\n'), source.indexOf('  provenance:\n'));
        const provenance = source.slice(source.indexOf('  provenance:\n'), source.indexOf('  publish:\n'));
        const publish = source.slice(source.indexOf('  publish:\n'));
        expect(build).toContain('draft: true');
        expect(build).toContain('Refuse to replace an already public release');
        expect(build).not.toContain('Dispatch publish-');
        expect(provenance).toContain('draft-release: "true"');
        expect(publish).toContain('needs: [build, provenance]');
        expect(build).toContain('release_id: $' + '{{ steps.release.outputs.id }}');
        expect(publish).toContain('RELEASE_ID: $' + '{{ needs.build.outputs.release_id }}');
        expect(publish).toContain('gh api "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}" > release.json');
        const verify = publish.indexOf('node dev/bin/verify-staged-release.js');
        const makePublic = publish.indexOf('-F draft=false -F prerelease=true');
        expect(verify).toBeGreaterThan(-1);
        expect(makePublic).toBeGreaterThan(verify);
        expect(publish.indexOf('Dispatch publish-chrome-development')).toBeGreaterThan(makePublic);
        expect(publish.indexOf('Dispatch publish-firefox-development')).toBeGreaterThan(makePublic);
    });

    test('all store publishers select assets from the dispatched ref name', () => {
        for (const workflow of ['publish-chrome.yml', 'publish-firefox.yml', 'publish-edge.yml']) {
            const source = readFileSync(join(repositoryRoot, '.github/workflows', workflow), 'utf8');
            expect(source).toContain('tag: $' + '{{ github.ref_name }}');
        }
        const firefox = readFileSync(join(repositoryRoot, '.github/workflows/publish-firefox.yml'), 'utf8');
        expect(firefox).toContain('sourcesZipFilePath: manabitan-$' + '{{ github.ref_name }}.zip');
    });
});
