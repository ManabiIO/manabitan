import {afterEach, describe, expect, vi} from 'vitest';
import {armBrowserImportTiming} from './e2e/import-timing.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

function snapshot() {
    return /** @type {{startedAtMs: number|null, completedAtMs: number|null, trigger: string|null, sequence: number|null}} */ (Reflect.get(globalThis, '__manabitanBrowserImportTiming'));
}

afterEach(() => {
    const cleanup = Reflect.get(globalThis, '__manabitanImportTimingCleanup');
    if (typeof cleanup === 'function') { cleanup(); }
    for (const key of ['__manabitanBrowserImportTiming', '__manabitanImportTimingCleanup', '__manabitanImportCompletionSequence', '__manabitanImportCompletionSignalEnabled']) {
        Reflect.deleteProperty(globalThis, key);
    }
    vi.restoreAllMocks();
});

describe('page-side import timing', () => {
    test('starts at the input event, not at arming or automation completion', ({window}) => {
        const input = window.document.createElement('input');
        input.id = 'dictionary-import-file-input';
        window.document.body.append(input);
        let now = 100;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        armBrowserImportTiming();
        expect(Reflect.get(globalThis, '__manabitanImportCompletionSignalEnabled')).toBe(true);
        expect(snapshot().startedAtMs).toBeNull();
        now = 400;
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        expect(snapshot().startedAtMs).toBe(400);
        now = 2000;
        globalThis.dispatchEvent(new window.CustomEvent('manabitan:dictionary-import-complete', {
            detail: {sequence: 1, importRunCurrent: true, completedAtMonotonicMs: 900, errorCount: 0},
        }));
        expect(snapshot().completedAtMs).toBe(900);
    });

    test('captures update confirmation and ignores stale completion', ({window}) => {
        const button = window.document.createElement('button');
        button.id = 'dictionary-confirm-update-button';
        window.document.body.append(button);
        Reflect.set(globalThis, '__manabitanImportCompletionSequence', 3);
        vi.spyOn(performance, 'now').mockReturnValue(100);
        armBrowserImportTiming();
        button.click();
        expect(snapshot().trigger).toBe('update-confirm-click');
        for (const [sequence, importRunCurrent] of [[3, true], [4, false]]) {
            globalThis.dispatchEvent(new window.CustomEvent('manabitan:dictionary-import-complete', {
                detail: {sequence, importRunCurrent, completedAtMonotonicMs: 200, errorCount: 0},
            }));
            expect(snapshot().completedAtMs).toBeNull();
        }
        globalThis.dispatchEvent(new window.CustomEvent('manabitan:dictionary-import-complete', {
            detail: {sequence: 4, importRunCurrent: true, completedAtMonotonicMs: 300, errorCount: 0},
        }));
        expect(snapshot().completedAtMs).toBe(300);
    });

    test('rearming detaches the previous operation', ({window}) => {
        const input = window.document.createElement('input');
        input.id = 'dictionary-import-file-input';
        window.document.body.append(input);
        armBrowserImportTiming();
        const old = snapshot();
        armBrowserImportTiming();
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        expect(old.startedAtMs).toBeNull();
        expect(snapshot().startedAtMs).not.toBeNull();
    });

    test('ignores unrelated input and malformed completion timestamps', ({window}) => {
        const input = window.document.createElement('input');
        window.document.body.append(input);
        vi.spyOn(performance, 'now').mockReturnValue(100);
        armBrowserImportTiming();
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        expect(snapshot().startedAtMs).toBeNull();
        input.id = 'dictionary-import-file-input';
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        for (const completedAtMonotonicMs of [undefined, Number.NaN, Infinity, 99]) {
            globalThis.dispatchEvent(new window.CustomEvent('manabitan:dictionary-import-complete', {
                detail: {sequence: 1, importRunCurrent: true, completedAtMonotonicMs, errorCount: 0},
            }));
            expect(snapshot().completedAtMs).toBeNull();
        }
    });

    test('records only one completion and cancels its pending frame on rearm', ({window}) => {
        const input = window.document.createElement('input');
        input.id = 'dictionary-import-file-input';
        window.document.body.append(input);
        vi.spyOn(performance, 'now').mockReturnValue(100);
        vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(42);
        const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
        armBrowserImportTiming();
        input.dispatchEvent(new window.Event('change', {bubbles: true}));
        for (const completedAtMonotonicMs of [200, 300]) {
            globalThis.dispatchEvent(new window.CustomEvent('manabitan:dictionary-import-complete', {
                detail: {sequence: 1, importRunCurrent: true, completedAtMonotonicMs, errorCount: 0},
            }));
        }
        expect(snapshot().completedAtMs).toBe(200);
        armBrowserImportTiming();
        expect(cancel).toHaveBeenCalledWith(42);
        expect(snapshot().completedAtMs).toBeNull();
    });
});
