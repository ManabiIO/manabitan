import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {expect, test, vi} from 'vitest';

const source = readFileSync(join(process.cwd(), '.github/workflows/create-prerelease-on-tag.yml'), 'utf8');
const script = source.match(/ {6}- name: Refuse to replace an already public release\n[\s\S]+? {10}node --input-type=module <<'JAVASCRIPT'\n([\s\S]+?) {10}JAVASCRIPT/u)?.[1];
if (typeof script !== 'string') { throw new Error('Missing release identity preflight'); }
const version = '26.11.6.0';
const sha = 'a'.repeat(40);

/**
 * @param {unknown} request
 * @param {Record<string, string>} overrides
 * @returns {Promise<unknown>}
 */
function preflight(request, overrides = {}) {
    return runInNewContext(`(async () => {${script}\n})()`, {
        fetch: request,
        process: {env: {
            GITHUB_API_URL: 'https://api.github.com',
            GITHUB_REPOSITORY: 'ManabiIO/manabitan',
            GH_TOKEN: 'test-token',
            RELEASE_VERSION: version,
            GITHUB_SHA: sha,
            GITHUB_REF_TYPE: 'tag',
            ...overrides,
        }},
    });
}

test('a tagged release requires the exact existing tag without creating another ref', async () => {
    const request = vi.fn()
        .mockResolvedValueOnce(new Response(null, {status: 404}))
        .mockResolvedValueOnce(Response.json({sha}));
    await preflight(request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe(`https://api.github.com/repos/ManabiIO/manabitan/commits/refs/tags/${version}`);
});

test('manual branch dispatch pins its new tag before draft creation', async () => {
    const request = vi.fn()
        .mockResolvedValueOnce(new Response(null, {status: 404}))
        .mockResolvedValueOnce(new Response(null, {status: 404}))
        .mockResolvedValueOnce(Response.json({}, {status: 201}));
    await preflight(request, {GITHUB_REF_TYPE: 'branch'});
    expect(request.mock.calls[2][0]).toBe('https://api.github.com/repos/ManabiIO/manabitan/git/refs');
    expect(request.mock.calls[2][1].method).toBe('POST');
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ref: `refs/tags/${version}`, sha});
});

test('a draft can be retried against its original tag', async () => {
    const request = vi.fn()
        .mockResolvedValueOnce(Response.json({draft: true}))
        .mockResolvedValueOnce(Response.json({sha}));
    await preflight(request);
    expect(request).toHaveBeenCalledTimes(2);
});

test('public releases cannot have assets replaced by a rerun', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({draft: false}));
    await expect(preflight(request)).rejects.toThrow(/Public release assets are immutable/u);
    expect(request).toHaveBeenCalledTimes(1);
});

test('release lookup permission errors do not mean the version is unused', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, {status: 403}));
    await expect(preflight(request)).rejects.toThrow(/HTTP 403/u);
    expect(request).toHaveBeenCalledTimes(1);
});

test('a tag-triggered build cannot recreate a missing tag', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, {status: 404}));
    await expect(preflight(request)).rejects.toThrow(/Release tag lookup failed/u);
    expect(request).toHaveBeenCalledTimes(2);
});

test('an existing tag pointing to another commit blocks publication', async () => {
    const request = vi.fn()
        .mockResolvedValueOnce(new Response(null, {status: 404}))
        .mockResolvedValueOnce(Response.json({sha: 'b'.repeat(40)}));
    await expect(preflight(request)).rejects.toThrow(/different source commit/u);
});

test('manual dispatch cannot overwrite a tag created concurrently', async () => {
    const request = vi.fn()
        .mockResolvedValueOnce(new Response(null, {status: 404}))
        .mockResolvedValueOnce(new Response(null, {status: 404}))
        .mockResolvedValueOnce(new Response(null, {status: 422}));
    await expect(preflight(request, {GITHUB_REF_TYPE: 'branch'})).rejects.toThrow(/Release tag creation failed: HTTP 422/u);
});

test.each(['0.0.0.0', '26.11.06.0', '26.11.6.65536', '26.11.6.$(false)'])('invalid release version %s fails before remote operations', async (badVersion) => {
    const request = vi.fn();
    await expect(preflight(request, {RELEASE_VERSION: badVersion})).rejects.toThrow(/four-part browser version/u);
    expect(request).not.toHaveBeenCalled();
});
