/* SPDX-License-Identifier: GPL-3.0-or-later */
import {JSDOM} from 'jsdom';
import {expect, test} from 'vitest';
import {constrainStyles} from '../ext/web/render.js';

test('web glossary sanitizer removes consecutive URL-bearing styles', () => {
    const dom = new JSDOM('<div id="glossary"><span style="background-image: url(https://bad.test/a); list-style-image: url(https://bad.test/b); color: red">text</span></div>');
    try {
        const root = dom.window.document.getElementById('glossary');
        if (!root) { throw new Error('Missing glossary fixture'); }
        constrainStyles(root);
        const node = root.querySelector('span');
        if (!(node instanceof dom.window.HTMLElement)) { throw new Error('Missing style fixture'); }
        expect(node.style.getPropertyValue('background-image')).toBe('');
        expect(node.style.getPropertyValue('list-style-image')).toBe('');
        expect(node.style.getPropertyValue('color')).toBe('red');
    } finally {
        dom.window.close();
    }
});
