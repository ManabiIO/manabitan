/* Browser-side instrumentation, installed only by the E2E harness. */

/**
 * Arm a single import operation before dispatching input or confirming an update.
 * This function is self-contained so Playwright can serialize it into the page.
 */
export function armBrowserImportTiming() {
    // Reload/restart tests create pages outside the initial context setup.
    Reflect.set(globalThis, '__manabitanImportCompletionSignalEnabled', true);
    const previous = Reflect.get(globalThis, '__manabitanImportTimingCleanup');
    if (typeof previous === 'function') { previous(); }
    const sequenceBefore = Number(Reflect.get(globalThis, '__manabitanImportCompletionSequence') ?? 0);
    /** @type {{sequenceBefore: number, sequence: number|null, startedAtMs: number|null, completedAtMs: number|null, nextFrameAtMs: number|null, trigger: string|null, errorCount: number|null}} */
    const timing = {sequenceBefore, sequence: null, startedAtMs: null, completedAtMs: null, nextFrameAtMs: null, trigger: null, errorCount: null};
    Reflect.set(globalThis, '__manabitanBrowserImportTiming', timing);
    let frame = 0;
    const cleanup = () => {
        document.removeEventListener('change', start, true);
        document.removeEventListener('click', start, true);
        globalThis.removeEventListener('manabitan:dictionary-import-complete', complete);
        if (frame !== 0) { cancelAnimationFrame(frame); }
    };
    /** @param {Event} event */
    const start = (event) => {
        if (timing.startedAtMs !== null || !(event.target instanceof Element)) { return; }
        const fileInput = event.type === 'change' && event.target.matches('#dictionary-import-file-input');
        const update = event.type === 'click' && event.target.closest('#dictionary-confirm-update-button') !== null;
        if (!fileInput && !update) { return; }
        timing.startedAtMs = performance.now();
        timing.trigger = fileInput ? 'file-input-change' : 'update-confirm-click';
    };
    /** @param {Event} event */
    const complete = (event) => {
        if (!(event instanceof CustomEvent) || timing.startedAtMs === null || timing.completedAtMs !== null) { return; }
        const detail = /** @type {{sequence?: number, importRunCurrent?: boolean, completedAtMonotonicMs?: number, errorCount?: number}} */ (event.detail);
        if (detail?.importRunCurrent !== true || !Number.isSafeInteger(detail.sequence) || Number(detail.sequence) <= sequenceBefore) { return; }
        const completedAt = detail.completedAtMonotonicMs;
        if (typeof completedAt !== 'number' || !Number.isFinite(completedAt) || completedAt < timing.startedAtMs) { return; }
        timing.sequence = Number(detail.sequence);
        timing.completedAtMs = completedAt;
        timing.errorCount = detail.errorCount ?? null;
        cleanup();
        frame = requestAnimationFrame(() => {
            // This is a next-frame opportunity, not a guarantee of physical paint.
            timing.nextFrameAtMs = performance.now();
        });
    };
    document.addEventListener('change', start, true);
    document.addEventListener('click', start, true);
    globalThis.addEventListener('manabitan:dictionary-import-complete', complete);
    Reflect.set(globalThis, '__manabitanImportTimingCleanup', cleanup);
}
