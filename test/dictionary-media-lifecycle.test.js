/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'vitest';
import {DictionaryImporterMediaLoader} from '../ext/js/dictionary/dictionary-importer-media-loader.js';

/** @typedef {{width: number, height: number, close: () => void}} Bitmap */

/**
 * @returns {{
 *   install: (name: string, value: unknown) => void,
 *   timers: Map<number, {callback: () => void, delay: number}>,
 *   created: string[],
 *   revoked: string[],
 *   images: {listeners: Map<string, Set<() => void>>, source: string|null, fire: (type: string) => void}[],
 *   failures: {constructorError: Error|null, sourceError: Error|null, listenerError: Error|null},
 *   FakeImage: new () => unknown,
 *   fireTimeouts: () => void,
 *   restore: () => void,
 * }}
 */
function createFixture() {
    /** @type {[string, PropertyDescriptor|undefined][]} */
    const originals = [];
    /** @type {Map<number, {callback: () => void, delay: number}>} */
    const timers = new Map();
    /** @type {string[]} */
    const created = [];
    /** @type {string[]} */
    const revoked = [];
    /** @type {FakeImage[]} */
    const images = [];
    /** @type {{constructorError: Error|null, sourceError: Error|null, listenerError: Error|null}} */
    const failures = {constructorError: null, sourceError: null, listenerError: null};
    let nextTimer = 0;
    /**
     * @param {string} name
     * @param {unknown} value
     */
    const install = (name, value) => {
        originals.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
        Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    };
    class FakeImage {
        /** */
        constructor() {
            if (failures.constructorError !== null) { throw failures.constructorError; }
            this.naturalWidth = 31;
            this.naturalHeight = 41;
            /** @type {Map<string, Set<() => void>>} */
            this.listeners = new Map();
            /** @type {string|null} */
            this.source = null;
            images.push(this);
        }

        /** @returns {string|null} */
        get src() { return this.source; }

        /** @param {string} source */
        set src(source) {
            if (failures.sourceError !== null) { throw failures.sourceError; }
            this.source = source;
        }

        /**
         * @param {string} type
         * @param {() => void} listener
         */
        addEventListener(type, listener) {
            if (type === 'error' && failures.listenerError !== null) { throw failures.listenerError; }
            let listeners = this.listeners.get(type);
            if (typeof listeners === 'undefined') {
                listeners = new Set();
                this.listeners.set(type, listeners);
            }
            listeners.add(listener);
        }

        /**
         * @param {string} type
         * @param {() => void} listener
         */
        removeEventListener(type, listener) {
            const listeners = this.listeners.get(type);
            listeners?.delete(listener);
            if (listeners?.size === 0) { this.listeners.delete(type); }
        }

        /** @param {string} name */
        removeAttribute(name) {
            assert.equal(name, 'src');
            this.source = null;
        }

        /** @param {string} type */
        fire(type) {
            for (const listener of this.listeners.get(type) ?? []) { listener(); }
        }
    }
    /**
     * @param {() => void} callback
     * @param {number} delay
     * @returns {number}
     */
    const schedule = (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, {callback, delay});
        return id;
    };
    /** @param {number} id */
    const clear = (id) => { timers.delete(id); };
    class FakeURL extends URL {
        /**
         * @param {Blob} blob
         * @returns {string}
         */
        static createObjectURL(blob) {
            assert.ok(blob instanceof Blob);
            const url = `blob:fixture-${created.length}`;
            created.push(url);
            return url;
        }

        /** @param {string} url */
        static revokeObjectURL(url) { revoked.push(url); }
    }
    install('setTimeout', schedule);
    install('clearTimeout', clear);
    install('URL', FakeURL);
    install('Image', void 0);
    install('createImageBitmap', void 0);
    return {
        install,
        timers,
        created,
        revoked,
        images,
        failures,
        FakeImage,
        fireTimeouts() {
            const pending = [...timers.values()];
            timers.clear();
            for (const {callback, delay} of pending) {
                assert.equal(delay, 60_000);
                callback();
            }
        },
        restore() {
            for (const [name, descriptor] of originals.reverse()) {
                if (typeof descriptor === 'undefined') {
                    Reflect.deleteProperty(globalThis, name);
                } else {
                    Object.defineProperty(globalThis, name, descriptor);
                }
            }
        },
    };
}

/** @returns {{promise: Promise<Bitmap>, resolve: (value: Bitmap) => void, reject: (error: Error) => void}} */
function deferredBitmap() {
    /** @type {(value: Bitmap) => void} */
    let resolve = () => {};
    /** @type {(error: Error) => void} */
    let reject = () => {};
    /** @type {Promise<Bitmap>} */
    const promise = new Promise((resolve0, reject0) => {
        resolve = resolve0;
        reject = reject0;
    });
    return {promise, resolve, reject};
}

/** @returns {Promise<void>} */
async function flushMicrotasks() {
    for (let i = 0; i < 8; ++i) { await Promise.resolve(); }
}

/** @type {ReturnType<typeof createFixture>} */
let fixture;
beforeEach(() => { fixture = createFixture(); });
afterEach(() => { fixture.restore(); });

/** */
function assertDomCleanup() {
    assert.deepEqual(fixture.revoked, fixture.created);
    assert.equal(fixture.timers.size, 0);
    for (const image of fixture.images) {
        assert.equal(image.listeners.size, 0);
        assert.equal(image.source, null);
    }
}

test('DOM success returns dimensions and transfers content exactly once', async () => {
    fixture.install('Image', fixture.FakeImage);
    fixture.install('createImageBitmap', () => { throw new Error('DOM must be preferred'); });
    const content = new ArrayBuffer(4);
    /** @type {Transferable[]} */
    const transfer = [];
    const promise = new DictionaryImporterMediaLoader().getImageDetails(content, 'image/png', transfer);
    fixture.images[0].fire('load');
    assert.deepEqual(await promise, {content, width: 31, height: 41});
    fixture.images[0].fire('load');
    assert.deepEqual(transfer, [content]);
    assertDomCleanup();
});

test('DOM error releases URL, listeners and timer without transferring content', async () => {
    fixture.install('Image', fixture.FakeImage);
    /** @type {Transferable[]} */
    const transfer = [];
    const promise = new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png', transfer);
    const rejection = assert.rejects(promise, /Image failed to load/);
    fixture.images[0].fire('error');
    await rejection;
    assert.deepEqual(transfer, []);
    assertDomCleanup();
});

test('DOM timeout ignores later load events and releases its resources', async () => {
    fixture.install('Image', fixture.FakeImage);
    /** @type {Transferable[]} */
    const transfer = [];
    const promise = new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png', transfer);
    const rejection = assert.rejects(promise, /Timed out loading image metadata after 60000ms/);
    fixture.fireTimeouts();
    await rejection;
    fixture.images[0].fire('load');
    assert.deepEqual(transfer, []);
    assertDomCleanup();
});

test('DOM constructor failure never allocates an object URL', async () => {
    fixture.install('Image', fixture.FakeImage);
    fixture.failures.constructorError = new Error('constructor failure');
    await assert.rejects(new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png'), /constructor failure/);
    assert.equal(fixture.created.length, 0);
    assertDomCleanup();
});

test('DOM source assignment failure immediately releases all acquired resources', async () => {
    fixture.install('Image', fixture.FakeImage);
    fixture.failures.sourceError = new Error('source assignment failure');
    await assert.rejects(new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png'), /source assignment failure/);
    assert.equal(fixture.created.length, 1);
    assertDomCleanup();
});

test('DOM listener setup failure releases earlier listeners and the object URL', async () => {
    fixture.install('Image', fixture.FakeImage);
    fixture.failures.listenerError = new Error('listener setup failure');
    await assert.rejects(new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png'), /listener setup failure/);
    assert.equal(fixture.created.length, 1);
    assertDomCleanup();
});

test('DOM result processing failure rejects immediately and cleans up', async () => {
    fixture.install('Image', fixture.FakeImage);
    /** @type {Transferable[]} */
    const transfer = [];
    Object.freeze(transfer);
    const promise = new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png', transfer);
    const rejection = assert.rejects(promise, TypeError);
    assert.doesNotThrow(() => { fixture.images[0].fire('load'); });
    await rejection;
    assertDomCleanup();
});

test('bitmap success closes the bitmap and clears its timeout', async () => {
    let closes = 0;
    fixture.install('createImageBitmap', async () => ({width: 31, height: 41, close() { ++closes; }}));
    const content = new ArrayBuffer(4);
    /** @type {Transferable[]} */
    const transfer = [];
    assert.deepEqual(await new DictionaryImporterMediaLoader().getImageDetails(content, 'image/png', transfer), {content, width: 31, height: 41});
    assert.equal(closes, 1);
    assert.deepEqual(transfer, [content]);
    assert.equal(fixture.timers.size, 0);
});

test('bitmap rejection preserves the decoder error and clears its timeout', async () => {
    fixture.install('createImageBitmap', async () => { throw new Error('decode failure'); });
    await assert.rejects(new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png'), /decode failure/);
    assert.equal(fixture.timers.size, 0);
});

test('synchronous bitmap decoder failure does not leave a timer', async () => {
    fixture.install('createImageBitmap', () => { throw new Error('synchronous decode failure'); });
    await assert.rejects(new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png'), /synchronous decode failure/);
    assert.equal(fixture.timers.size, 0);
});

test('a stalled bitmap decoder is bounded by the same 60-second timeout', async () => {
    const decoder = deferredBitmap();
    fixture.install('createImageBitmap', () => decoder.promise);
    const promise = new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png');
    const rejection = assert.rejects(promise, /Timed out loading image metadata after 60000ms/);
    assert.equal(fixture.timers.size, 1);
    fixture.fireTimeouts();
    await rejection;
    assert.equal(fixture.timers.size, 0);
});

test('a bitmap completing after timeout is closed without mutating the transfer list', async () => {
    const decoder = deferredBitmap();
    fixture.install('createImageBitmap', () => decoder.promise);
    /** @type {Transferable[]} */
    const transfer = [];
    let closes = 0;
    const promise = new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png', transfer);
    const rejection = assert.rejects(promise, /Timed out loading image metadata after 60000ms/);
    assert.equal(fixture.timers.size, 1);
    fixture.fireTimeouts();
    await rejection;
    decoder.resolve({width: 31, height: 41, close() { ++closes; }});
    await flushMicrotasks();
    assert.equal(closes, 1);
    assert.deepEqual(transfer, []);
    assert.equal(fixture.timers.size, 0);
});

test('a bitmap rejection after timeout remains handled', async () => {
    const decoder = deferredBitmap();
    fixture.install('createImageBitmap', () => decoder.promise);
    const promise = new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png');
    const rejection = assert.rejects(promise, /Timed out loading image metadata after 60000ms/);
    assert.equal(fixture.timers.size, 1);
    fixture.fireTimeouts();
    await rejection;
    decoder.reject(new Error('late decode failure'));
    await flushMicrotasks();
    assert.equal(fixture.timers.size, 0);
});

test('bitmap result processing failure still closes its bitmap', async () => {
    let closes = 0;
    fixture.install('createImageBitmap', async () => ({width: 31, height: 41, close() { ++closes; }}));
    /** @type {Transferable[]} */
    const transfer = [];
    Object.freeze(transfer);
    await assert.rejects(new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png', transfer), TypeError);
    assert.equal(closes, 1);
    assert.equal(fixture.timers.size, 0);
});

test('missing decoder still returns the existing unsupported-runtime error', async () => {
    await assert.rejects(new DictionaryImporterMediaLoader().getImageDetails(new ArrayBuffer(4), 'image/png'), /not supported in this runtime/);
    assert.equal(fixture.timers.size, 0);
});
