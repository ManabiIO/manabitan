/* SPDX-License-Identifier: GPL-3.0-or-later */
import {API_VERSION, WebRuntimeError, record} from './protocol.js';
import type {DefaultChoice, LookupResult, Operation, Reply, Status} from './protocol.js';
import type {Summary} from '../../types/ext/dictionary-importer';

export interface CallOptions { signal?: AbortSignal; onProgress?: (progress: unknown) => void }
interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
    progress?: (value: unknown) => void;
}
/** Origin-local, versioned worker adapter. It never contacts a Manabi server. */
export class ManabiTanWebClient {
    static readonly apiVersion = API_VERSION;
    private readonly worker: Worker;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private stopped = false;
    private closing?: Promise<void>;
    private opened?: Promise<Status>;
    constructor() {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module', name: 'ManabiTan local dictionary'});
        this.worker.addEventListener('message', (event: MessageEvent<unknown>) => {
            const data = event.data;
            if (!record(data) || data.version !== API_VERSION || !Number.isSafeInteger(data.id)) return;
            const result = data as unknown as Reply;
            const entry = this.pending.get(result.id);
            if (!entry) return;
            if ('progress' in result) { entry.progress?.(result.progress); return; }
            this.pending.delete(result.id); entry.cleanup();
            if (result.error) {
                const error = new WebRuntimeError(result.error.code ?? 'operation_failed', result.error.message);
                error.name = result.error.name;
                entry.reject(error);
            } else entry.resolve(result.result);
        });
        this.worker.addEventListener('error', () => this.fail(new WebRuntimeError('worker_failed', 'The local dictionary worker stopped. Retry to recover its journal.')));
        this.worker.addEventListener('messageerror', () => this.fail(new WebRuntimeError('protocol_error', 'The local dictionary worker returned unreadable data.')));
    }
    private fail(error: Error) {
        this.stopped = true; this.worker.terminate();
        for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error); }
        this.pending.clear();
    }
    private call<T>(operation: Operation, parameters: unknown, options: CallOptions = {}, waitForCancellation = false): Promise<T> {
        if (this.stopped && operation !== 'close') return Promise.reject(new WebRuntimeError('closed', 'Dictionary runtime is closed'));
        if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => {
                this.worker.postMessage({version: API_VERSION, id, operation: 'cancel'});
                // Import must report whether atomic completion won the race with
                // cancellation; do not promise rollback before its owner settles.
                if (!waitForCancellation) {
                    this.pending.delete(id); cleanup();
                    reject(options.signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
                }
            };
            // A failed worker fetch or a stalled decoder must not leave a live
            // storage owner and a permanently pending UI. Termination preserves
            // the journal for the next open and fails every outstanding request.
            const timeout = operation === 'import' ? 15 * 60_000 : operation === 'delete' ? 120_000 : operation === 'close' ? 60_000 : 30_000;
            const timer = setTimeout(() => this.fail(new WebRuntimeError('worker_timeout', 'Dictionary operation timed out. Reopen to recover interrupted work.')), timeout);
            const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); };
            this.pending.set(id, {resolve: (v) => resolve(v as T), reject, cleanup, progress: options.onProgress});
            options.signal?.addEventListener('abort', onAbort, {once: true});
            try { this.worker.postMessage({version: API_VERSION, id, operation, parameters}); }
            catch (error) { this.pending.delete(id); cleanup(); reject(error); }
        });
    }
    open(): Promise<Status> {
        if (this.stopped) return Promise.reject(new WebRuntimeError('closed', 'Dictionary runtime is closed'));
        this.opened ??= this.call<Status>('open', {}).catch((error: Error) => { this.fail(error); throw error; });
        return this.opened;
    }
    status(options?: CallOptions) { return this.call<Status>('status', {}, options); }
    lookup(text: string, options?: CallOptions) { return this.call<LookupResult>('lookup', {text}, options); }
    importDictionary(archive: Blob, options?: CallOptions) {
        return this.call<{summary: Summary; warnings: string[]; cancelledAfterCommit: boolean; status: Status}>('import', {archive}, options, true);
    }
    deleteDictionary(title: string, options?: CallOptions) { return this.call<Status>('delete', {title}, options, true); }
    setEnabled(title: string, enabled: boolean) { return this.call<Status>('enable', {title, enabled}); }
    setDefault(choice: Exclude<DefaultChoice, 'unasked'>, title?: string) { return this.call<Status>('default', {choice, title}); }
    media(dictionary: string, path: string, options?: CallOptions) {
        return this.call<{content: ArrayBuffer; mediaType: string} | null>('media', {dictionary, path}, options);
    }
    /** Stops admissions synchronously; drains/recoverably terminates the sole storage owner. */
    close(): Promise<void> {
        if (this.closing) return this.closing;
        if (this.stopped) return Promise.resolve();
        this.stopped = true;
        this.closing = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    this.call<null>('close', {}),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WebRuntimeError('close_timeout', 'Dictionary shutdown timed out; the next open will recover interrupted work.')), 60000); })
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
