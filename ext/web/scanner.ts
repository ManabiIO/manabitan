/* SPDX-License-Identifier: GPL-3.0-or-later */
import {TextScanner} from '../js/language/text-scanner.js';
import {TextSourceGenerator} from '../js/dom/text-source-generator.js';
import type {ManabiTanWebClient} from './client.js';
import type {InputOptions, EventArgument, ScannerApi} from '../../types/ext/text-scanner';

export interface ScannerCallbacks {
    onResult: (result: EventArgument<'searchSuccess'>) => void;
    onError: (error: Error) => void;
    onEmpty?: () => void;
    includeSelector?: string;
}

/**
 * Uses the real ManabiTan scanner with a narrow, environment-owned API port.
 * @param client
 * @param container
 * @param callbacks
 */
export function createReaderScanner(client: ManabiTanWebClient, container: HTMLElement, callbacks: ScannerCallbacks) {
    const requests = new Set<AbortController>();
    let generation = 0,
        active = false;
    const api: ScannerApi = {
        async termsFind(text) {
            const controller = new AbortController();
            requests.add(controller);
            try {
                return await client.lookup(text, {signal: controller.signal});
            } finally {
                requests.delete(controller);
            }
        },
        // Reader term lookups do not silently turn into a different database engine.
        async kanjiFind() { return []; },
        async isTextLookupWorthy(text) { return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text); },
    };
    const scanner = new TextScanner({api,
        node: container,
        getSearchContext: () => ({
            optionsContext: {depth: 0, url: location.href, modifiers: [], modifierKeys: [], pointerType: 'mouse'},
            detail: {documentTitle: document.title},
        }),
        textSourceGenerator: new TextSourceGenerator(),
        browser: null,
        searchTerms: true,
        searchKanji: false,
        searchOnClick: false});
    scanner.language = 'ja';
    scanner.includeSelector = callbacks.includeSelector ?? null;
    scanner.excludeSelector = 'rt, rp, button, input, textarea, select, [data-manabitan-web-popup]';
    const options: InputOptions = {
        searchTerms: true,
        searchKanji: false,
        scanOnTouchMove: false,
        scanOnTouchPress: false,
        scanOnTouchRelease: false,
        scanOnTouchTap: true,
        scanOnPenMove: false,
        scanOnPenHover: true,
        scanOnPenReleaseHover: false,
        scanOnPenPress: false,
        scanOnPenRelease: false,
        preventTouchScrolling: false,
        preventPenScrolling: false,
        minimumTouchTime: 0,
    };
    scanner.setOptions({inputs: [
        {include: 'shift', exclude: '', types: {mouse: true, touch: false, pen: false}, options},
        {include: '', exclude: '', types: {mouse: false, touch: true, pen: true}, options},
    ],
    selectText: false,
    normalizeCssZoom: true,
    delay: 50,
    scanLength: 32,
    layoutAwareScan: true,
    scanResolution: 'letter'});
    scanner.on('searchSuccess', (result) => {
        if (active) {callbacks.onResult(result);}
    });
    scanner.on('searchError', ({error}) => {
        if (active && error.name !== 'AbortError') {callbacks.onError(error);}
    });
    scanner.on('searchEmpty', () => {
        if (active) {callbacks.onEmpty?.();}
    });
    scanner.prepare();
    const start = () => {
        generation += 1;
        active = true;
        scanner.setEnabled(true);
    };
    const stop = () => {
        generation += 1;
        active = false;
        scanner.setEnabled(false);
        scanner.clearSelection();
        scanner.clearMousePosition();
        for (const controller of requests) {controller.abort();}
        requests.clear();
    };
    return {
        start,
        stop,
        // Closing a popup invalidates pending results and the retained text
        // source, so a late lookup cannot reopen it and the same word can be
        // scanned again. Dismissal never enables a previously stopped scanner.
        dismiss() {
            const resume = active;
            stop();
            if (resume) {start();}
        },
        get generation() { return generation; },
    };
}
