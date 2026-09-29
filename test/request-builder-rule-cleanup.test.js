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

import {afterEach, describe, expect, test, vi} from 'vitest';
import {RequestBuilder} from '../ext/js/background/request-builder.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/**
 * @param {{failFirstRemoval?: boolean, failFirstAdd?: boolean}} [options]
 * @returns {{fetch: ReturnType<typeof vi.fn>, addIds: number[], removeIds: number[], rules: Set<number>}}
 */
function installRuntime({failFirstRemoval = false, failFirstAdd = false} = {}) {
    /** @type {{message: string}|null} */
    let lastError = null;
    let removalAttempts = 0;
    let addAttempts = 0;
    const rules = new Set();
    /** @type {number[]} */
    const addIds = [];
    /** @type {number[]} */
    const removeIds = [];

    const updateSessionRules = vi.fn((
        /** @type {chrome.declarativeNetRequest.UpdateRuleOptions} */ details,
        /** @type {() => void} */ callback,
    ) => {
        const addRules = details.addRules ?? [];
        const removeRuleIds = details.removeRuleIds ?? [];

        if (addRules.length > 0) {
            ++addAttempts;
            for (const {id} of addRules) {
                addIds.push(id);
                if (failFirstAdd && addAttempts === 1) {
                    lastError = {message: 'injected add failure'};
                    callback();
                    lastError = null;
                    return;
                }
                if (rules.has(id)) {
                    lastError = {message: `duplicate rule id ${id}`};
                    callback();
                    lastError = null;
                    return;
                }
                rules.add(id);
            }
        }

        if (removeRuleIds.length > 0) {
            ++removalAttempts;
            removeIds.push(...removeRuleIds);
            if (failFirstRemoval && removalAttempts === 1) {
                lastError = {message: 'injected removal failure'};
                callback();
                lastError = null;
                return;
            }
            for (const id of removeRuleIds) {
                rules.delete(id);
            }
        }

        callback();
    });
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));

    vi.stubGlobal('chrome', /** @type {import('core').SafeAny} */ ({
        runtime: {
            get lastError() {
                return lastError;
            },
        },
        declarativeNetRequest: {updateSessionRules},
    }));
    vi.stubGlobal('fetch', fetch);
    return {fetch, addIds, removeIds, rules};
}

describe('RequestBuilder anonymous rule cleanup', () => {
    test('does not reuse an ID whose browser rule failed to remove', async () => {
        const {fetch, addIds, removeIds, rules} = installRuntime({failFirstRemoval: true});
        const builder = new RequestBuilder();

        await expect(builder.fetchAnonymous('https://example.com/first', {})).resolves.toBeInstanceOf(Response);
        expect(rules).toEqual(new Set([1]));

        await expect(builder.fetchAnonymous('https://example.com/second', {})).resolves.toBeInstanceOf(Response);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(addIds).toEqual([1, 2]);
        expect(removeIds).toEqual([1, 2]);
        expect(rules).toEqual(new Set([1]));

        // Successfully removed IDs remain reusable while the stale ID stays reserved.
        await expect(builder.fetchAnonymous('https://example.com/third', {})).resolves.toBeInstanceOf(Response);
        expect(addIds).toEqual([1, 2, 2]);
        expect(rules).toEqual(new Set([1]));
    });

    test('releases an ID when installing its browser rule fails', async () => {
        const {fetch, addIds, rules} = installRuntime({failFirstAdd: true});
        const builder = new RequestBuilder();

        await expect(builder.fetchAnonymous('https://example.com/first', {})).rejects.toThrow('injected add failure');
        expect(fetch).not.toHaveBeenCalled();
        expect(rules).toEqual(new Set());

        await expect(builder.fetchAnonymous('https://example.com/second', {})).resolves.toBeInstanceOf(Response);
        expect(addIds).toEqual([1, 1]);
        expect(fetch).toHaveBeenCalledOnce();
        expect(rules).toEqual(new Set());
    });

    test('preserves the original fetch rejection when cleanup also fails', async () => {
        const {fetch, addIds, rules} = installRuntime({failFirstRemoval: true});
        const requestError = new Error('request failed');
        fetch.mockRejectedValueOnce(requestError);
        const builder = new RequestBuilder();

        await expect(builder.fetchAnonymous('https://example.com/first', {})).rejects.toBe(requestError);
        expect(rules).toEqual(new Set([1]));

        await expect(builder.fetchAnonymous('https://example.com/second', {})).resolves.toBeInstanceOf(Response);
        expect(addIds).toEqual([1, 2]);
        expect(rules).toEqual(new Set([1]));
    });
});
