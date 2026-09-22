/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import {test} from 'vitest';
import {DictionaryCssMediaResolver, getMdictMediaPathsFromCss} from '../ext/js/display/dictionary-css-media-resolver.js';

/** @typedef {{dictionary: string, path: string, content: string, mediaType: string}} MediaResult */

/**
 * @param {() => Promise<MediaResult[]>} getMedia
 * @returns {{resolver: DictionaryCssMediaResolver, created: Array<Blob|MediaSource>, revoked: string[]}}
 */
function harness(getMedia) {
    /** @type {Array<Blob|MediaSource>} */
    const created = [];
    /** @type {string[]} */
    const revoked = [];
    const resolver = new DictionaryCssMediaResolver({getMedia}, {
        createObjectURL(blob) {
            created.push(blob);
            return `blob:media-${created.length}`;
        },
        revokeObjectURL(url) { revoked.push(url); },
    });
    return {resolver, created, revoked};
}

/**
 * @param {string} [dictionary]
 * @param {string} [path]
 * @returns {MediaResult}
 */
function item(dictionary = 'A', path = 'mdict-media/a.png') {
    return {dictionary, path, content: 'AA==', mediaType: 'image/png'};
}

test('disable with an empty cache rejects late delivery', async () => {
    /** @type {PromiseWithResolvers<MediaResult[]>} */
    const deferred = Promise.withResolvers();
    const {resolver, created} = harness(() => deferred.promise);
    resolver.prune([{name: 'A', enabled: true}]);
    const pending = resolver.resolve([item()]);
    resolver.prune([{name: 'A', enabled: false}]);
    deferred.resolve([item()]);
    assert.equal(await pending, false);
    assert.equal(created.length, 0);
});

test('disable and reenable cannot revive old delivery; fresh work succeeds', async () => {
    /** @type {PromiseWithResolvers<MediaResult[]>} */
    const deferred = Promise.withResolvers();
    let calls = 0;
    const {resolver, created} = harness(() => (++calls === 1 ? deferred.promise : Promise.resolve([item()])));
    resolver.prune([{name: 'A', enabled: true}]);
    const old = resolver.resolve([item()]);
    resolver.prune([{name: 'A', enabled: false}]);
    resolver.prune([{name: 'A', enabled: true}]);
    deferred.resolve([item()]);
    assert.equal(await old, false);
    assert.equal(await resolver.resolve([item()]), true);
    assert.equal(created.length, 1);
});

test('identical enabled membership keeps valid pending delivery', async () => {
    /** @type {PromiseWithResolvers<MediaResult[]>} */
    const deferred = Promise.withResolvers();
    const {resolver, created} = harness(() => deferred.promise);
    resolver.prune([{name: 'A', enabled: true}]);
    const pending = resolver.resolve([item()]);
    resolver.prune([{name: 'A', enabled: true}]);
    deferred.resolve([item()]);
    assert.equal(await pending, true);
    assert.equal(created.length, 1);
});

test('already disabled requests never fetch', async () => {
    let calls = 0;
    const {resolver} = harness(async () => {
        ++calls;
        return [item()];
    });
    resolver.prune([{name: 'A', enabled: false}]);
    assert.equal(await resolver.resolve([item()]), false);
    assert.equal(calls, 0);
});

test('cache identities cannot collide through delimiter-bearing names and paths', async () => {
    const first = item('A', 'mdict-media/x\u001fmdict-media/a.png');
    const second = item('A\u001fmdict-media/x', 'mdict-media/a.png');
    const {resolver, created} = harness(async () => [first, second]);
    assert.equal(await resolver.resolve([first, second]), true);
    assert.equal(created.length, 2);
});

test('CSS quoted text and comments are not image URLs', () => {
    const css = '.a {content: \'url("mdict-media/text.png")\'; /* url(mdict-media/comment.png) */ background:url(mdict-media/real.png)}';
    assert.deepEqual(getMdictMediaPathsFromCss(css), ['mdict-media/real.png']);
});

test('a URL-like identifier suffix is not url()', () => {
    assert.deepEqual(getMdictMediaPathsFromCss('x:noturl(mdict-media/fake.png); y:URL(mdict-media/real.png)'), ['mdict-media/real.png']);
});

test('quoted path whitespace is significant', () => {
    assert.deepEqual(getMdictMediaPathsFromCss('x:url("mdict-media/a.png ")'), ['mdict-media/a.png ']);
});

test('escaped unquoted parentheses stay in the URL', () => {
    assert.deepEqual(getMdictMediaPathsFromCss(String.raw`x:url(mdict-media/a\)b.png)`), ['mdict-media/a)b.png']);
});

test('clear still rejects pending delivery', async () => {
    /** @type {PromiseWithResolvers<MediaResult[]>} */
    const deferred = Promise.withResolvers();
    const {resolver, created} = harness(() => deferred.promise);
    const pending = resolver.resolve([item()]);
    resolver.clear();
    deferred.resolve([item()]);
    assert.equal(await pending, false);
    assert.equal(created.length, 0);
});

test('rewriting changes only genuine URL tokens, not identical quoted text or comments', async () => {
    const {resolver} = harness(async () => [item()]);
    await resolver.resolve([item()]);
    const prefix = '.a {content: \'url("mdict-media/a.png")\'; /* url(mdict-media/a.png) */ background:';
    assert.equal(resolver.rewriteStyles('A', `${prefix}url(mdict-media/a.png)}`), `${prefix}url("blob:media-1")}`);
});

test('CSS hex escapes preserve scalar values and replace invalid scalar escapes', () => {
    assert.deepEqual(getMdictMediaPathsFromCss(String.raw`x:url("mdict-media/\61 .png")`), ['mdict-media/a.png']);
    assert.deepEqual(getMdictMediaPathsFromCss(String.raw`x:url("mdict-media/\d800.png")`), ['mdict-media/\ufffd.png']);
    assert.deepEqual(getMdictMediaPathsFromCss('x:url("mdict-media/a\u00a0.png")'), ['mdict-media/a\u00a0.png']);
});

test('malformed URL functions do not publish partial paths', () => {
    for (const css of ['x:url(mdict-media/a.png trailing)', 'x:url("mdict-media/a.png" trailing)', 'x:url("mdict-media/unterminated)']) {
        assert.deepEqual(getMdictMediaPathsFromCss(css), []);
    }
});
