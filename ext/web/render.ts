/* SPDX-License-Identifier: GPL-3.0-or-later */
import {StructuredContentGenerator} from '../js/display/structured-content-generator.js';
import type {ManabiTanWebClient, LookupResult} from './client.js';
import type {UrlContentManager} from '../../types/ext/structured-content';

/** Only URL media created by this render lifetime can be displayed by its nodes. */
class ReaderMedia implements UrlContentManager {
    /**
     *
     */
    private readonly controller = new AbortController();
    /**
     *
     */
    private readonly urls = new Map<string, Promise<string>>();
    /**
     *
     */
    private readonly created = new Set<string>();
    /**
     *
     */
    private disposed = false;
    /**
     *
     * @param client
     * @param lookup
     */
    constructor(private readonly client: ManabiTanWebClient, private readonly lookup: (text: string) => void) {}
    /**
     *
     */
    dispose() {
        this.disposed = true;
        this.controller.abort();
        for (const url of this.created) {URL.revokeObjectURL(url);}
        this.created.clear();
    }

    /**
     *
     * @param path
     * @param dictionary
     */
    private url(path: string, dictionary: string) {
        const key = JSON.stringify([path, dictionary]);
        let pending = this.urls.get(key);
        if (!pending) {
            pending = this.client.media(dictionary, path, {signal: this.controller.signal}).then((data) => {
                if (this.disposed || !data || !/^image\/(?:png|jpeg|webp|gif|avif|svg\+xml)$/.test(data.mediaType)) {throw new Error('Dictionary image unavailable');}
                const blob = new Blob([data.content], {type: data.mediaType});
                if (blob.size > 32 * 1024 * 1024) {throw new Error('Dictionary image exceeds display size limit');}
                const url = URL.createObjectURL(blob);
                this.created.add(url);
                return url;
            });
            this.urls.set(key, pending);
        }
        return pending;
    }

    /**
     *
     * @param path
     * @param dictionary
     * @param loaded
     * @param failed
     */
    loadMediaUrl(path: string, dictionary: string, loaded: (url: string) => void, failed: () => void) {
        void this.url(path, dictionary).then((url) => {
            if (!this.disposed) {loaded(url);}
        }, () => {
            if (!this.disposed) {failed();}
        });
    }

    /**
     *
     * @param element
     * @param href
     * @param internal
     */
    prepareLink(element: HTMLAnchorElement, href: string, internal: boolean) {
        if (internal) {
            const text = new URL(href).searchParams.get('query');
            element.href = '#';
            element.addEventListener('click', (event) => {
                event.preventDefault();
                if (text && !this.disposed) {this.lookup(text.slice(0, 256));}
            }, {signal: this.controller.signal});
            return;
        }
        try {
            const url = new URL(href);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {throw new Error('Unsafe link');}
            element.href = url.href;
            element.target = '_blank';
            element.rel = 'noopener noreferrer';
        } catch {
            element.removeAttribute('href');
        }
    }

    /**
     *
     * @param _path
     * @param _dictionary
     * @param _window
     */
    async openMediaInTab(_path: string, _dictionary: string, _window: Window) {
        // Media is shown in the local popup. Do not open arbitrary dictionary
        // bytes as a top-level same-origin document (especially SVG documents).
    }
}
/**
 *
 * @param value
 * @param budget
 * @param budget.nodes
 * @param budget.characters
 */
function bounded(value: unknown, budget: {nodes: number, characters: number}): boolean {
    const work: Array<[unknown, number]> = [[value, 0]];
    let nodes = 0;
    while (work.length > 0) {
        const [item, depth] = work.pop()!;
        if (++nodes > 4000 || ++budget.nodes > 12000 || depth > 32) {return false;}
        if (typeof item === 'string') {
            budget.characters += item.length;
            if (item.length > 100000 || budget.characters > 250000) {return false;}
        }
        if (item && typeof item === 'object') {
            for (const key in item) {
                if (!Object.hasOwn(item, key)) {continue;}
                if (work.length + nodes >= 4000) {return false;}
                work.push([(item as Record<string, unknown>)[key], depth + 1]);
            }
        }
    }
    return true;
}
/**
 *
 * @param container
 */
function constrainStyles(container: HTMLElement) {
    // The shared renderer creates DOM safely, but dictionary presentation values
    // may include CSS resource functions. A webpage must not fetch them.
    for (const node of container.querySelectorAll<HTMLElement>('[style]')) {
        for (const property of node.style) {
            const value = node.style.getPropertyValue(property);
            if (property === 'background-image' || property === 'list-style-image' || /url\s*\(|image-set\s*\(|var\s*\(|[\\<>@]/i.test(value)) {
                node.style.removeProperty(property);
            }
        }
    }
}

/**
 * Real ManabiTan structured glossary renderer; no raw HTML or copied importer.
 * @param container
 * @param result
 * @param client
 * @param lookup
 */
export function renderDictionaryResults(container: HTMLElement, result: LookupResult, client: ManabiTanWebClient, lookup: (text: string) => void): () => void {
    const manager = new ReaderMedia(client, lookup);
    const generator = new StructuredContentGenerator(manager, container.ownerDocument, window);
    const fragment = document.createDocumentFragment();
    const budget = {nodes: 0, characters: 0};
    let truncated = result.dictionaryEntries.length > 30;
    for (const entry of result.dictionaryEntries.slice(0, 30)) {
        const article = document.createElement('article');
        article.className = 'dictionary-entry';
        const heading = document.createElement('h3');
        heading.className = 'headword';
        for (const [index, headword] of entry.headwords.entries()) {
            if (index) {heading.append(' / ');}
            const ruby = document.createElement('ruby');
            ruby.append(headword.term);
            if (headword.reading !== headword.term) {
                const rt = document.createElement('rt');
                rt.textContent = headword.reading;
                ruby.append(rt);
            }
            heading.append(ruby);
        }
        article.append(heading);
        if (entry.frequencies.length > 0) {
            const frequencies = document.createElement('p');
            frequencies.className = 'frequency';
            frequencies.textContent = entry.frequencies.slice(0, 30).map((f) => `${f.dictionary}: ${f.displayValue ?? f.frequency}`).join(' · ');
            article.append(frequencies);
        }
        for (const definition of entry.definitions.slice(0, 30)) {
            const label = document.createElement('p');
            label.className = 'dictionary-name';
            label.textContent = definition.dictionary;
            article.append(label);
            const list = document.createElement('ol');
            for (const value of definition.entries.slice(0, 100)) {
                if (budget.nodes > 12000 || budget.characters > 250000) {
                    truncated = true;
                    break;
                }
                const item = document.createElement('li');
                if (!bounded(value, budget)) {
                    truncated = true;
                    item.textContent = 'Definition exceeds the display complexity limit.';
                } else if (typeof value === 'string') {
                    item.textContent = value;
                } else {
                    switch (value.type) {
                        case 'structured-content': {
                            item.append(generator.createStructuredContent(value.content, definition.dictionary));
                            break;
                        }
                        case 'image': {
                            item.append(generator.createDefinitionImage(value, definition.dictionary));
                            break;
                        }
                        case 'text': {
                            item.textContent = value.text;
                        // No default
                        }
                            break;
                    }
                }
                constrainStyles(item);
                list.append(item);
            }
            article.append(list);
        }
        fragment.append(article);
    }
    if (result.dictionaryEntries.length === 0) {
        const text = document.createElement('p');
        text.textContent = 'No matching dictionary entries.';
        fragment.append(text);
    }
    if (truncated) {
        const note = document.createElement('p');
        note.textContent = 'Some definitions were omitted because this result exceeds the display complexity limit.';
        fragment.append(note);
    }
    container.replaceChildren(fragment);
    return () => manager.dispose();
}
