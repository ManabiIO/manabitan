/* SPDX-License-Identifier: GPL-3.0-or-later */
import {API_VERSION, WebRuntimeError, record, type DefaultChoice, type LookupResult, type Operation, type Reply, type Status} from './protocol.js';
import type {Summary} from '../../types/ext/dictionary-importer';

export interface CallOptions { signal?: AbortSignal, onProgress?: (progress: unknown) => void }
interface Pending {
    timeout: number
    callerCancelled: boolean
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
    progress?: (value: unknown) => void;
}

/** Origin-local, versioned worker adapter. It never contacts a Manabi server. */
export class ManabiTanWebClient {
    /**
     *
     */
    static readonly apiVersion = API_VERSION;
    /**
     *
     */
    private readonly worker: Worker;
    /**
     *
     */
    private nextId = 1;
    /**
     *
     */
    private readonly pending = new Map<number, Pending>();
    /**
     *
     */
    private watchdogId?: number
    private watchdogTimer?: ReturnType<typeof setTimeout>
    private stopped = false;
    /**
     *
     */
    private closing?: Promise<void>;
    /**
     *
     */
    private opened?: Promise<Status>;
    constructor() {
        /**
         *
         */
        this.worker = new Worker(new URL('worker.js', import.meta.url), {type: 'module', name: 'ManabiTan local dictionary'});
        this.worker.addEventListener('message', (event: MessageEvent<unknown>) => {
            const data = event.data;
            if (!record(data) || data.version !== API_VERSION || !Number.isSafeInteger(data.id)) {return;}
            const result = data as unknown as Reply;
            const entry = this.pending.get(result.id);
            if (!entry) {return;}
            if ('progress' in result) {
                if (!entry.callerCancelled) {entry.progress?.(result.progress);}
                return;
            }
            this.pending.delete(result.id);
            entry.cleanup();
            this.updateWatchdog()
            if (result.error) {
                const error = new WebRuntimeError(result.error.code ?? 'operation_failed', result.error.message);
                error.name = result.error.name;
                entry.reject(error);
            } else {entry.resolve(result.result);}
        });
        this.worker.addEventListener('error', () => this.fail(new WebRuntimeError('worker_failed', 'The local dictionary worker stopped. Retry to recover its journal.')));
        this.worker.addEventListener('messageerror', () => this.fail(new WebRuntimeError('protocol_error', 'The local dictionary worker returned unreadable data.')));
    }

    /**
     *
     * @param error
     */
    private fail(error: Error) {
        this.stopped = true;
        this.worker.terminate();
        clearTimeout(this.watchdogTimer)
        this.watchdogTimer = undefined
        this.watchdogId = undefined
        for (const entry of this.pending.values()) {
            entry.cleanup();
            entry.reject(error);
        }
        this.pending.clear();
    }

    /** The worker dispatches FIFO. Waiting requests do not own execution time. */
    private updateWatchdog() {
        const next = this.pending.entries().next().value
        const id = next?.[0]
        if (id === this.watchdogId) {return}
        clearTimeout(this.watchdogTimer)
        this.watchdogTimer = undefined
        this.watchdogId = id
        if (!next) {return}
        const entry = next[1]
        this.watchdogTimer = setTimeout(() => {
            // A callback already queued by the host cannot terminate a successor.
            if (this.watchdogId !== id) {return}
            this.fail(new WebRuntimeError('worker_timeout', 'Dictionary operation timed out. Reopen to recover interrupted work.'))
        }, entry.timeout)
    }

    /**
     *
     * @param operation
     * @param parameters
     * @param options
     * @param waitForCancellation
     */
    private call<T>(operation: Operation, parameters: unknown, options: CallOptions = {}, waitForCancellation = false): Promise<T> {
        if (this.stopped && operation !== 'close') {return Promise.reject(new WebRuntimeError('closed', 'Dictionary runtime is closed'));}
        if (options.signal?.aborted) {return Promise.reject(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));}
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => {
                try {
                    this.worker.postMessage({version: API_VERSION, id, operation: 'cancel'})
                } catch (error) {
                    this.fail(error instanceof Error ? error : new Error(String(error)))
                    return
                }
                // Import must report whether atomic completion won the race with
                // cancellation; do not promise rollback before its owner settles.
                if (!waitForCancellation) {
                    // Cancelling a caller does not prove the worker has stopped.
                    // Keep its FIFO position and watchdog until its terminal reply.
                    const entry = this.pending.get(id)
                    if (entry) {entry.callerCancelled = true}
                    cleanup();
                    reject(options.signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
                }
            };
            // A failed worker fetch or a stalled decoder must not leave a live
            // storage owner and a permanently pending UI. Termination preserves
            // the journal for the next open and fails every outstanding request.
            let timeout = 30_000;
            switch (operation) {
                case 'import': {
                    timeout = 15 * 60_000;

                    break;
                }
                case 'delete': {
                    timeout = 120_000;

                    break;
                }
                case 'close': {
                    timeout = 60_000;

                    break;
                }
            // No default
            }
            const cleanup = () => {
                options.signal?.removeEventListener('abort', onAbort);
            };
            this.pending.set(id, {timeout, callerCancelled: false, resolve: (v) => resolve(v as T), reject, cleanup, progress: options.onProgress});
            this.updateWatchdog()
            options.signal?.addEventListener('abort', onAbort, {once: true});
            try {
                this.worker.postMessage({version: API_VERSION, id, operation, parameters});
            } catch (error) {
                this.pending.delete(id);
                cleanup();
                this.updateWatchdog()
                reject(error);
            }
        });
    }

    /**
     *
     */
    open(): Promise<Status> {
        if (this.stopped) {return Promise.reject(new WebRuntimeError('closed', 'Dictionary runtime is closed'));}
        this.opened ??= this.call<Status>('open', {}).catch((error: Error) => {
            this.fail(error);
            throw error;
        });
        return this.opened;
    }

    /**
     *
     * @param options
     */
    status(options?: CallOptions) { return this.call<Status>('status', {}, options); }
    /**
     *
     * @param text
     * @param options
     */
    lookup(text: string, options?: CallOptions) { return this.call<LookupResult>('lookup', {text}, options); }
    /**
     *
     * @param archive
     * @param options
     */
    importDictionary(archive: Blob, options?: CallOptions) {
        return this.call<{summary: Summary, warnings: string[], cancelledAfterCommit: boolean, status: Status}>('import', {archive}, options, true);
    }

    /**
     *
     * @param title
     * @param options
     */
    deleteDictionary(title: string, options?: CallOptions) { return this.call<Status>('delete', {title}, options, true); }
    /**
     *
     * @param title
     * @param enabled
     */
    setEnabled(title: string, enabled: boolean) { return this.call<Status>('enable', {title, enabled}); }
    /**
     *
     * @param choice
     * @param title
     */
    setDefault(choice: Exclude<DefaultChoice, 'unasked'>, title?: string) { return this.call<Status>('default', {choice, title}); }
    /**
     *
     * @param dictionary
     * @param path
     * @param options
     */
    media(dictionary: string, path: string, options?: CallOptions) {
        return this.call<{content: ArrayBuffer, mediaType: string} | null>('media', {dictionary, path}, options);
    }

    /** Stops admissions synchronously; drains/recoverably terminates the sole storage owner. */
    close(): Promise<void> {
        if (this.closing) {return this.closing;}
        if (this.stopped) {return Promise.resolve();}
        this.stopped = true;
        this.closing = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    this.call<null>('close', {}),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WebRuntimeError('close_timeout', 'Dictionary shutdown timed out; the next open will recover interrupted work.')), 60000); }),
                ]);
            } finally {
                clearTimeout(timer);
                this.fail(new DOMException('Dictionary runtime closed', 'AbortError'));
            }
        })();
        return this.closing;
    }
}

export type {Status, LookupResult, DefaultChoice} from './protocol.js';
