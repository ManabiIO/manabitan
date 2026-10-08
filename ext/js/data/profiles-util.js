/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {ExtensionError} from '../core/extension-error.js';

/** @type {WeakMap<import('../application.js').Application, Promise<void>>} */
const profileWriteTails = new WeakMap();

/**
 * @param {number} direction
 * @param {import('../application.js').Application} application
 * @returns {Promise<void>}
 */
export function setProfile(direction, application) {
    if (!Number.isSafeInteger(direction)) {
        return Promise.reject(new TypeError('Profile direction must be an integer'));
    }

    // Each hotkey reads the index after earlier hotkeys have completed.
    // Otherwise rapid presses can all write the same next profile.
    const previous = profileWriteTails.get(application) ?? Promise.resolve();
    const operation = previous.then(async () => {
        const {profileCurrent, profiles} = await application.api.optionsGetFull();
        const profileCount = profiles.length;
        if (profileCount === 0) { return; }
        if (!Number.isSafeInteger(profileCurrent) || profileCurrent < 0 || profileCurrent >= profileCount) {
            throw new RangeError('Current profile index is invalid');
        }
        const step = ((direction % profileCount) + profileCount) % profileCount;
        const newProfile = (profileCurrent + step) % profileCount;
        if (newProfile === profileCurrent) { return; }

        /** @type {import('settings-modifications').ScopedModificationSet} */
        const modification = {
            action: 'set',
            path: 'profileCurrent',
            value: newProfile,
            scope: 'global',
            optionsContext: null,
        };
        const results = await application.api.modifySettings([modification], 'search');
        if (!Array.isArray(results) || results.length !== 1 || results[0] === null || typeof results[0] !== 'object') {
            throw new Error('Profile change returned an invalid result');
        }
        if (results[0].error) { throw ExtensionError.deserialize(results[0].error); }
    });

    // A rejected operation reports its error to its caller but does not poison
    // the queue. The settled tail is released when no later writes depend on it.
    const tail = operation.catch(() => {});
    profileWriteTails.set(application, tail);
    void tail.then(() => {
        if (profileWriteTails.get(application) === tail) {
            profileWriteTails.delete(application);
        }
    });
    return operation;
}
