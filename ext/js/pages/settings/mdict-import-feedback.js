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

/**
 * These are conversion diagnostics, not proof that storage committed. Do not
 * classify warnings as import errors or change retry/success semantics.
 * @param {Array<{phase: string, details?: Record<string, unknown>}>} phaseTimings
 * @returns {string[]}
 */
export function getMdictConversionWarnings(phaseTimings) {
    /** @type {Map<string, Record<string, unknown>>} */
    const phases = new Map();
    for (const timing of phaseTimings) {
        if (timing.details !== null && typeof timing.details === 'object') {
            phases.set(timing.phase, timing.details);
        }
    }
    /**
     * @param {string} phase
     * @param {string} key
     * @returns {number}
     */
    const count = (phase, key) => {
        const value = phases.get(phase)?.[key];
        return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
    };
    const skipped = count('prepare-mdx:convert-entries', 'skippedEntryErrorCount');
    const redirects = count('prepare-mdx:encode-banks', 'unresolvedRedirectCount');
    const unreadable = count('prepare-mdx:materialize-assets', 'assetLookupErrorCount');
    const missing = count('prepare-mdx:materialize-assets', 'missingReferencedAssetCount');
    const warnings = [];
    if (skipped > 0) {
        warnings.push(`${skipped} definition record${skipped === 1 ? ' was' : 's were'} skipped after a read or conversion error. The converted dictionary is incomplete. Try another source or a compatible converter.`);
    }
    if (redirects > 0) {
        warnings.push(`${redirects} redirect alias${redirects === 1 ? ' could' : 'es could'} not be resolved. These aliases may not appear in search results; their target definitions may still be available.`);
    }
    if (missing > 0) {
        warnings.push(`${missing} referenced resource${missing === 1 ? ' was' : 's were'} not included. Select the matching MDX and complete MDD set together to include available images and styles. This does not count missing definitions.`);
    }
    if (unreadable > 0) {
        warnings.push(`${unreadable} resource read${unreadable === 1 ? '' : 's'} failed. Some images or styles may be missing. Check that all MDD files belong to this dictionary and are complete.`);
    }
    return warnings;
}

/**
 * Render untrusted filenames as text only. A null root is permitted for older
 * settings hosts which do not mount the optional notice region.
 * @param {HTMLElement|null} root
 * @param {string} title
 * @param {Array<{phase: string, details?: Record<string, unknown>}>} phaseTimings
 */
export function appendMdictConversionWarnings(root, title, phaseTimings) {
    if (root === null) { return; }
    const warnings = getMdictConversionWarnings(phaseTimings);
    if (warnings.length === 0) { return; }
    const document = root.ownerDocument;
    const group = document.createElement('div');
    const heading = document.createElement('p');
    heading.textContent = `MDict conversion notes for ${title}. Installation status is shown separately.`;
    group.appendChild(heading);
    const list = document.createElement('ul');
    for (const warning of warnings) {
        const item = document.createElement('li');
        item.textContent = warning;
        list.appendChild(item);
    }
    group.appendChild(list);
    root.appendChild(group);
    root.hidden = false;
}
