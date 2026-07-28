/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

/** A Map-compatible LRU cache bounded by entry count and caller-defined weight. */
export class WeightedLruMap extends Map {
    /**
     * @param {number} maxEntries
     * @param {number} maxWeight
     * @param {(value: unknown, key: unknown) => number} getWeight
     */
    constructor(maxEntries, maxWeight, getWeight) {
        super();
        /** @type {number} */
        this._maxEntries = maxEntries;
        /** @type {number} */
        this._maxWeight = maxWeight;
        /** @type {(value: unknown, key: unknown) => number} */
        this._getWeight = getWeight;
        /** @type {Map<unknown, number>} */
        this._weights = new Map();
        /** @type {number} */
        this._weight = 0;
    }

    /** @returns {number} */
    get weight() { return this._weight; }

    /**
     * @param {unknown} key
     * @returns {unknown}
     */
    get(key) {
        const value = /** @type {unknown} */ (super.get(key));
        if (typeof value === 'undefined' || !super.has(key)) { return void 0; }
        super.delete(key);
        super.set(key, value);
        return value;
    }

    /**
     * @param {unknown} key
     * @param {unknown} value
     * @returns {this}
     */
    set(key, value) {
        if (super.has(key)) { this.delete(key); }
        const weight = Math.max(0, Math.trunc(this._getWeight(value, key)) || 0);
        if (weight > this._maxWeight) { return this; }
        super.set(key, value);
        this._weights.set(key, weight);
        this._weight += weight;
        while (this.size > this._maxEntries || this._weight > this._maxWeight) {
            const oldest = super.keys().next();
            if (oldest.done) { break; }
            this.delete(oldest.value);
        }
        return this;
    }

    /**
     * @param {unknown} key
     * @returns {boolean}
     */
    delete(key) {
        if (!super.has(key)) { return false; }
        this._weight -= this._weights.get(key) ?? 0;
        this._weights.delete(key);
        return super.delete(key);
    }

    /** */
    clear() {
        super.clear();
        this._weights.clear();
        this._weight = 0;
    }
}
