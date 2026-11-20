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

import {parseJson} from '../core/json.js';
import {getImageMediaTypeFromFileName} from '../media/media-util.js';

/** @param {string} glossaryJson */
export function tryCollectGlossaryImagePaths(glossaryJson) {
    let glossary;
    try {
        glossary = /** @type {unknown} */ (parseJson(glossaryJson));
    } catch (_) {
        return [];
    }
    return collectGlossaryImagePaths(glossary);
}

/**
 * @param {unknown} glossary
 * @returns {string[]}
 */
function collectGlossaryImagePaths(glossary) {
    /** @type {string[]} */
    const paths = [];
    if (!Array.isArray(glossary)) { return paths; }
    for (const value of /** @type {unknown[]} */ (glossary)) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) { continue; }
        const item = /** @type {Record<string, unknown>} */ (value);
        if (item.type === 'image') {
            if (typeof item.path === 'string' && getImageMediaTypeFromFileName(item.path) !== null) {
                paths.push(item.path);
            }
            continue;
        }
        if (item.type === 'structured-content') {
            collectStructuredContentImagePaths(item.content, paths);
        }
    }
    return paths;
}

/**
 * @param {unknown} content
 * @param {string[]} paths
 */
function collectStructuredContentImagePaths(content, paths) {
    if (Array.isArray(content)) {
        for (const item of content) {
            collectStructuredContentImagePaths(item, paths);
        }
        return;
    }
    if (!(typeof content === 'object' && content !== null)) { return; }
    const value = /** @type {Record<string, unknown>} */ (content);
    if (value.tag === 'img') {
        if (typeof value.path === 'string' && getImageMediaTypeFromFileName(value.path) !== null) {
            paths.push(value.path);
        }
        return;
    }
    if (typeof value.content !== 'undefined') {
        collectStructuredContentImagePaths(value.content, paths);
    }
}
