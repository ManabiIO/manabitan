/* SPDX-License-Identifier: GPL-3.0-or-later */
import {JSDOM} from 'jsdom';
import {afterEach, expect, test, vi} from 'vitest';
import {DOMDataBinder} from '../ext/js/dom/dom-data-binder.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * @param {JSDOM} dom
 */
function prepareDom(dom) {
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
}

test('an old settings read never overwrites an input edited while it was pending', async () => {
    const dom = new JSDOM('<div id="root"><input id="setting" type="text"></div>');
    prepareDom(dom);
    const root = dom.window.document.getElementById('root');
    const input = dom.window.document.getElementById('setting');
    if (!root || !(input instanceof dom.window.HTMLInputElement)) { throw new Error('Missing input fixture'); }

    /** @type {(results: import('../types/ext/dom-data-binder.d.ts').TaskResult[]) => void} */
    let finishRead = () => {};
    const getValues = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
        .mockResolvedValue([{result: 'user value'}]);
    const setValues = vi.fn(async (/** @type {import('../types/ext/dom-data-binder.d.ts').SetValuesDetails<string>[]} */ args) => args.map(({value}) => ({result: value})));
    const binder = new DOMDataBinder(['input'], () => 'setting', (a, b) => a === b, getValues, setValues);
    try {
        binder.observe(root);
        await vi.waitFor(() => { expect(getValues).toHaveBeenCalledTimes(1); });
        input.value = 'user value';
        input.dispatchEvent(new dom.window.Event('change'));
        await vi.waitFor(() => { expect(setValues).toHaveBeenCalledTimes(1); });
        finishRead([{result: 'stale value'}]);
        await binder.refresh();
        expect(input.value).toBe('user value');
    } finally {
        binder.disconnect();
        dom.window.close();
    }
});

test('a refresh started during a pending save cannot restore the previous setting', async () => {
    const dom = new JSDOM('<div id="root"><input id="setting" type="text"></div>');
    prepareDom(dom);
    const root = dom.window.document.getElementById('root');
    const input = dom.window.document.getElementById('setting');
    if (!root || !(input instanceof dom.window.HTMLInputElement)) { throw new Error('Missing input fixture'); }

    /** @type {(results: import('../types/ext/dom-data-binder.d.ts').TaskResult[]) => void} */
    let finishWrite = () => {};
    const getValues = vi.fn(async () => [{result: 'old'}]);
    const setValues = vi.fn(() => new Promise((resolve) => { finishWrite = resolve; }));
    const binder = new DOMDataBinder(['input'], () => 'setting', (a, b) => a === b, getValues, setValues);
    try {
        binder.observe(root);
        await vi.waitFor(() => { expect(input.value).toBe('old'); });
        input.value = 'new';
        input.dispatchEvent(new dom.window.Event('change'));
        await vi.waitFor(() => { expect(setValues).toHaveBeenCalledTimes(1); });
        await binder.refresh();
        expect(input.value).toBe('new');
        finishWrite([{result: 'new'}]);
        await vi.waitFor(() => {
            const active = binder._selectorObservers[0].datas().next().value;
            if (!active) { throw new Error('No active binding'); }
            expect(active.pendingAssign).toBe(false);
        });
        expect(input.value).toBe('new');
    } finally {
        binder.disconnect();
        dom.window.close();
    }
});

test('changing input type invalidates the old observer and rebinds the new type', async () => {
    const dom = new JSDOM('<div id="root"><input id="setting" type="text"></div>');
    prepareDom(dom);
    const root = dom.window.document.getElementById('root');
    const input = dom.window.document.getElementById('setting');
    if (!root || !(input instanceof dom.window.HTMLInputElement)) { throw new Error('Missing input fixture'); }
    const getValues = vi.fn(async (args) => args.map(() => ({result: false})));
    const setValues = vi.fn(async (args) => args.map(() => ({result: false})));
    const binder = new DOMDataBinder(['input'], () => 'setting', (a, b) => a === b, getValues, setValues);
    try {
        binder.observe(root);
        const first = binder._selectorObservers[0].datas().next().value;
        if (!first) { throw new Error('No initial binding'); }
        expect(first.type).toBe('text');
        input.type = 'checkbox';
        await vi.waitFor(() => {
            const current = binder._selectorObservers[0].datas().next().value;
            if (!current) { throw new Error('No current binding'); }
            expect(current.type).toBe('checkbox');
            expect(current).not.toBe(first);
        });
    } finally {
        binder.disconnect();
        dom.window.close();
    }
});

test('a failed write releases the pending mark so a future refresh can recover', async () => {
    const dom = new JSDOM('<div id="root"><input id="setting" type="text"></div>');
    prepareDom(dom);
    const root = dom.window.document.getElementById('root');
    const input = dom.window.document.getElementById('setting');
    if (!root || !(input instanceof dom.window.HTMLInputElement)) { throw new Error('Missing input fixture'); }
    const getValues = vi.fn(async () => [{result: 'saved'}]);
    const setValues = vi.fn(async () => [{error: new Error('Write rejected')}]);
    const binder = new DOMDataBinder(['input'], () => 'setting', (a, b) => a === b, getValues, setValues);
    try {
        binder.observe(root);
        await vi.waitFor(() => { expect(input.value).toBe('saved'); });
        input.value = 'unsaved';
        input.dispatchEvent(new dom.window.Event('change'));
        await vi.waitFor(() => { expect(setValues).toHaveBeenCalledTimes(1); });
        await vi.waitFor(() => {
            const active = binder._selectorObservers[0].datas().next().value;
            if (!active) { throw new Error('No active binding'); }
            expect(active.pendingAssign).toBe(false);
        });
        await binder.refresh();
        expect(input.value).toBe('saved');
    } finally {
        binder.disconnect();
        dom.window.close();
    }
});
