/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

/**
 * Tracks controls weakly so removed rows do not stay alive through a registry.
 * Owners from independent RPC snapshots advance together only when their
 * captured profile, index, and complete prior row still agree.
 */
/** @type {WeakMap<Element, import('generic-setting-controller').DictionaryRowOwnership>} */
const ownershipByElement = new WeakMap();
/** @type {WeakMap<Record<string, unknown>, import('generic-setting-controller').DictionaryRowOwnership>} */
const ownershipByEntry = new WeakMap();
/** @type {Map<string, Set<WeakRef<import('generic-setting-controller').DictionaryRowOwnership>>>} */
const ownershipByProfileIndex = new Map();
let nextDictionaryRowOwnerId = 0;

/** */
function pruneOwners() {
    for (const [key, owners] of ownershipByProfileIndex) {
        for (const reference of owners) {
            if (reference.deref() === void 0) { owners.delete(reference); }
        }
        if (owners.size === 0) { ownershipByProfileIndex.delete(key); }
    }
}

/**
 * @param {Element} element
 * @param {string} profileId
 * @param {number} index
 * @param {Record<string, unknown>} expectedEntry
 * @param {string} [prefix]
 * @returns {import('generic-setting-controller').DictionaryRowOwnership}
 */
export function createDictionaryRowOwnership(element, profileId, index, expectedEntry, prefix = 'row') {
    pruneOwners();
    let ownership = ownershipByEntry.get(expectedEntry);
    if (ownership === void 0 || ownership.profileId !== profileId || ownership.index !== index) {
        ownership = {id: `${prefix}:${++nextDictionaryRowOwnerId}`, profileId, index, expectedEntry: structuredClone(expectedEntry)};
        ownershipByEntry.set(expectedEntry, ownership);
        const key = JSON.stringify([profileId, index]);
        let owners = ownershipByProfileIndex.get(key);
        if (owners === void 0) {
            owners = new Set();
            ownershipByProfileIndex.set(key, owners);
        }
        owners.add(new WeakRef(ownership));
    }
    ownershipByElement.set(element, ownership);
    return ownership;
}

/**
 * @param {Element} element
 * @param {import('generic-setting-controller').DictionaryRowOwnership} ownership
 */
export function bindDictionaryRowOwnership(element, ownership) {
    ownershipByElement.set(element, ownership);
}

/**
 * @param {Element} element
 * @returns {import('generic-setting-controller').DictionaryRowOwnership|undefined}
 */
export function getDictionaryRowOwnership(element) {
    return ownershipByElement.get(element);
}

/**
 * Publish a committed field mutation without refreshing away pending input.
 * @param {string} profileId
 * @param {number} index
 * @param {Record<string, unknown>} expectedEntry
 * @param {Record<string, unknown>} nextEntry
 */
export function publishDictionaryRowOwnership(profileId, index, expectedEntry, nextEntry) {
    pruneOwners();
    const owners = ownershipByProfileIndex.get(JSON.stringify([profileId, index]));
    if (owners === void 0) { return; }
    const expected = JSON.stringify(expectedEntry);
    for (const reference of owners) {
        const owner = reference.deref();
        if (owner !== void 0 && JSON.stringify(owner.expectedEntry) === expected) {
            owner.expectedEntry = structuredClone(nextEntry);
        }
    }
}
