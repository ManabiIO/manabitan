/* SPDX-License-Identifier: GPL-3.0-or-later */
import {API_VERSION, WebRuntimeError, record, type DefaultChoice, type LookupResult, type Operation, type Reply, type Status} from './protocol.js'
import type {Summary} from '../../types/ext/dictionary-importer'

export interface CallOptions { signal?: AbortSignal, onProgress?: (progress: unknown) => void }
interface Pending {
    operation: Operation
    parameters: unknown
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
    cleanup: () => void
    progress?: (value: unknown) => void
    posted: boolean
    cancelled: boolean
    timer?: ReturnType<typeof setTimeout>
}

/** Origin-local worker adapter. Only an executing request owns a worker watchdog. */
export class ManabiTanWebClient {
    static readonly apiVersion = API_VERSION
    private readonly worker: Worker
    private nextId = 1
    private readonly pending = new Map<number, Pending>()
    private readonly queue: number[] = []
    private activeId: number | null = null
    private stopped = false
    private closing?: Promise<void>
    private opened?: Promise<Status>

    constructor() {
        this.worker = new Worker(new URL('worker.js', import.meta.url), {type: 'module', name: 'ManabiTan local dictionary'})
        this.worker.addEventListener('message', (event: MessageEvent<unknown>) => {
            const data = event.data
            if (!record(data) || data.version !== API_VERSION || !Number.isSafeInteger(data.id)) {return}
            const result = data as unknown as Reply
            const entry = this.pending.get(result.id)
            if (!entry?.posted) {return}
            if ('progress' in result) {
                if (!entry.cancelled) {entry.progress?.(result.progress)}
                return
            }
            this.retire(result.id, entry)
            if (result.error) {
                const error = new WebRuntimeError(result.error.code ?? 'operation_failed', result.error.message)
                error.name = result.error.name
                entry.reject(error)
            } else {entry.resolve(result.result)}
            this.pump()
        })
        this.worker.addEventListener('error', () => this.fail(new WebRuntimeError('worker_failed', 'The local dictionary worker stopped. Retry to recover its journal.')))
        this.worker.addEventListener('messageerror', () => this.fail(new WebRuntimeError('protocol_error', 'The local dictionary worker returned unreadable data.')))
    }

    private retire(id: number, entry: Pending) {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.cleanup()
        if (this.activeId === id) {this.activeId = null}
    }

    private fail(error: Error) {
        this.stopped = true
        this.worker.terminate()
        for (const [id, entry] of this.pending) {
            this.retire(id, entry)
            entry.reject(error)
        }
        this.queue.length = 0
    }

    private post(id: number, entry: Pending) {
        entry.posted = true
        let timeout = 30_000
        switch (entry.operation) {
            case 'import': timeout = 15 * 60_000; break
            case 'delete': timeout = 120_000; break
            case 'close': timeout = 60_000; break
        }
        entry.timer = setTimeout(() => this.fail(new WebRuntimeError('worker_timeout', 'Dictionary operation timed out. Reopen to recover interrupted work.')), timeout)
        try {
            this.worker.postMessage({version: API_VERSION, id, operation: entry.operation, parameters: entry.parameters})
        } catch (error) {
            this.retire(id, entry)
            entry.reject(error)
            // Do not recursively consume a queue if every post fails synchronously.
            queueMicrotask(() => this.pump())
        }
    }

    private pump() {
        if (this.stopped || this.activeId !== null) {return}
        const id = this.queue.shift()
        if (typeof id === 'undefined') {return}
        const entry = this.pending.get(id)
        if (!entry) {throw new Error('Dictionary admission queue lost its owner')}
        this.activeId = id
        this.post(id, entry)
    }

    private call<T>(operation: Operation, parameters: unknown, options: CallOptions = {}, waitForCancellation = false): Promise<T> {
        if (this.stopped && operation !== 'close') {return Promise.reject(new WebRuntimeError('closed', 'Dictionary runtime is closed'))}
        if (options.signal?.aborted) {return Promise.reject(options.signal.reason ?? new DOMException('Cancelled', 'AbortError'))}
        if (operation !== 'close' && this.queue.length >= 32) {return Promise.reject(new WebRuntimeError('busy', 'Dictionary runtime has too many waiting requests'))}
        const id = this.nextId++
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => {
                const entry = this.pending.get(id)
                if (!entry || entry.cancelled) {return}
                entry.cancelled = true
                const reason = options.signal?.reason ?? new DOMException('Cancelled', 'AbortError')
                if (!entry.posted) {
                    const index = this.queue.indexOf(id)
                    if (index >= 0) {this.queue.splice(index, 1)}
                    this.retire(id, entry)
                    reject(reason)
                    return
                }
                try {
                    this.worker.postMessage({version: API_VERSION, id, operation: 'cancel'})
                } catch (error) {
                    this.fail(error instanceof Error ? error : new Error(String(error)))
                    return
                }
                if (!waitForCancellation) {reject(reason)}
                // Even when the caller stops waiting, the worker still owns this
                // operation. Retain its watchdog and admission slot until it replies.
            }
            const entry: Pending = {
                operation, parameters,
                resolve: (value) => resolve(value as T), reject,
                cleanup: () => options.signal?.removeEventListener('abort', onAbort),
                progress: options.onProgress, posted: false, cancelled: false,
            }
            this.pending.set(id, entry)
            options.signal?.addEventListener('abort', onAbort, {once: true})
            if (operation === 'close') {
                // Shutdown is the only out-of-band command. The worker cancels its
                // active importer and drains it before replying to close. Its own
                // bounded watchdog covers that entire shutdown, not queue admission.
                this.post(id, entry)
            } else {
                this.queue.push(id)
                this.pump()
            }
        })
    }

    open(): Promise<Status> {
        if (this.stopped) {return Promise.reject(new WebRuntimeError('closed', 'Dictionary runtime is closed'))}
        this.opened ??= this.call<Status>('open', {}).catch((error: Error) => {
            this.fail(error)
            throw error
        })
        return this.opened
    }

    status(options?: CallOptions) { return this.call<Status>('status', {}, options) }
    lookup(text: string, options?: CallOptions) { return this.call<LookupResult>('lookup', {text}, options) }
    importDictionary(archive: Blob, options?: CallOptions) {
        return this.call<{summary: Summary, warnings: string[], cancelledAfterCommit: boolean, status: Status}>('import', {archive}, options, true)
    }
    deleteDictionary(title: string, options?: CallOptions) { return this.call<Status>('delete', {title}, options, true) }
    setEnabled(title: string, enabled: boolean) { return this.call<Status>('enable', {title, enabled}) }
    setDefault(choice: Exclude<DefaultChoice, 'unasked'>, title?: string) { return this.call<Status>('default', {choice, title}) }
    media(dictionary: string, path: string, options?: CallOptions) {
        return this.call<{content: ArrayBuffer, mediaType: string} | null>('media', {dictionary, path}, options)
    }

    /** Reject waiting work, cancel the storage owner, and bound its shutdown. */
    close(): Promise<void> {
        if (this.closing) {return this.closing}
        if (this.stopped) {return Promise.resolve()}
        this.stopped = true
        for (const id of this.queue.splice(0)) {
            const entry = this.pending.get(id)
            if (!entry) {continue}
            this.retire(id, entry)
            entry.reject(new DOMException('Dictionary runtime closed', 'AbortError'))
        }
        this.closing = this.call<null>('close', {}).then(() => {}, (error: unknown) => {throw error}).finally(() => {
            this.fail(new DOMException('Dictionary runtime closed', 'AbortError'))
        })
        return this.closing
    }
}

export type {Status, LookupResult, DefaultChoice} from './protocol.js'
