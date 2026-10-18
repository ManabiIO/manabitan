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

import {createMdxImportData} from '../../ext/js/dictionary/mdx/mdx-converter.js';
import {makeMdictFixture} from '../util/mdict-binary-fixture.js';
import {expect, test} from './playwright-util.js';

/**
 * Test browser selector semantics using real converted MDX CSS and root classes.
 * Adjacent roots make cross-entry effects observable independently of popup layout.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<void>}
 */
async function renderScopeFixture(page) {
    const stylesheet = [
        ':is(body) { --root-is: yes; }',
        ':where(html, body) { --root-where: yes; }',
        ':not(:not(body)) { --root-not: yes; }',
        '@supports (display: grid) { @media screen { :is(body) { --nested: yes; } } }',
        'body + div, body ~ div { --cross-entry: leaked; }',
        'body > .shared { --direct-child: yes; }',
        '.shared { --descendant: yes; }',
        '.shared::before { content: "inside"; }',
        '*::after { content: "scoped universal"; }',
    ].join('\n');
    const fixture = makeMdictFixture([
        {key: 'Alpha', value: `<style>${stylesheet}</style><div class="shared">alpha</div>`},
        {key: 'Beta', value: '<div class="shared">beta</div>'},
    ]);
    const {files} = await createMdxImportData('inline-scope-browser.mdx', {}, fixture.bytes, []);
    /** @type {any[][]} */
    const rows = JSON.parse(new TextDecoder().decode(files.get('term_bank_1.json')));
    const rootClasses = rows.map((row) => String(row[5][0].content.data.class));
    const css = new TextDecoder().decode(files.get('styles.css'));
    await page.setContent('<main></main>');
    await page.evaluate(({classes, stylesheet: sourceCss}) => {
        for (const [index, className] of classes.entries()) {
            const root = document.createElement('div');
            root.id = `entry-${index}`;
            root.dataset.scClass = className;
            root.dataset.scTag = 'div';
            const child = document.createElement('div');
            child.id = `child-${index}`;
            child.dataset.scClass = 'shared';
            child.dataset.scTag = 'div';
            child.textContent = `entry ${index}`;
            root.append(child);
            document.querySelector('main')?.append(root);
        }
        const style = document.createElement('style');
        style.textContent = sourceCss;
        document.head.append(style);
    }, {classes: rootClasses, stylesheet: css});
}

test('MDX inline root selector functions and nested conditions still style their own root', async ({page}) => {
    await renderScopeFixture(page);
    for (const property of ['--root-is', '--root-where', '--root-not', '--nested']) {
        await expect(page.locator('#entry-0')).toHaveCSS(property, 'yes');
        await expect(page.locator('#entry-1')).toHaveCSS(property, '');
    }
});

test('MDX inline sibling combinators cannot style another entry while child selectors still work', async ({page}) => {
    await renderScopeFixture(page);
    await expect(page.locator('#child-0')).toHaveCSS('--direct-child', 'yes');
    await expect(page.locator('#child-0')).toHaveCSS('--descendant', 'yes');
    await expect(page.locator('#child-1')).toHaveCSS('--descendant', '');
    for (const id of ['entry-1', 'child-1']) {
        await expect(page.locator(`#${id}`)).toHaveCSS('--cross-entry', '');
    }
});

test('MDX inline ordinary and universal pseudo-elements remain valid and entry-local', async ({page}) => {
    await renderScopeFixture(page);
    expect(await page.locator('#child-0').evaluate((element) => getComputedStyle(element, '::before').content)).toBe('"inside"');
    expect(await page.locator('#child-0').evaluate((element) => getComputedStyle(element, '::after').content)).toBe('"scoped universal"');
    expect(await page.locator('#child-1').evaluate((element) => getComputedStyle(element, '::before').content)).toBe('none');
    expect(await page.locator('#child-1').evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none');
});
