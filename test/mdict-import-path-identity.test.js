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

import assert from 'node:assert/strict';
import {describe, it} from 'vitest';
import {
    createMdictImportSources,
    normalizeMdictImportPath,
    resolveMddImportKey,
} from '../ext/js/dictionary/mdict-import-sources.js';

/**
 * @param {string} path
 * @returns {File}
 */
function file(path) {
    const result = new File([], path.slice(path.lastIndexOf('/') + 1));
    if (path.includes('/')) { Object.defineProperty(result, 'webkitRelativePath', {value: path}); }
    return result;
}

/**
 * @param {ReturnType<typeof createMdictImportSources>} result
 * @returns {ReturnType<typeof createMdictImportSources>['sources']}
 */
function dictionaries(result) {
    return result.sources.filter((source) => source.type === 'mdx');
}

describe('MDict import path identity', () => {
    for (const prefix of [' ', '\t', '\n', '\u00a0', '\ufeff']) {
        it(`does not attach resources across directory prefix ${JSON.stringify(prefix)}`, () => {
            const mdx = file(`${prefix}Dictionary/book.mdx`);
            const mdd = file('Dictionary/book.mdd');
            const result = createMdictImportSources([mdx, mdd]);
            assert.equal(result.errors.length, 1);
            assert.equal(dictionaries(result).length, 1);
            assert.deepEqual(dictionaries(result)[0].mddFiles, []);
        });
    }

    it('keeps two directory groups differing only by leading whitespace separate', () => {
        const a = file(' Dictionary/book.mdx');
        const ar = file(' Dictionary/book.mdd');
        const b = file('Dictionary/book.mdx');
        const br = file('Dictionary/book.mdd');
        const result = createMdictImportSources([ar, br, b, a]);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(dictionaries(result).map((source) => [source.mdxFile, ...source.mddFiles]), [[a, ar], [b, br]]);
    });

    it('preserves leading whitespace in basenames', () => {
        const a = file(' book.mdx');
        const ar = file(' book.mdd');
        const b = file('book.mdx');
        const br = file('book.mdd');
        const result = createMdictImportSources([a, ar, b, br]);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(dictionaries(result).map((source) => [source.mdxFile, ...source.mddFiles]), [[a, ar], [b, br]]);
    });

    it('does not trim away trailing filename characters', () => {
        assert.equal(normalizeMdictImportPath(' Dir/BOOK.MDX \t'), ' Dir/book.mdx \t');
    });

    for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
        it(`pairs numbered resources across embedded line separator ${JSON.stringify(separator)}`, () => {
            const stem = `Folder${separator}Name/book${separator}name`;
            const mdx = file(`${stem}.mdx`);
            const base = file(`${stem}.mdd`);
            const two = file(`${stem}.2.mdd`);
            const ten = file(`${stem}.10.mdd`);
            const result = createMdictImportSources([ten, mdx, two, base]);
            assert.deepEqual(result.errors, []);
            assert.deepEqual(dictionaries(result)[0].mddFiles, [base, two, ten]);
            assert.equal(resolveMddImportKey(`${stem}.2.mdd`, new Set([stem])), stem);
        });
    }

    it('preserves directory case but normalizes basename case and path separators', () => {
        assert.equal(normalizeMdictImportPath('Dir\\BOOK.MDX'), 'Dir/book.mdx');
        const a = file('Dir/BOOK.MDX');
        const b = file('dir/book.mdd');
        const result = createMdictImportSources([a, b]);
        assert.equal(result.errors.length, 1);
        assert.deepEqual(dictionaries(result)[0].mddFiles, []);
    });

    it('retains exact numeric dictionary stems and arbitrary-precision volume ordering', () => {
        const mdx = file('book.mdx');
        const other = file('book.2.mdx');
        const exact = file('book.2.mdd');
        const resources = ['book.9007199254740993.mdd', 'book.10.mdd', 'book.0.mdd', 'book.mdd', 'book.9007199254740992.mdd'].map(file);
        const result = createMdictImportSources([mdx, other, exact, ...resources]);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(dictionaries(result)[0].mddFiles.map((resource) => resource.name), [
            'book.mdd', 'book.0.mdd', 'book.10.mdd', 'book.9007199254740992.mdd', 'book.9007199254740993.mdd',
        ]);
        assert.deepEqual(dictionaries(result)[1].mddFiles, [exact]);
    });

    it('continues to reject genuine duplicate MDX paths', () => {
        const result = createMdictImportSources([file('Book.mdx'), file('BOOK.MDX'), file('book.mdd')]);
        assert.equal(result.errors.length, 1);
        assert.deepEqual(result.sources, []);
    });

    it('continues to reject genuine duplicate MDD paths', () => {
        const result = createMdictImportSources([file('book.mdx'), file('book.mdd'), file('BOOK.MDD')]);
        assert.equal(result.errors.length, 1);
        assert.deepEqual(result.sources, []);
    });

    it('preserves input order, objects, and unrelated ZIP sources', () => {
        const zip = file('other.zip');
        const mdx = file('book.mdx');
        const mdd = file('book.mdd');
        const files = [zip, mdd, mdx];
        const copy = [...files];
        const result = createMdictImportSources(files);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(files, copy);
        assert.deepEqual(result.sources, [{type: 'zip', file: zip}, {type: 'mdx', mdxFile: mdx, mddFiles: [mdd]}]);
    });
});
