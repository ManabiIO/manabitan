import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendMdictConversionWarnings, getMdictConversionWarnings} from '../../ext/js/pages/settings/mdict-import-feedback.js';

/**
 * @param {string} name
 * @param {unknown} details
 * @returns {{phase: string, elapsedMs: number, details?: Record<string, unknown>}}
 */
function phase(name, details) {
    const result = {phase: `prepare-mdx:${name}`, elapsedMs: 0};
    if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
        return {...result, details: /** @type {Record<string, unknown>} */ (details)};
    }
    return result;
}

for (const value of [0, -1, Number.NaN, Infinity, 1.5, '2', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    test(`ignores invalid diagnostic count ${String(value)}`, () => {
        assert.deepEqual(
            getMdictConversionWarnings([phase('convert-entries', {skippedEntryErrorCount: value})]),
            [],
        );
    });
}

test('no warnings for successful conversion or missing optional diagnostic metadata', () => {
    assert.deepEqual(getMdictConversionWarnings([]), []);
    assert.deepEqual(getMdictConversionWarnings([{phase: 'x'}, phase('x', null)]), []);
});

for (const value of [1, 2]) {
    test(`definition and alias warning count grammar: ${value}`, () => {
        const warnings = getMdictConversionWarnings([
            phase('convert-entries', {skippedEntryErrorCount: value}),
            phase('encode-banks', {unresolvedRedirectCount: value}),
        ]);
        assert.equal(warnings.length, 2);
        assert.match(warnings[0], /incomplete/u);
        assert.match(warnings[1], /search results/u);
        assert.match(warnings[0], value === 1 ? /1 definition record was/u : /2 definition records were/u);
        assert.match(warnings[1], value === 1 ? /1 redirect alias could/u : /2 redirect aliases could/u);
    });
}

test('missing resources and failed reads remain separate overlapping counts', () => {
    const warnings = getMdictConversionWarnings([
        phase('materialize-assets', {missingReferencedAssetCount: 3, assetLookupErrorCount: 2}),
    ]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /^3 referenced/u);
    assert.match(warnings[1], /^2 resource reads/u);
    assert.match(warnings[0], /does not count missing definitions/u);
});

test('resource singular grammar', () => {
    const warnings = getMdictConversionWarnings([
        phase('materialize-assets', {missingReferencedAssetCount: 1, assetLookupErrorCount: 1}),
    ]);
    assert.match(warnings[0], /1 referenced resource was/u);
    assert.match(warnings[1], /1 resource read failed/u);
});

test('only the matching phase contributes counts, avoiding double accounting', () => {
    assert.deepEqual(
        getMdictConversionWarnings([phase('other', {skippedEntryErrorCount: 5})]),
        [],
    );
    const warnings = getMdictConversionWarnings([
        phase('convert-entries', {skippedEntryErrorCount: 2}),
        phase('convert-entries', {skippedEntryErrorCount: 3}),
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^3 /u);
});

class TestElement {
    /**
     * @param {string} tag
     * @param {TestDocument} document
     */
    constructor(tag, document) {
        this.tagName = tag;
        this.ownerDocument = document;
        /** @type {TestElement[]} */
        this.children = [];
        this.textContent = '';
        this.hidden = true;
    }

    /**
     * @param {TestElement} child
     * @returns {void}
     */
    appendChild(child) {
        this.children.push(child);
    }

    /**
     * @returns {string}
     * @throws {Error} Always.
     */
    get innerHTML() {
        throw new Error('HTML rendering is not allowed');
    }

    /**
     * @param {string} _value
     * @throws {Error} Always.
     */
    set innerHTML(_value) {
        throw new Error('HTML rendering is not allowed');
    }
}

class TestDocument {
    /**
     * @param {string} tag
     * @returns {TestElement}
     */
    createElement(tag) {
        return new TestElement(tag, this);
    }
}

const document = new TestDocument();

test('host without optional warning region remains usable', () => {
    assert.doesNotThrow(() => appendMdictConversionWarnings(null, 'Book', []));
});

test('clean conversion does not unhide an empty warning region', () => {
    const root = new TestElement('div', document);
    appendMdictConversionWarnings(
        /** @type {HTMLElement} */ (/** @type {unknown} */ (root)),
        'Book',
        [],
    );
    assert.equal(root.hidden, true);
    assert.deepEqual(root.children, []);
});

test('warning rendering uses literal filename text and never inserts HTML', () => {
    const root = new TestElement('div', document);
    const title = 'Book <special> & name.mdx';
    appendMdictConversionWarnings(
        /** @type {HTMLElement} */ (/** @type {unknown} */ (root)),
        title,
        [phase('convert-entries', {skippedEntryErrorCount: 1})],
    );
    assert.equal(root.hidden, false);
    assert.equal(root.children.length, 1);
    assert.equal(
        root.children[0].children[0].textContent,
        `MDict conversion notes for ${title}. Installation status is shown separately.`,
    );
    assert.equal(root.children[0].children[1].tagName, 'ul');
    assert.equal(root.children[0].children[1].children[0].tagName, 'li');
});

test('multiple dictionary notes append without erasing previous warnings', () => {
    const root = new TestElement('div', document);
    appendMdictConversionWarnings(
        /** @type {HTMLElement} */ (/** @type {unknown} */ (root)),
        'A',
        [phase('convert-entries', {skippedEntryErrorCount: 1})],
    );
    appendMdictConversionWarnings(
        /** @type {HTMLElement} */ (/** @type {unknown} */ (root)),
        'B',
        [phase('encode-banks', {unresolvedRedirectCount: 1})],
    );
    assert.equal(root.children.length, 2);
});
