import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveMddImportKey, compareMddImportPaths} from '../../ext/js/dictionary/mdict-import-sources.js';

import {DictionaryImportController} from '../../ext/js/pages/settings/dictionary-import-controller.js';
const controller = Object.create(DictionaryImportController.prototype);
/**
 * @param {readonly File[]} files
 * @returns {any}
 */
const create = (files) => controller._createImportSourcesFromFiles(/** @type {File[]} */ (files));
/**
 * @param {string} path
 * @returns {File}
 */
function f(path) {
    const filename = path.replaceAll('\\', '/').split('/').at(-1) ?? '';
    const file = new File(['x'], filename);
    Object.defineProperty(file, 'webkitRelativePath', {value: path.includes('/') || path.includes('\\') ? path : ''});
    return Object.freeze(file);
}
/**
 * @param {...string} paths
 * @returns {any}
 */
function plan(...paths) { return create(paths.map(f)); }
/**
 * @param {any} result
 * @param {number} [n]
 */
function media(result, n = 0) { return result.sources[n]?.mddFiles?.map(/** @param {any} x */ (x) => x.name); }

for (const stem of ['Dictionary.2024', 'Book.1', '和英辞典.2', 'v1.2.3', 'A.0000000000001']) {
    for (const resourcesFirst of [false, true]) test(`numeric MDX stem ${stem}, resourcesFirst=${resourcesFirst}`, () => {
        const paths = [`${stem}.mdx`, `${stem}.mdd`, `${stem}.1.mdd`];
        const result = plan(...(resourcesFirst ? paths.reverse() : paths));
        assert.deepEqual(result.errors, []); assert.deepEqual(media(result), [`${stem}.mdd`, `${stem}.1.mdd`]);
    });
}
test('empty selection', () => assert.deepEqual(plan(), {sources: [], errors: []}));
test('MDX alone is valid; absent MDD is not an error', () => { const result = plan('Book.mdx'); assert.deepEqual(result.errors, []); assert.deepEqual(media(result), []); });
test('case-insensitive extensions and stem matching', () => { const result = plan('BOOK.MDX', 'book.MDD', 'Book.2.MdD'); assert.deepEqual(result.errors, []); assert.deepEqual(media(result), ['book.MDD', 'Book.2.MdD']); });
test('numeric volume order and unnumbered before zero', () => {
    const result = plan('Book.10.mdd', 'Book.2.mdd', 'Book.0.mdd', 'Book.mdx', 'Book.mdd', 'Book.1.mdd');
    assert.deepEqual(media(result), ['Book.mdd', 'Book.0.mdd', 'Book.1.mdd', 'Book.2.mdd', 'Book.10.mdd']);
});
test('large volume numbers are ordered without Number precision loss', () => {
    const result = plan('Book.9007199254740993.mdd', 'Book.mdx', 'Book.9007199254740992.mdd');
    assert.deepEqual(media(result), ['Book.9007199254740992.mdd', 'Book.9007199254740993.mdd']);
});
test('same-named dictionaries in different directories do not share media', () => {
    const result = plan('a/Book.mdx', 'b/Book.mdx', 'b/Book.mdd', 'a/Book.mdd');
    assert.deepEqual(result.errors, []); assert.equal(result.sources[0].mddFiles[0].webkitRelativePath, 'a/Book.mdd'); assert.equal(result.sources[1].mddFiles[0].webkitRelativePath, 'b/Book.mdd');
});
test('Windows-style relative path separators normalize', () => {
    const result = plan('a\\Book.mdx', 'a/Book.1.mdd');
    assert.deepEqual(result.errors, []); assert.deepEqual(media(result), ['Book.1.mdd']);
});
test('MDX in another directory does not rescue an orphan resource', () => {
    const result = plan('a/Book.mdx', 'b/Book.mdd'); assert.equal(result.errors.length, 1); assert.deepEqual(media(result), []);
});
test('orphan MDD has a concrete recovery instruction', () => {
    const result = plan('Book.1.mdd'); assert.equal(result.sources.length, 0); assert.equal(result.errors.length, 1); assert.match(result.errors[0].message, /Select the matching \.mdx/);
});
test('duplicate MDX groups are excluded rather than choosing first file', () => {
    const result = plan('Book.mdx', 'BOOK.MDX', 'Book.mdd', 'Other.mdx');
    assert.equal(result.errors.length, 1); assert.equal(result.sources.length, 1); assert.equal(result.sources[0].mdxFile.name, 'Other.mdx');
});
test('duplicate MDD paths do not silently choose arbitrary resource bytes', () => {
    const result = plan('Book.mdx', 'Book.mdd', 'BOOK.MDD', 'Other.zip');
    assert.equal(result.errors.length, 1); assert.equal(result.sources.length, 1); assert.equal(result.sources[0].type, 'zip');
});
test('exact numeric stem wins over interpretation as a split volume', () => {
    const result = plan('Book.mdx', 'Book.1.mdx', 'Book.1.mdd', 'Book.1.2.mdd', 'Book.mdd');
    assert.deepEqual(result.errors, []); assert.deepEqual(media(result, 0), ['Book.mdd']); assert.deepEqual(media(result, 1), ['Book.1.mdd', 'Book.1.2.mdd']);
});
test('invalid exact-stem group cannot donate its MDD to another dictionary', () => {
    const result = plan('Book.mdx', 'Book.1.mdx', 'Book.1.MDX', 'Book.1.mdd');
    assert.equal(result.sources.length, 1); assert.deepEqual(media(result), []);
});
test('mixed ZIP and MDX sources preserve earliest-file selection order', () => {
    const result = plan('B.2.mdd', 'A.zip', 'C.mdx', 'B.mdx');
    assert.deepEqual(result.sources.map(/** @param {any} x */ (x) => x.type === 'zip' ? x.file.name : x.mdxFile.name), ['B.mdx', 'A.zip', 'C.mdx']);
});
test('unsupported file error does not discard an unrelated valid dictionary', () => { const result = plan('notes.txt', 'Book.mdx'); assert.equal(result.errors.length, 1); assert.equal(result.sources.length, 1); });
test('selection and file objects are not mutated', () => {
    const files = Object.freeze([f('Book.2.mdd'), f('Book.mdx'), f('Book.mdd')]); const result = create(files);
    assert.equal(result.sources[0].mdxFile, files[1]); assert.equal(files[0].name, 'Book.2.mdd');
});
test('pair resolver is shared with URL directory discovery', () => {
    const keys = new Set(['book.2024']);
    assert.equal(resolveMddImportKey('Book.2024.mdd', keys), 'book.2024');
    assert.equal(resolveMddImportKey('Book.2024.2.mdd', keys), 'book.2024');
    assert.equal(resolveMddImportKey('Book.mdd', keys), null);
    assert.equal(resolveMddImportKey('Book.2024.zip', keys), null);
});
test('volume ties use deterministic lexical order and identical names compare equal', () => {
    assert.equal(compareMddImportPaths('book.mdd', 'book.mdd', 'book'), 0);
    assert.ok(compareMddImportPaths('book.01.mdd', 'book.1.mdd', 'book') < 0);
});
test('all permutations of a mixed multipart selection produce identical media sets', () => {
    /**
     * @param {string[]} values
     * @returns {Generator<string[]>}
     */
    function* permutations(values) { if (values.length === 0) { yield []; return; }; for (let i = 0; i < values.length; i++) for (const rest of permutations(values.filter((_, j) => i !== j))) yield [values[i], ...rest]; }
    for (const paths of permutations(['Book.2024.mdx', 'Book.2024.mdd', 'Book.2024.2.mdd', 'Other.zip'])) {
        const result = plan(...paths); assert.equal(result.errors.length, 0);
        assert.deepEqual(result.sources.find(/** @param {any} x */ (x) => x.type === 'mdx').mddFiles.map(/** @param {any} x */ (x) => x.name), ['Book.2024.mdd', 'Book.2024.2.mdd']);
    }
});

test('directory case is preserved rather than silently mixing different folders', () => {
    const result = plan('Books/Book.mdx', 'books/Book.mdx', 'Books/Book.mdd', 'books/Book.mdd');
    assert.deepEqual(result.errors, []);
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].mddFiles[0].webkitRelativePath, 'Books/Book.mdd');
    assert.equal(result.sources[1].mddFiles[0].webkitRelativePath, 'books/Book.mdd');
});
