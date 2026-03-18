/*
 * Copyright (C) 2026  Manabitan authors
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

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(testDir, '..', 'data', 'dictionaries', 'playwright-read.mdx');
const defaultFixtureBuffer = readFileSync(fixturePath);

export const mdxListingUrl = 'https://example.invalid/mdx/';
export const mdxDictionaryTitle = 'Playwright Remote MDX Override';
export const mdxDescriptionOverride = 'Playwright-routed MDX import fixture for the URL workflow.';
export const mdxRevisionOverride = 'playwright-mdx-import';
export const mdxLookupTerm = 'Read';
export const mdxLookupGlossary = 'To look at and understand written language.';
export const localMdxFixtureFileName = 'playwright-yome.mdx';
export const localMdxDictionaryTitle = 'Manabitan Manual MDX Test Dictionary';
export const localMdxDescription = 'A tiny hand-built MDX dictionary for manually testing Manabitan imports. Includes entries for Read, read, and 読め.';
export const localMdxRevision = 'mdx import';
export const localMdxLookupTerm = '読め';
export const localMdxLookupGlossary = 'Imperative or potential-related form used here for MDX import testing.';
export const localEnglishMdxFixtureFileName = 'playwright-read.mdx';
export const localEnglishMdxDictionaryTitle = 'Manabitan Manual MDX Test Dictionary';
export const localEnglishMdxDescription = 'A tiny hand-built MDX dictionary for manually testing Manabitan imports. Includes entries for Read, read, and 読め.';
export const localEnglishMdxRevision = 'mdx import';
export const localEnglishMdxLookupTerm = 'Read';
export const localEnglishMdxLookupGlossary = 'To look at and understand written language.';

const mdxFileName = 'fixture.mdx';
const mdxFileUrl = `${mdxListingUrl}${mdxFileName}`;

/**
 * @typedef {{
 *   mdxBuffer?: Buffer,
 *   listingUrl?: string|null,
 *   mdxUrl?: string|null,
 *   mdxFileName?: string,
 * }} PlaywrightMdxFixtureOptions
 */

/**
 * @param {{mdxFileName: string}} details
 * @returns {string}
 */
function createListingHtml({mdxFileName: currentMdxFileName}) {
    return [
        '<!doctype html>',
        '<html lang="en">',
        '<body>',
        `<a href="${encodeURIComponent(currentMdxFileName)}">${currentMdxFileName}</a>`,
        '</body>',
        '</html>',
    ].join('');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {PlaywrightMdxFixtureOptions} [options]
 * @returns {Promise<{requestCounts: {listing: number, mdx: number, mdd: number}}>}
 */
export async function setupMdxImportHarness(page, options = {}) {
    const normalizedOptions = {
        mdxBuffer: options.mdxBuffer ?? defaultFixtureBuffer,
        listingUrl: options.listingUrl ?? mdxListingUrl,
        mdxUrl: options.mdxUrl ?? mdxFileUrl,
        mdxFileName: options.mdxFileName ?? mdxFileName,
    };
    const requestCounts = {
        listing: 0,
        mdx: 0,
        mdd: 0,
    };

    if (typeof normalizedOptions.listingUrl === 'string') {
        await page.route(normalizedOptions.listingUrl, async (route) => {
            requestCounts.listing += 1;
            await route.fulfill({
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: createListingHtml({
                    mdxFileName: normalizedOptions.mdxFileName,
                }),
            });
        });
    }
    if (typeof normalizedOptions.mdxUrl === 'string') {
        await page.route(normalizedOptions.mdxUrl, async (route) => {
            requestCounts.mdx += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/octet-stream',
                body: normalizedOptions.mdxBuffer,
            });
        });
    }

    return {requestCounts};
}
