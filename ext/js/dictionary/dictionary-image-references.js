/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
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

