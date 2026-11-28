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

/** @typedef {{discard: () => Promise<void>}} PreparedTermContentLookahead */
/** @type {WeakMap<object, () => PreparedTermContentLookahead|null|void>} */
const triggers = new WeakMap();

/**
 * Keeps the parser's lookahead gate private to its current sink callback.
 * The sink opens it only after publishing the preceding canonical contents.
 * @param {object} chunk
 * @param {() => PreparedTermContentLookahead|null|void} trigger
 */
export function registerTermContentLookahead(chunk, trigger) {
    triggers.set(chunk, trigger);
}

/**
 * The importer creates an ordinary payload from each parser-owned chunk.
 * Inherit only the private gate; no worker message can supply this callback.
 * @param {object} source
 * @param {object} target
 */
export function inheritTermContentLookahead(source, target) {
    const trigger = triggers.get(source);
    if (typeof trigger === 'function') { triggers.set(target, trigger); }
}

/**
 * @param {object} chunk
 * @returns {PreparedTermContentLookahead|null}
 */
export function startTermContentLookahead(chunk) {
    const trigger = triggers.get(chunk);
    triggers.delete(chunk);
    return trigger?.() ?? null;
}

/** @param {object} chunk */
export function clearTermContentLookahead(chunk) {
    triggers.delete(chunk);
}
