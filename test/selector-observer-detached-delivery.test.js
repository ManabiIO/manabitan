/* SPDX-License-Identifier: GPL-3.0-or-later */
import {JSDOM} from 'jsdom';
import {afterEach, expect, test, vi} from 'vitest';
import {SelectorObserver} from '../ext/js/dom/selector-observer.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * @param {JSDOM} dom
 */
function prepareDom(dom) {
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    vi.stubGlobal('Node', dom.window.Node);
}

test('detached attribute mutation cannot resurrect an observer removed in the same delivery', async () => {
    const dom = new JSDOM('<div id="root"><span id="child"></span></div>');
    prepareDom(dom);
    const root = dom.window.document.getElementById('root');
    const child = dom.window.document.getElementById('child');
    if (!root || !child) { throw new Error('Missing DOM fixture'); }
    const onAdded = vi.fn(() => ({}));
    const onRemoved = vi.fn();
    const observer = new SelectorObserver({selector: 'span', onAdded, onRemoved});
    try {
        observer.observe(root, true);
        expect([...observer.entries()]).toHaveLength(1);
        child.remove();
        child.dataset.state = 'detached';
        await Promise.resolve();
        expect(onAdded).toHaveBeenCalledTimes(1);
        expect(onRemoved).toHaveBeenCalledTimes(1);
        expect([...observer.entries()]).toHaveLength(0);
    } finally {
        observer.disconnect();
        dom.window.close();
    }
});

test('same-batch insertion moved outside the observed root is ignored', async () => {
    const dom = new JSDOM('<div id="root"></div><div id="other"></div>');
    prepareDom(dom);
    const root = dom.window.document.getElementById('root');
    const other = dom.window.document.getElementById('other');
    if (!root || !other) { throw new Error('Missing DOM fixture'); }
    const onAdded = vi.fn(() => ({}));
    const onRemoved = vi.fn();
    const observer = new SelectorObserver({selector: 'span', onAdded, onRemoved});
    try {
        observer.observe(root);
        const child = dom.window.document.createElement('span');
        root.append(child);
        other.append(child);
        await Promise.resolve();
        expect(onAdded).not.toHaveBeenCalled();
        expect(onRemoved).not.toHaveBeenCalled();
        expect([...observer.entries()]).toHaveLength(0);
    } finally {
        observer.disconnect();
        dom.window.close();
    }
});

test('invalid observer startup leaves instance available for a valid retry', () => {
    const dom = new JSDOM('<div id="root"><span></span></div>');
    prepareDom(dom);
    const root = dom.window.document.getElementById('root');
    if (!root) { throw new Error('Missing DOM fixture'); }
    const observer = new SelectorObserver({selector: 'span', onAdded: () => ({})});
    try {
        const invalid = /** @type {Element} */ (/** @type {unknown} */ ({}));
        expect(() => observer.observe(invalid)).toThrow();
        expect(observer.isObserving).toBe(false);
        observer.observe(root);
        expect(observer.isObserving).toBe(true);
        expect([...observer.entries()]).toHaveLength(1);
    } finally {
        observer.disconnect();
        dom.window.close();
    }
});
