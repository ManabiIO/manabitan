/* SPDX-License-Identifier: GPL-3.0-or-later */
import type {Preferences} from './protocol.js';

/** A failed deletion must never change preferences. Call only after it commits. */
export function preferencesAfterDeletion(current: Preferences, title: string): Preferences {
    const disabled = current.disabled.filter((name) => name !== title);
    const defaultChoice = title === current.defaultTitle ? 'deleted' : current.defaultChoice;
    if (disabled.length === current.disabled.length && defaultChoice === current.defaultChoice) {return current;}
    return {...current, disabled, defaultChoice};
}

/** Repair the default flag after a crash between deletion and preference write. */
export function recoverMissingDefault(current: Preferences, installed: ReadonlySet<string>): Preferences {
    if (current.defaultChoice !== 'installed' || current.defaultTitle === null || installed.has(current.defaultTitle)) {return current;}
    return {...current, defaultChoice: 'deleted'};
}
