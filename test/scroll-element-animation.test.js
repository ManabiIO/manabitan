/* SPDX-License-Identifier: GPL-3.0-or-later */
import {afterEach, expect, test, vi} from 'vitest';
import {ScrollElement} from '../ext/js/dom/scroll-element.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * @returns {{pending: Map<number, (time: number) => void>, cancel: ReturnType<typeof vi.fn>, node: Element, scroll: ScrollElement}}
 */
function createHarness() {
    /** @type {Map<number, (time: number) => void>} */
    const pending = new Map();
    let nextId = 0;
    const request = vi.fn((callback) => {
        const id = ++nextId;
        pending.set(id, callback);
        return id;
    });
    const cancel = vi.fn((id) => { pending.delete(id); });
    vi.stubGlobal('window', {performance: {now: () => 0}, requestAnimationFrame: request, cancelAnimationFrame: cancel});
    const node = /** @type {Element} */ (/** @type {unknown} */ ({scrollLeft: 0, scrollTop: 0}));
    return {pending, cancel, node, scroll: new ScrollElement(node)};
}

test('restarting animation cancels its predecessor, including already queued callbacks', () => {
    const {pending, cancel, node, scroll} = createHarness();
    scroll.animate(100, 50, 1000);
    const oldFrame = pending.get(1);
    if (!oldFrame) { throw new Error('Missing original frame'); }
    scroll.animate(200, 60, 200);
    expect(cancel).toHaveBeenCalledWith(1);
    expect([...pending.keys()]).toEqual([2]);
    oldFrame(100);
    expect(node.scrollLeft).toBe(0);
    expect(node.scrollTop).toBe(0);
    expect([...pending.keys()]).toEqual([2]);
    const newFrame = pending.get(2);
    if (!newFrame) { throw new Error('Missing replacement frame'); }
    pending.delete(2);
    newFrame(250);
    expect(node.scrollLeft).toBe(200);
    expect(node.scrollTop).toBe(60);
    expect(pending.size).toBe(0);
});

test('stop makes an already queued animation callback harmless', () => {
    const {pending, node, scroll} = createHarness();
    scroll.animate(100, 30, 1000);
    const frame = pending.get(1);
    if (!frame) { throw new Error('Missing animation frame'); }
    scroll.stop();
    expect(pending.size).toBe(0);
    frame(200);
    expect(node.scrollLeft).toBe(0);
    expect(node.scrollTop).toBe(0);
    expect(pending.size).toBe(0);
});

test.each([0, -10, Number.NaN, Number.POSITIVE_INFINITY])('invalid or immediate duration %s snaps without scheduling an endless animation', (time) => {
    const {pending, node, scroll} = createHarness();
    scroll.animate(42, 17, time);
    expect(node.scrollLeft).toBe(42);
    expect(node.scrollTop).toBe(17);
    expect(pending.size).toBe(0);
});
