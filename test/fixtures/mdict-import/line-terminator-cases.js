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

/**
 * @param {string} path
 * @returns {File}
 */
function file(path) {
    const result = new File([], path.slice(path.lastIndexOf('/') + 1));
    Object.defineProperty(result, 'webkitRelativePath', {value: path.includes('/') ? path : ''});
    return result;
}

/**
 * Shared by the Vitest wrapper and the standalone Node/browser qualification.
 * All selections use native File objects. No dictionary bytes are read here.
 * @param {typeof import('../../../ext/js/dictionary/mdict-import-sources.js')} api
 * @param {{equal: (actual: unknown, expected: unknown) => void, deepEqual: (actual: unknown, expected: unknown) => void}} assert
 * @returns {Array<{name: string, run: () => void}>}
 */
export function createLineTerminatorCases(api, assert) {
    /** @type {Array<{name: string, run: () => void}>} */
    const cases = [];
    for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
        const label = `U+${separator.charCodeAt(0).toString(16).padStart(4, '0')}`;
        for (const directory of [false, true]) {
            cases.push({
                name: `matches numbered MDD with ${label} in ${directory ? 'directory' : 'basename'}`,
                run: () => {
                    const stem = directory ? `A${separator}B/book` : `book${separator}part`;
                    const mdx = file(`${stem}.mdx`);
                    const resource = file(`${stem}.123.mdd`);
                    const selected = [resource, mdx];
                    const result = api.createMdictImportSources(selected);
                    assert.deepEqual(result.errors, []);
                    assert.equal(result.sources.length, 1);
                    const source = result.sources[0];
                    assert.equal(source.type, 'mdx');
                    if (source.type !== 'mdx') { throw new Error('Expected an MDX source'); }
                    assert.equal(source.mdxFile, mdx);
                    assert.equal(source.mddFiles.length, 1);
                    assert.equal(source.mddFiles[0], resource);
                    assert.equal(api.resolveMddImportKey(`${stem}.123.MDD`, new Set([stem])), stem);
                    assert.deepEqual(selected, [resource, mdx]);
                },
            });
        }
    }
    cases.push({
        name: 'keeps numeric multipart ordering and exact File identities',
        run: () => {
            const mdx = file('Dir/Book.MDX');
            const resources = ['', '.0', '.2', '.10', '.9007199254740992', '.9007199254740993'].map((number) => file(`Dir/book${number}.MDD`));
            const reversedResources = [...resources].reverse();
            const result = api.createMdictImportSources([...reversedResources, mdx]);
            assert.deepEqual(result.errors, []);
            assert.equal(result.sources.length, 1);
            const source = result.sources[0];
            if (source.type !== 'mdx') { throw new Error('Expected an MDX source'); }
            assert.equal(source.mdxFile, mdx);
            assert.equal(source.mddFiles.length, resources.length);
            for (let i = 0; i < resources.length; ++i) { assert.equal(source.mddFiles[i], resources[i]); }
        },
    }, {
        name: 'retains exact numeric dictionary-stem precedence',
        run: () => {
            const main = file('book.mdx');
            const numbered = file('book.2.mdx');
            const resource = file('book.2.mdd');
            const result = api.createMdictImportSources([main, numbered, resource]);
            assert.deepEqual(result.errors, []);
            assert.equal(result.sources.length, 2);
            const source = result.sources[1];
            if (source.type !== 'mdx') { throw new Error('Expected an MDX source'); }
            assert.equal(source.mdxFile, numbered);
            assert.equal(source.mddFiles[0], resource);
        },
    }, {
        name: 'does not donate a resource across case-distinct directories',
        run: () => {
            const mdx = file('Dir/book.mdx');
            const resource = file('dir/book.2.mdd');
            const result = api.createMdictImportSources([mdx, resource]);
            assert.equal(result.errors.length, 1);
            assert.equal(result.sources.length, 1);
            const source = result.sources[0];
            if (source.type !== 'mdx') { throw new Error('Expected an MDX source'); }
            assert.equal(source.mddFiles.length, 0);
        },
    }, {
        name: 'still rejects a numbered MDD whose MDX is missing',
        run: () => {
            const result = api.createMdictImportSources([file('book\npart.123.mdd')]);
            assert.equal(result.errors.length, 1);
            assert.equal(result.sources.length, 0);
        },
    });
    return cases;
}
