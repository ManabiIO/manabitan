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
    if (!record(catalog) || !record(catalog.ja)) {throw new WebRuntimeError('catalog_invalid', 'Invalid Japanese dictionary catalog');}
    const result: RecommendedDictionary[] = [];
    for (const [category, items] of Object.entries(catalog.ja)) {
        if (!Array.isArray(items)) {continue;}
        for (const item of items) {
            if (!record(item) || !['name', 'description', 'homepage', 'downloadUrl'].every((k) => typeof item[k] === 'string')) {continue;}
            const homepage = new URL(String(item.homepage));
            const download = new URL(String(item.downloadUrl));
            if (homepage.protocol !== 'https:' || download.protocol !== 'https:' || homepage.username || download.username) {continue;}
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
    const response = await fetch(url, {signal: options.signal, credentials: 'omit', cache: 'no-store', redirect: 'error'});
    if (!response.ok || !response.body) {throw new WebRuntimeError('download_failed', `Dictionary download failed (${response.status})`);}
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let count = 0;
    try {
        while (true) {
            options.signal?.throwIfAborted();
            const {done, value} = await reader.read();
            if (done) {break;}
            count += value.byteLength;
            if (count > DEFAULT_DICTIONARY.bytes) {throw new WebRuntimeError('integrity', 'Dictionary exceeds its verified archive size');}
            chunks.push(value); options.onProgress?.(count, DEFAULT_DICTIONARY.bytes);
        }
    } finally {
        await reader.cancel().catch(() => {}); reader.releaseLock();
    }
    if (count !== DEFAULT_DICTIONARY.bytes) {throw new WebRuntimeError('integrity', 'Dictionary download is incomplete or has changed');}
    const blob = new Blob(chunks, {type: 'application/zip'});
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    options.signal?.throwIfAborted();
    const actual = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== DEFAULT_DICTIONARY.sha256) {throw new WebRuntimeError('integrity', 'Dictionary checksum does not match the verified release');}
    return blob;
}
