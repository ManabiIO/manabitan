import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test, vi} from 'vitest';
import {verifyReleaseDestination} from '../dev/bin/verify-release-destination.js';

const environment = {
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_REPOSITORY: 'ManabiIO/manabitan',
    GH_TOKEN: 'test-token',
    RELEASE_TAG: '26.11.16.0',
    RELEASE_UPLOAD_URL: 'https://uploads.github.com/repos/ManabiIO/manabitan/releases/123/assets{?name,label}',
};
const publishedRelease = {tag_name: environment.RELEASE_TAG, draft: false, upload_url: environment.RELEASE_UPLOAD_URL};

test.each([false, true])('accepts the matching published release (prerelease: %s)', async (prerelease) => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({...publishedRelease, prerelease}));
    await verifyReleaseDestination(environment, request);
    expect(request).toHaveBeenCalledExactlyOnceWith('https://api.github.com/repos/ManabiIO/manabitan/releases/tags/26.11.16.0', {
        headers: {Authorization: 'Bearer test-token', Accept: 'application/vnd.github+json'},
    });
});

test.each([
    {...publishedRelease, draft: true},
    {...publishedRelease, tag_name: '26.11.16.1'},
    {...publishedRelease, upload_url: environment.RELEASE_UPLOAD_URL.replace('/123/', '/456/')},
    {...publishedRelease, upload_url: 'https://example.invalid/assets'},
    {},
    null,
    [],
])('rejects an unverified release destination: %j', async (release) => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(release));
    await expect(verifyReleaseDestination(environment, request)).rejects.toThrow(/Upload destination/u);
});

test.each([403, 404, 500])('rejects release lookup HTTP %i', async (status) => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, {status}));
    await expect(verifyReleaseDestination(environment, request)).rejects.toThrow(/Release lookup failed/u);
});

test.each(['0.0.0.0', '26.11.016.0', '26.11.16.65536', '26.11.16.$(false)', '', undefined])('rejects version %s without an API call', async (version) => {
    const request = vi.fn();
    await expect(verifyReleaseDestination({...environment, RELEASE_TAG: version}, request)).rejects.toThrow(/four-part release version/u);
    expect(request).not.toHaveBeenCalled();
});

test.each(['GITHUB_API_URL', 'GITHUB_REPOSITORY', 'GH_TOKEN', 'RELEASE_UPLOAD_URL'])('rejects missing %s without an API call', async (key) => {
    const request = vi.fn();
    await expect(verifyReleaseDestination({...environment, [key]: ''}, request)).rejects.toThrow(/lookup configuration/u);
    expect(request).not.toHaveBeenCalled();
});

test('propagates failed network and malformed JSON responses', async () => {
    await expect(verifyReleaseDestination(environment, vi.fn().mockRejectedValueOnce(new Error('offline')))).rejects.toThrow('offline');
    await expect(verifyReleaseDestination(environment, vi.fn().mockResolvedValueOnce(new Response('invalid JSON')))).rejects.toThrow();
});

test.each([
    {workflow: 'publish-chrome-development.yml', job: 'release-crx', gate: 'crxConfig', signing: 'Sign Chrome crx'},
    {workflow: 'publish-firefox-development.yml', job: 'build', gate: 'signingConfig', signing: 'Sign Firefox xpi'},
])('$workflow verifies the destination before signing or upload', ({workflow, job, gate, signing}) => {
    const source = readFileSync(join(process.cwd(), '.github/workflows', workflow), 'utf8');
    const jobSource = source.slice(source.indexOf(`  ${job}:\n`));
    const check = jobSource.indexOf('Verify the selected release upload destination');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(jobSource.indexOf(signing));
    expect(check).toBeLessThan(jobSource.indexOf('Upload offline'));
    expect(jobSource.slice(0, check)).toContain('path: release-source');
    const block = jobSource.slice(check, jobSource.indexOf('\n      - ', check));
    expect(block).toContain(`if: steps.${gate}.outputs.enabled == 'true'`);
    expect(block).toContain('RELEASE_TAG: $' + '{{ inputs.tag }}');
    expect(block).toContain('RELEASE_UPLOAD_URL: $' + '{{ inputs.upload_url }}');
    expect(block).toContain('node release-source/dev/bin/verify-release-destination.js');
});
