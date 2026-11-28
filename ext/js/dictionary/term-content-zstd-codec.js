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

/**
 * Canonical identity of the decoder actually used by a stored selector.
 * Legacy imports may retain an arbitrary dictionary label while using vanilla
 * ZSTD. Keep those labels out of immutable codec IDs and training eligibility.
 * @param {string|null} label
 * @returns {string|null}
 */
export function getLegacyTermContentZstdCodecId(label) {
    return label === 'jmdict' ? label : null;
}
