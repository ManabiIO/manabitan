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

import {expect, test} from './playwright-util.js';

test('MDX help is reachable, keyboard accessible and clear about import limits', async ({page, extensionId}) => {
    await page.goto(`chrome-extension://${extensionId}/quick-start-guide.html`);
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await page.getByRole('link', {name: 'MDict import guide', exact: true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-loaded', 'true', {timeout: 30_000});
    await expect(page.getByRole('heading', {level: 1})).toHaveText('Importing MDict dictionaries');
    await expect(page.locator('#mdict-audio-limit')).toBeVisible();
    await expect(page.locator('#mdict-audio-limit')).toContainText('Dictionary audio is not enabled');
    await expect(page.getByText('Local files start importing immediately.', {exact: true})).toBeVisible();
    const troubleshooting = page.locator('#mdict-troubleshooting');
    await expect(troubleshooting).not.toHaveAttribute('open');
    await troubleshooting.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(troubleshooting).toHaveAttribute('open', '');
    await expect(page.getByRole('heading', {name: 'Conversion times out', exact: true})).toBeVisible();
    for (const width of [390, 320]) {
        await page.setViewportSize({width, height: 844});
        expect(await page.evaluate(() => {
            const scroller = document.querySelector('.content');
            return scroller !== null && scroller.scrollWidth <= scroller.clientWidth && document.documentElement.scrollWidth <= window.innerWidth;
        })).toBe(true);
    }
    await page.getByRole('link', {name: 'Open Dictionary Settings', exact: true}).click();
    await expect(page).toHaveURL(/settings\.html#dictionaries$/u);
});
