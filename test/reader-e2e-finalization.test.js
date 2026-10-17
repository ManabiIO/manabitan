import {once} from 'node:events';
import {connect} from 'node:net';
import {afterEach, expect, test, vi} from 'vitest';
import {runWithReaderFinalization} from './e2e/reader-finalization.js';
import {startAnkiMockHttpServer} from './e2e/anki-mock-http-server.js';

afterEach(() => vi.useRealTimers());

test('stalled diagnostics and restoration retain the primary cause and still close the server', async () => {
    vi.useFakeTimers();
    const original = new Error('scenario 2 assertion failed');
    /** @type {string[]} */
    const attempted = [];
    const report = vi.fn();
    const run = runWithReaderFinalization(
        async () => { throw original; },
        [() => new Promise(() => {}), async () => { attempted.push('diagnostic'); }],
        [() => new Promise(() => {}), async () => { attempted.push('server close'); }],
        report,
    );
    const observed = run.catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledWith(original, null);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await observed;
    if (!(error instanceof Error)) {
        throw error;
    }
    expect(error.cause).toBe(original);
    expect(error.message).toContain('scenario 2 assertion failed');
    expect(error.message).toContain('Reader cleanup step 1 deadline exceeded');
    expect(attempted).toEqual(['diagnostic', 'server close']);
    expect(report.mock.calls[1][1]).toEqual([
        {status: 'rejected', reason: expect.any(Error)},
        {status: 'fulfilled', value: undefined},
    ]);
    expect(vi.getTimerCount()).toBe(0);
});

test('restoration finishes before server shutdown on a successful run', async () => {
    /** @type {string[]} */
    const order = [];
    /** @type {() => void} */
    let finishRestore = () => {};
    const restore = new Promise((resolve) => { finishRestore = () => resolve(void 0); });
    const run = runWithReaderFinalization(
        async () => 'ok',
        [],
        [async () => {
            order.push('restore start');
            await restore;
            order.push('restore complete');
        }, async () => { order.push('server close'); }],
        () => {},
    );
    await vi.waitFor(() => expect(order).toEqual(['restore start']));
    finishRestore();
    await expect(run).resolves.toBe('ok');
    expect(order).toEqual(['restore start', 'restore complete', 'server close']);
});

test('a stalled body gets a host deadline and still reaches cleanup', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const report = vi.fn();
    const observed = runWithReaderFinalization(
        () => new Promise(() => {}),
        [],
        [async () => { close(); }],
        report,
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await observed;
    if (!(error instanceof Error)) {
        throw error;
    }
    expect(error.message).toContain('Reader bridge body deadline exceeded');
    expect(report.mock.calls[0][1]).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});

test.each([null, 'non-Error failure'])('a thrown non-Error value remains a failure (%s)', async (reason) => {
    const close = vi.fn();
    const error = await runWithReaderFinalization(
        async () => { throw reason; },
        [],
        [async () => { close(); }],
        () => { throw new Error('reporter failed'); },
    ).catch((failure) => failure);
    if (!(error instanceof Error)) {
        throw error;
    }
    expect(error.cause).toBe(reason);
    expect(close).toHaveBeenCalledOnce();
});

test('cleanup failure rejects a successful body and remaining cleanup still runs', async () => {
    const close = vi.fn();
    const outcome = await runWithReaderFinalization(
        async () => 'ok',
        [],
        [async () => { throw new Error('restore failed'); }, async () => { close(); }],
        () => {},
    ).then(() => null, (error) => error);
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) {
        throw outcome;
    }
    expect(outcome.message).toContain('restore failed');
    expect(close).toHaveBeenCalledOnce();
});

test('successful body and cleanup return the body result', async () => {
    await expect(runWithReaderFinalization(async () => 'ok', [], [async () => {}], () => {})).resolves.toBe('ok');
});

test('mock shutdown closes a client with an unfinished request body', async () => {
    const server = await startAnkiMockHttpServer({handleRequestBody: () => ({result: null, error: null}), getScenarioState: () => ({})});
    const url = new URL(server.baseUrl);
    const socket = connect(Number(url.port), url.hostname);
    socket.on('error', () => {});
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let deadline;
    /** @type {Promise<void>|undefined} */
    let closed;
    try {
        await once(socket, 'connect');
        socket.write('POST /anki HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\nx');
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        closed = server.close();
        const outcome = await Promise.race([
            closed.then(() => 'closed'),
            new Promise((resolve) => { deadline = setTimeout(() => resolve('stalled'), 1000); }),
        ]);
        expect(outcome).toBe('closed');
    } finally {
        clearTimeout(deadline);
        socket.destroy();
        await (closed ?? server.close());
    }
});
