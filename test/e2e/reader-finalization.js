/* SPDX-License-Identifier: GPL-3.0-or-later */

/** @typedef {{status: 'fulfilled', value: unknown}|{status: 'rejected', reason: unknown}} Outcome */

/**
 * A host-side deadline also covers protocol operations whose renderer is stuck.
 * The operation receives a signal to avoid starting later work after timeout.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} operation
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<T>}
 */
async function withDeadline(operation, timeoutMs, label) {
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    /** @type {Promise<never>} */
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} deadline exceeded (${timeoutMs} ms)`);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
    });
    try {
        // Both race participants retain rejection handlers after timeout.
        return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Run diagnostic operations together under one shared deadline.
 * @param {Array<(signal: AbortSignal) => Promise<unknown>>} operations
 * @param {number} timeoutMs
 * @returns {Promise<Outcome[]>}
 */
export async function settleWithDeadline(operations, timeoutMs) {
    /** @type {Array<Outcome|undefined>} */
    const completed = new Array(operations.length);
    try {
        await withDeadline(async (signal) => {
            await Promise.all(operations.map(async (operation, index) => {
                try {
                    completed[index] = {status: 'fulfilled', value: await operation(signal)};
                } catch (reason) {
                    completed[index] = {status: 'rejected', reason};
                }
            }));
        }, timeoutMs, 'Reader diagnostics');
    } catch (reason) {
        return Array.from({length: operations.length}, (_, index) => completed[index] ?? {status: 'rejected', reason});
    }
    return /** @type {Outcome[]} */ (completed);
}

/**
 * @param {unknown} value
 * @returns {Error}
 */
function asError(value) {
    return value instanceof Error ? value : new Error(String(value), {cause: value});
}

/**
 * Cleanup is ordered. The final server shutdown is attempted even when the
 * preceding restoration fails, and a cleanup failure can never produce a pass.
 * @param {() => Promise<unknown>} body
 * @param {Array<(signal: AbortSignal) => Promise<unknown>>} diagnostics
 * @param {Array<(signal: AbortSignal) => Promise<unknown>>} cleanup
 * @param {(error: Error, diagnostics: Outcome[]|null) => void} reportFailure
 * @returns {Promise<unknown>}
 */
export async function runWithReaderFinalization(body, diagnostics, cleanup, reportFailure) {
    let result;
    /** @type {Error|null} */
    let primary = null;
    try {
        result = await withDeadline(body, 60_000, 'Reader bridge body');
    } catch (error) {
        primary = asError(error);
    }

    if (primary !== null) {
        try { reportFailure(primary, null); } catch { /* Reporting cannot replace the primary failure. */ }
        const outcomes = await settleWithDeadline(diagnostics, 2000);
        try { reportFailure(primary, outcomes); } catch { /* Reporting cannot replace the primary failure. */ }
    }

    /** @type {Error[]} */
    const failures = [];
    for (let index = 0; index < cleanup.length; ++index) {
        try {
            await withDeadline(cleanup[index], 10_000, `Reader cleanup step ${index + 1}`);
        } catch (error) {
            failures.push(asError(error));
        }
    }
    if (primary !== null) {
        if (failures.length > 0) {
            throw new Error(`${primary.message}; cleanup failed: ${failures.map(({message}) => message).join('; ')}`, {cause: primary});
        }
        throw primary;
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Reader bridge cleanup failed: ' + failures.map(({message}) => message).join('; '));
    }
    return result;
}
