/*
 * Copyright (C) 2026  Yomitan Authors
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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DOMParser} from '../ext/lib/linkedom.js';
import {DictionaryImportController} from '../ext/js/pages/settings/dictionary-import-controller.js';
import {createMdictImportSources} from '../ext/js/dictionary/mdict-import-sources.js';

describe('MDict multipart paths containing line separators', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    test.each(['\n', '\r', '\u2028', '\u2029'])('pairs local multipart resources across %j', (separator) => {
        for (const stem of [`Book${separator}Part`, `Folder${separator}Part/Book`]) {
            const mdxFile = new File(['fixture'], `${stem.slice(stem.lastIndexOf('/') + 1)}.mdx`);
            Object.defineProperty(mdxFile, 'webkitRelativePath', {value: `${stem}.mdx`});
            const mddFiles = ['', '.2', '.10'].map((suffix) => {
                const file = new File(['fixture'], `Book${suffix}.mdd`);
                Object.defineProperty(file, 'webkitRelativePath', {value: `${stem}${suffix}.mdd`});
                return file;
            });
            const {sources, errors} = createMdictImportSources([mddFiles[2], mdxFile, mddFiles[1], mddFiles[0]]);
            expect(errors).toEqual([]);
            expect(sources).toEqual([{type: 'mdx', mdxFile, mddFiles}]);
        }
    });

    test.each(['\n', '\r', '\u2028', '\u2029'])('pairs URL multipart resources across encoded %j', (separator) => {
        vi.stubGlobal('DOMParser', DOMParser);
        const controller = /** @type {DictionaryImportController} */ (Object.create(DictionaryImportController.prototype));
        const stem = `Book${separator}Part`;
        const filenames = [`${stem}.mdx`, `${stem}.10.mdd`, `${stem}.mdd`, `${stem}.2.mdd`];
        const listing = controller._parseMdxListingDocument(
            'https://example.com/dictionaries/',
            filenames.map((name) => `<a href="${encodeURIComponent(name)}">file</a>`).join(''),
            `${stem}.mdx`,
        );
        expect(listing?.mddLinks.map(({fileName}) => fileName)).toEqual([`${stem}.mdd`, `${stem}.2.mdd`, `${stem}.10.mdd`]);
    });
});
