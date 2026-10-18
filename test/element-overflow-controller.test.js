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

import {describe, expect, vi} from 'vitest';
import {ElementOverflowController} from '../ext/js/display/element-overflow-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @param {Document} document
 * @param {import('settings').DictionaryDefinitionsCollapsible} [mode]
 * @returns {{controller: ElementOverflowController, entry: HTMLDivElement, elements: Element[], reads: {index: number, name: string, testing: boolean[]}[], display: {scrollUpToElementTop: ReturnType<typeof vi.fn>}}}
 */
function fixture(document, mode = 'collapsed') {
    const display = {scrollUpToElementTop: vi.fn()};
    const controller = new ElementOverflowController(/** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ (display)));
    controller.setOptions(/** @type {import('settings').ProfileOptions} */ ({dictionaries: [{name: 'Dictionary', definitionsCollapsible: mode}]}));
    const entry = document.createElement('div');
    // eslint-disable-next-line no-unsanitized/property -- fixed test markup only
    entry.innerHTML = [0, 1, 2].map(() => '<div data-dictionary="Dictionary"><div class="definition-item-inner"><button class="expansion-button"></button></div></div>').join('');
    document.body.append(entry);
    const elements = [...entry.querySelectorAll('.definition-item-inner')];
    /** @type {{index: number, name: string, testing: boolean[]}[]} */
    const reads = [];
    for (const [index, element] of elements.entries()) {
        for (const [name, value] of Object.entries({scrollHeight: index === 0 ? 80 : 20, clientHeight: 40, scrollWidth: index === 2 ? 120 : 80, clientWidth: 100})) {
            Object.defineProperty(element, name, {get() {
                reads.push({index, name, testing: elements.map((e) => e.classList.contains('collapse-test'))});
                return value;
            }});
        }
    }
    return {controller, entry, elements, reads, display};
}

describe('ElementOverflowController batched measurement', () => {
    for (const mode of /** @type {const} */ (['collapsed', 'expanded'])) {
        test(`preserves ${mode} state and measures with no intervening writes`, ({window}) => {
            const {controller, entry, elements, reads} = fixture(window.document, mode);
            controller.addElements(entry);
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.every((read) => read.testing.every(Boolean))).toBe(true);
            expect(elements.map((e) => e.classList.contains('collapsible'))).toEqual([true, false, true]);
            expect(elements.every((e) => e.classList.contains('collapsed') === (mode === 'collapsed'))).toBe(true);
            expect(elements.some((e) => e.classList.contains('collapse-test'))).toBe(false);
            controller.clearElements();
        });
    }

    for (const mode of /** @type {const} */ (['force-collapsed', 'force-expanded', 'not-collapsible'])) {
        test(`does not add measurements to ${mode}`, ({window}) => {
            const {controller, entry, elements, reads} = fixture(window.document, mode);
            controller.addElements(entry);
            expect(reads).toEqual([]);
            expect(elements.every((e) => e.classList.contains('collapsible-forced') === (mode !== 'not-collapsible'))).toBe(true);
            expect(elements.every((e) => e.classList.contains('collapsed') === (mode === 'force-collapsed'))).toBe(true);
            controller.clearElements();
        });
    }

    test('measures kanji glyph data with the same overflow and toggle rules', ({window}) => {
        const {controller, entry, elements, reads} = fixture(window.document);
        for (const element of elements) { element.className = 'kanji-glyph-data'; }
        controller.addElements(entry);
        expect(reads.every((read) => read.testing.every(Boolean))).toBe(true);
        expect(elements.map((element) => element.classList.contains('collapsible'))).toEqual([true, false, true]);
        elements[0].querySelector('button')?.click();
        expect(elements[0].classList.contains('collapsed')).toBe(false);
        controller.clearElements();
    });

    test('resize batches reads and clear cancels pending work and click listeners', ({window}) => {
        const {controller, entry, elements, reads, display} = fixture(window.document);
        controller.addElements(entry);
        reads.length = 0;
        controller._update();
        expect(reads.every((read) => read.testing.every(Boolean))).toBe(true);
        elements[0].querySelector('button')?.click();
        expect(elements[0].classList.contains('collapsed')).toBe(false);
        elements[0].querySelector('button')?.click();
        expect(display.scrollUpToElementTop).toHaveBeenCalledTimes(1);
        vi.spyOn(controller, '_requestIdleCallback').mockReturnValue(123);
        const cancel = vi.spyOn(controller, '_cancelIdleCallback').mockImplementation(() => {});
        controller._onWindowResize();
        controller.clearElements();
        expect(cancel).toHaveBeenCalledWith(123);
        expect(controller._checkTimer).toBeNull();
        elements[0].querySelector('button')?.click();
        expect(elements[0].classList.contains('collapsed')).toBe(true);
        expect(controller._elements).toEqual([]);
    });
});
