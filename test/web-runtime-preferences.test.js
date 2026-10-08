/* SPDX-License-Identifier: GPL-3.0-or-later */
import {describe, expect, test} from 'vitest';
import {preferencesAfterDeletion, reconcilePreferences} from '../ext/web/preferences.js';

/** @type {import('../ext/web/protocol.js').Preferences} */
const configured = {version: 1, disabled: ['Jitendex', 'Other'], defaultChoice: 'installed', defaultTitle: 'Jitendex'};

describe('web dictionary preference persistence', () => {
    test('successful default deletion clears its disabled tombstone without mutating the snapshot', () => {
        const updated = preferencesAfterDeletion(configured, 'Jitendex');
        expect(updated).toEqual({version: 1, disabled: ['Other'], defaultChoice: 'deleted', defaultTitle: 'Jitendex'});
        expect(configured.disabled).toEqual(['Jitendex', 'Other']);
        expect(configured.defaultChoice).toBe('installed');
    });

    test('deleting an old default does not override a deliberate declined choice', () => {
        const declined = {...configured, defaultChoice: /** @type {const} */ ('declined')};
        expect(preferencesAfterDeletion(declined, 'Jitendex')).toEqual({
            ...declined,
            disabled: ['Other'],
        });
    });

    test('unrelated deletion preserves default choice and skips unnecessary writes', () => {
        expect(preferencesAfterDeletion(configured, 'Unknown')).toBe(configured);
        expect(preferencesAfterDeletion(configured, 'Other')).toEqual({
            ...configured,
            disabled: ['Jitendex'],
        });
    });

    test('status recovers a deleted default after a crash but never undoes user decline', () => {
        expect(reconcilePreferences(configured, new Set(['Other']))).toEqual({
            ...configured,
            disabled: ['Other'],
            defaultChoice: 'deleted',
        });
        expect(reconcilePreferences(configured, new Set(['Jitendex', 'Other']))).toBe(configured);
        /** @type {import('../ext/web/protocol.js').Preferences} */
        const declined = {...configured, defaultChoice: 'declined'};
        expect(reconcilePreferences(declined, new Set(['Other']))).toEqual({
            ...declined,
            disabled: ['Other'],
        });
        expect(reconcilePreferences(declined, new Set(['Jitendex', 'Other']))).toBe(declined);
    });
});
