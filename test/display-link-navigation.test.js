/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {DisplayContentManager} from '../ext/js/display/display-content-manager.js';
import {StructuredContentGenerator} from '../ext/js/display/structured-content-generator.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

test.for([
    {input: {}, navigateInPopup: true},
    {input: {ctrlKey: true}, navigateInPopup: false},
    {input: {metaKey: true}, navigateInPopup: false},
    {input: {shiftKey: true}, navigateInPopup: false},
    {input: {altKey: true}, navigateInPopup: false},
    {input: {button: 1}, navigateInPopup: false},
])('dictionary lookup links honor native click modifiers: %j', ({input, navigateInPopup}, {window}) => {
    const setContent = vi.fn();
    const manager = new DisplayContentManager(/** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({setContent})));
    const generator = new StructuredContentGenerator(manager, window.document, /** @type {Window} */ (/** @type {unknown} */ (window)));
    const content = generator.createStructuredContent({tag: 'a', href: '?query=related', content: 'related'}, 'Dictionary');
    const link = /** @type {HTMLAnchorElement} */ (content.querySelector('.gloss-link'));
    window.document.body.appendChild(content);
    let navigationPrevented = false;
    link.addEventListener('click', (event) => {
        navigationPrevented = event.defaultPrevented;
        // Observe the display's decision without asking JSDOM to navigate.
        event.preventDefault();
    });
    link.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true, ...input}));

    expect(navigationPrevented).toBe(navigateInPopup);
    if (navigateInPopup) {
        expect(setContent).toHaveBeenCalledExactlyOnceWith({historyMode: 'new', focus: false, params: {query: 'related'}, state: null, content: null});
    } else {
        expect(setContent).not.toHaveBeenCalled();
        expect(new URL(link.href).pathname).toBe('/search.html');
    }
});
