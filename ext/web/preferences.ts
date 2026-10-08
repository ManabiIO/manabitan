/* SPDX-License-Identifier: GPL-3.0-or-later */
import type {Preferences} from './protocol.js';

/**
 * A failed deletion must never change preferences. Call only after it commits.
 * @param current
 * @param title
 */
export function preferencesAfterDeletion(current: Preferences, title: string): Preferences {
    const disabled = current.disabled.filter((name) => name !== title);
    const defaultChoice = title === current.defaultTitle && current.defaultChoice === 'installed' ? 'deleted' : current.defaultChoice;
    if (disabled.length === current.disabled.length && defaultChoice === current.defaultChoice) {return current;}
    return {...current, disabled, defaultChoice};
}

/**
 * Reconcile an interrupted delete before disabled names can affect a reinstall.
 * @param current
 * @param installed
 */
export function reconcilePreferences(current: Preferences, installed: ReadonlySet<string>): Preferences {
    const disabled = current.disabled.filter((name) => installed.has(name));
    const defaultDeleted = current.defaultChoice === 'installed' &&
        current.defaultTitle !== null && !installed.has(current.defaultTitle);
    if (!defaultDeleted && disabled.length === current.disabled.length) {return current;}
    return {...current, disabled, defaultChoice: defaultDeleted ? 'deleted' : current.defaultChoice};
}
