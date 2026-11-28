/*
 * Copyright (C) 2026 Manabitan authors
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
/** @typedef {{regionId: string, layoutId: string, logicalStart: number, logicalLength: number}} ContentRootRegion */
/** @typedef {{epoch: number, logicalHighWater: number, regions: ContentRootRegion[]}} ContentStorageRoot */
/** @typedef {{epoch: number, logicalHighWater: number, regions: ReadonlyArray<Readonly<ContentRootRegion>>}} OwnedContentStorageRoot */
/**
 * @typedef {object} ContentStorageLease
 * @property {OwnedContentStorageRoot} root
 * @property {() => ContentStorageLease} fork
 * @property {() => void} release
 */
/**
 * @param {ContentStorageRoot} root
 * @returns {OwnedContentStorageRoot}
 * @throws {TypeError} If the root or its regions are invalid.
 */
function ownRoot(root) {
    if (!root || !Number.isSafeInteger(root.epoch) || root.epoch < 0 ||
    !Number.isSafeInteger(root.logicalHighWater) || root.logicalHighWater < 0 || !Array.isArray(root.regions)) {
        throw new TypeError('Invalid content storage root');
    }
    let cursor = 0;
    const regionIds = new Set();
    const layoutIds = new Set();
    const regions = root.regions.map((/** @type {ContentRootRegion} */ region) => {
        if (!region || typeof region.regionId !== 'string' || !region.regionId ||
        typeof region.layoutId !== 'string' || !region.layoutId ||
        regionIds.has(region.regionId) || layoutIds.has(region.layoutId) || !Number.isSafeInteger(region.logicalStart) ||
        region.logicalStart !== cursor || !Number.isSafeInteger(region.logicalLength) ||
        region.logicalLength <= 0 || region.logicalLength > 134217728 ||
        cursor > Number.MAX_SAFE_INTEGER - region.logicalLength) {
            throw new TypeError('Invalid content region directory');
        }
        regionIds.add(region.regionId);
        layoutIds.add(region.layoutId);
        cursor += region.logicalLength;
        return Object.freeze({regionId: region.regionId,
            layoutId: region.layoutId,
            logicalStart: region.logicalStart,
            logicalLength: region.logicalLength});
    });
    if (cursor !== root.logicalHighWater) { throw new TypeError('Content root directory does not cover high water'); }
    return Object.freeze({epoch: root.epoch, logicalHighWater: root.logicalHighWater, regions: Object.freeze(regions)});
}

/** Owns immutable read roots only. Durable SQL publication and staged-file closure stay above this component. */
export class ContentStorageSnapshots {
    /**
     * @param {ContentStorageRoot} root
     */
    constructor(root) {
        /** @type {OwnedContentStorageRoot} */
        this._current = ownRoot(root);
        /** @type {Map<OwnedContentStorageRoot, number>} */
        this._leases = new Map();
        /** @type {Set<string>} */
        this._currentLayoutIds = new Set(this._current.regions.map((/** @type {{layoutId: string}} */ region) => region.layoutId));
    }

    /**
     * @returns {OwnedContentStorageRoot}
     */
    get current() { return this._current; }

    /**
     * @returns {boolean} Whether any caller still owns physical read resources.
     */
    get hasActiveLeases() { return this._leases.size > 0; }

    /** Synchronous CAS after a successful durable SQL commit, never before it. */
    /**
     * @param {OwnedContentStorageRoot} expected
     * @param {ContentStorageRoot} next
     * @returns {OwnedContentStorageRoot}
     * @throws {Error} If the publication is stale or the next root is invalid.
     */
    publish(expected, next) {
        if (expected !== this._current) { throw new Error('Stale content storage root publication'); }
        const owned = ownRoot(next);
        if (owned.epoch <= expected.epoch) { throw new Error('Content storage epoch did not advance'); }
        if (owned.logicalHighWater < expected.logicalHighWater) { throw new Error('Published logical content addresses cannot shrink'); }
        this._current = owned;
        this._currentLayoutIds = new Set(owned.regions.map((/** @type {{layoutId: string}} */ region) => region.layoutId));
        return owned;
    }

    /**
     * @returns {ContentStorageLease}
     */
    acquire() { return this._acquire(this._current); }

    /**
     * @param {OwnedContentStorageRoot} root
     * @returns {ContentStorageLease}
     * @throws {Error} If the root is invalid.
     */
    _acquire(root) {
        this._leases.set(root, (this._leases.get(root) ?? 0) + 1);
        let released = false;
        return Object.freeze({root,
            fork: () => {
                if (released) { throw new Error('Content storage read lease already released'); }
                return this._acquire(root);
            },
            release: () => {
                if (released) { return; }
                released = true;
                const current = this._leases.get(root);
                if (typeof current === 'undefined') { throw new Error('Content storage lease ownership was lost'); }
                const remaining = current - 1;
                if (remaining === 0) {
                    this._leases.delete(root);
                } else {
                    this._leases.set(root, remaining);
                }
            }});
    }

    /** GC must also check durable active/staged/recovery references under mutation admission. */
    /**
     * @param {string} layoutId
     * @returns {boolean}
     */
    isLayoutPinned(layoutId) {
        if (this._currentLayoutIds.has(layoutId)) { return true; }
        for (const root of this._leases.keys()) {
            if (root.regions.some((/** @type {{layoutId: string}} */ region) => region.layoutId === layoutId)) { return true; }
        }
        return false;
    }
}
