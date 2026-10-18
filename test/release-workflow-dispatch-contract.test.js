import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'vitest';

const repositoryRoot = process.cwd();

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
            expect(step).toContain('ref: $' + '{{ steps.releaseVersion.outputs.version }}');
        }
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
