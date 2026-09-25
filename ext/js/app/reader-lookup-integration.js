/* Copyright (C) 2026 Manabitan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Distributed WITHOUT ANY WARRANTY; see the repository license. */
import {TextSourceRange} from '../dom/text-source-range.js';
import {exactReaderEntries, readerEntriesWithSurface, ReaderLookupBridge} from './reader-lookup-bridge.js';

/** Keep extension-specific plumbing here, not in the public document protocol.
 * @param {import('./frontend.js').Frontend} frontend
 * @returns {ReaderLookupBridge}
 */
export function installReaderLookupIntegration(frontend) {
    return new ReaderLookupBridge({
        document,
        enabled: () => frontend._options?.general.enable === true && !frontend._disabledOverride,
        invalidateSearch: () => frontend._textScanner.beginExternalLookup(),
        report: (status) => { document.documentElement.dataset.readerLookupStatus = status; },
        show: async (request, anchor, isCurrent) => {
            const optionsContext = await frontend._getOptionsContext();
            if (!isCurrent()) { return; }
            const {dictionaryEntries} = await frontend._application.api.termsFind(request.term, {
                matchType: 'exact', deinflect: false, primaryReading: request.reading, skipLookupWarmWait: true,
            }, optionsContext);
            if (!isCurrent()) { return; }
            const entries = readerEntriesWithSurface(exactReaderEntries(dictionaryEntries, request), request);
            // Range supplies geometry; original surface/sentence supplies mining
            // context. Do not substitute the lemma's length for the surface span.
            const range = document.createRange(); range.selectNodeContents(anchor);
            const textSource = new TextSourceRange(range, range.startOffset, request.surface, null, null, null, null, true);
            frontend._textScanner.setCurrentTextSource(textSource);
            frontend._showContent(textSource, false, entries, 'terms',
                {text: request.sentence, offset: request.offset}, document.title,
                optionsContext, matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
            await frontend.showContentCompleted();
            if (isCurrent()) { document.documentElement.dataset.readerLookupStatus = entries.length > 0 ? 'shown' : 'no-exact-match'; }
        },
    });
}
