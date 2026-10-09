/* SPDX-License-Identifier: GPL-3.0-or-later */
import {fetchJson} from '../js/core/fetch-utilities.js';
import {WebRuntimeError, record} from './protocol.js';

/** Pinned independently of the app shell. Distribution must retain upstream notices. */
export const DEFAULT_DICTIONARY = Object.freeze({
    name: 'Jitendex',
    version: '2026.08.11.0',
    fileName: 'jitendex-2026.08.11.0.zip',
    bytes: 38698313,
    sha256: '8364e69e7bd0881c42011e96af921a7399d7fe06e2bf4fff4da6d18affff74fc',
    source: 'https://github.com/stephenmk/stephenmk.github.io/releases/download/2026.08.11.0/jitendex-yomitan.zip',
    license: 'CC-BY-SA-4.0',
    attribution: 'Jitendex by Stephen Kraus; includes JMdict, Tatoeba and JmdictFurigana data.',
    notices: 'https://jitendex.org/pages/legal.html',
});

export interface RecommendedDictionary { name: string, description: string, homepage: string, downloadUrl: string, category: string }

/** Reuse the extension catalog rather than maintain a competing Reader recommendation list. */
export async function recommendedDictionaries(): Promise<RecommendedDictionary[]> {
    const catalog: unknown = await fetchJson('/data/recommended-dictionaries.json');
    return recommendedDictionariesFromCatalog(catalog);
}

/**
 * Invalid links in an otherwise valid catalog should not hide valid dictionaries.
 * @param catalog
 */
export function recommendedDictionariesFromCatalog(catalog: unknown): RecommendedDictionary[] {
    if (!record(catalog) || !record(catalog.ja)) {throw new WebRuntimeError('catalog_invalid', 'Invalid Japanese dictionary catalog');}
    const result: RecommendedDictionary[] = [];
    for (const [category, items] of Object.entries(catalog.ja)) {
        if (!Array.isArray(items)) {continue;}
        for (const item of items) {
            if (!record(item) || !['name', 'description', 'homepage', 'downloadUrl'].every((k) => typeof item[k] === 'string')) {continue;}
            let homepage: URL;
            let download: URL;
            try {
                homepage = new URL(String(item.homepage));
                download = new URL(String(item.downloadUrl));
            } catch {
                continue;
            }
            if (homepage.protocol !== 'https:' || download.protocol !== 'https:' || homepage.username || homepage.password || download.username || download.password) {continue;}
            result.push({name: String(item.name),
                description: String(item.description),
                homepage: homepage.href,
                downloadUrl: download.href,
                category});
        }
    }
    return result;
}

/**
 * Download an explicitly chosen, same-origin static archive, bounded before allocation.
 * @param url
 * @param options
 * @param options.signal
 * @param options.onProgress
 */
export async function downloadDefaultDictionary(url: URL, options: {
    signal?: AbortSignal; onProgress?: (downloaded: number, total: number) => void;
} = {}): Promise<Blob> {
    if (url.origin !== location.origin || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) {
        throw new WebRuntimeError('source_invalid', 'The default dictionary must be served by this static Reader host');
    }
    options.signal?.throwIfAborted();
    // Fetch and ReadableStream reads may wait indefinitely if the archive host
    // stops responding. Use an idle deadline plus a hard whole-transfer bound,
    // including the initial response headers. Neither extends into import.
    const controller = new AbortController();
    const propagateAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', propagateAbort, {once: true});
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = () => {
        if (controller.signal.aborted) {return;}
        timedOut = true;
        controller.abort(new WebRuntimeError('download_timeout', 'Dictionary download stalled or exceeded its time limit'));
    };
    const refreshIdleDeadline = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(timeout, 60_000);
    };
    const totalTimer = setTimeout(timeout, 20 * 60_000);
    refreshIdleDeadline();
    try {
        const response = await fetch(url, {signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'});
        if (!response.ok || !response.body) {throw new WebRuntimeError('download_failed', `Dictionary download failed (${response.status})`);}
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let count = 0;
        let emptyChunks = 0;
        try {
            while (true) {
                options.signal?.throwIfAborted();
                const {done, value} = await reader.read();
                controller.signal.throwIfAborted();
                if (done) {break;}
                // Zero-byte chunks can loop through microtasks fast enough to
                // starve timeout callbacks. Bound them across the whole transfer,
                // even when a malicious stream interleaves occasional real bytes.
                if (value.byteLength === 0) {
                    if (++emptyChunks > 1024) {throw new WebRuntimeError('download_failed', 'Dictionary archive did not make byte progress');}
                    continue;
                }
                count += value.byteLength;
                if (count > DEFAULT_DICTIONARY.bytes) {throw new WebRuntimeError('integrity', 'Dictionary exceeds its verified archive size');}
                // Keep fragmentation memory bounded independently of byte count.
                if (chunks.length >= 65536) {throw new WebRuntimeError('download_failed', 'Dictionary archive contains too many fragments');}
                refreshIdleDeadline();
                chunks.push(value);
                options.onProgress?.(count, DEFAULT_DICTIONARY.bytes);
            }
        } finally {
            // A custom stream source may never settle its cancel promise.
            // Issue cancellation, but do not let cleanup block the error.
            void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        controller.signal.throwIfAborted();
        // The deadlines apply to network transfer only, not checksum work.
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        if (count !== DEFAULT_DICTIONARY.bytes) {throw new WebRuntimeError('integrity', 'Dictionary download is incomplete or has changed');}
        const blob = new Blob(chunks, {type: 'application/zip'});
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
        options.signal?.throwIfAborted();
        const actual = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (actual !== DEFAULT_DICTIONARY.sha256) {throw new WebRuntimeError('integrity', 'Dictionary checksum does not match the verified release');}
        return blob;
    } catch (error) {
        if (timedOut) {throw controller.signal.reason;}
        // Abort any remaining network activity on early integrity/size errors.
        if (!controller.signal.aborted) {controller.abort(error);}
        throw error;
    } finally {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        options.signal?.removeEventListener('abort', propagateAbort);
    }
}
