/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test, vi} from 'vitest';
import {DictionaryController} from '../ext/js/pages/settings/dictionary-controller.js';

/**
 * @param {string} title
 * @param {Record<string, unknown>} [metadata]
 * @returns {import('dictionary-importer').Summary}
 */
function summary(title, metadata = {}) {
    return /** @type {import('dictionary-importer').Summary} */ ({title, revision: '1', version: 3, importDate: 0, styles: '', sequenced: false, prefixWildcardsSupported: false, importSuccess: true, ...metadata});
}

test('update cleanup never deletes a healthy dictionary because its literal title resembles a transient title', async () => {
    const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
    const healthy = ['JMdict [replaced literal]', 'JMdict [update-staging literal]', 'JMdict [cutover literal] extra'].map((title) => summary(title));
    const owned = summary('Updating dictionary [update-staging owned-token]', {transientUpdateStage: 'update-staging', updateSessionToken: 'owned-token'});
    let installed = [...healthy, owned];
    const remove = vi.fn(async (/** @type {string} */ title) => { installed = installed.filter((item) => item.title !== title); });
    const removeSettings = vi.fn(async () => {});
    Reflect.set(controller, '_settingsController', {application: {api: {getDictionaryInfo: async () => installed}}});
    Reflect.set(controller, '_deleteDictionaryInternal', remove);
    Reflect.set(controller, '_deleteDictionarySettings', removeSettings);
    const result = await controller._getDictionaryInfoAfterTransientCleanup();
    expect(remove).toHaveBeenCalledExactlyOnceWith(owned.title, expect.any(Function));
    expect(removeSettings).toHaveBeenCalledExactlyOnceWith(owned.title);
    expect(result.dictionaryInfo).toEqual(healthy);
    expect(result.transientTitles).toEqual([]);
});

test.each(['update-staging', 'cutover', 'replaced'])('transient cleanup requires an exact matching %s ownership suffix', (stage) => {
    const controller = /** @type {DictionaryController} */ (Object.create(DictionaryController.prototype));
    const owned = summary(`Dictionary [${stage} token]`, {transientUpdateStage: stage, updateSessionToken: 'token'});
    const entries = [
        owned,
        summary(`Literal [${stage} token]`),
        summary(`Wrong token [${stage} token]`, {transientUpdateStage: stage, updateSessionToken: 'other'}),
        summary(`Wrong stage [${stage} token]`, {transientUpdateStage: 'unknown-stage', updateSessionToken: 'token'}),
        summary(`Embedded [${stage} token] more`, {transientUpdateStage: stage, updateSessionToken: 'token'}),
    ];
    expect(controller._getTransientDictionaryTitles(entries)).toEqual([owned.title]);
});
