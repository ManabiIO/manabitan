/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* eslint no-underscore-dangle: ["error", {"allow": ["_options", "_disabledOverride", "_textScanner", "_getOptionsContext", "_application", "_showContent"]}] */
import {TextSourceRange} from '../dom/text-source-range.js';
import {exactReaderEntries, readerEntriesWithSurface, ReaderLookupBridge} from './reader-lookup-bridge.js';

/**
 * Keep extension-specific plumbing here, not in the public document protocol.
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
                matchType: 'exact', deinflect: false, primaryReading: request.reading,
            }, optionsContext);
            if (!isCurrent()) { return; }
            const entries = readerEntriesWithSurface(exactReaderEntries(dictionaryEntries, request), request);
            // Range supplies geometry; original surface/sentence supplies mining
            // context. Do not substitute the lemma's length for the surface span.
            const range = document.createRange(); range.selectNodeContents(anchor);
            const textSource = new TextSourceRange(range, range.startOffset, request.surface, null, null, null, null, true);
            frontend._textScanner.setCurrentTextSource(textSource);
            frontend._showContent(
                textSource,
                false,
                entries,
                'terms',
                {text: request.sentence, offset: request.offset},
                document.title,
                optionsContext,
                matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            );
            await frontend.showContentCompleted();
            if (isCurrent()) { document.documentElement.dataset.readerLookupStatus = entries.length > 0 ? 'shown' : 'no-exact-match'; }
        },
    });
}
