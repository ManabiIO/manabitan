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

/** @typedef {{type: 'zip', file: File}|{type: 'mdx', mdxFile: File, mddFiles: File[]}} DictionaryImportSource */

/**
 * Preserve directory identity; never attach resources from another directory.
 * @param {File} file
 * @returns {string}
 */
function getPath(file) {
    const path = typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name;
    return normalizeMdictImportPath(path);
}

/**
 * Match basenames case-insensitively without merging distinct directories.
 * @param {string} path
 * @returns {string}
 */
export function normalizeMdictImportPath(path) {
    const normalized = path.trim().replaceAll('\\', '/');
    const split = normalized.lastIndexOf('/') + 1;
    return normalized.slice(0, split) + normalized.slice(split).toLowerCase();
}

/**
 * Exact dictionary stems take precedence over multipart suffixes. A numeric
 * suffix is a volume number only when the corresponding base MDX exists.
 * @param {string} fileName
 * @param {ReadonlySet<string>} mdxKeys Normalized paths without the .mdx extension.
 * @returns {string|null}
 */
export function resolveMddImportKey(fileName, mdxKeys) {
    const path = normalizeMdictImportPath(fileName);
    if (!path.endsWith('.mdd')) { return null; }
    const stem = path.slice(0, -4);
    if (mdxKeys.has(stem)) { return stem; }
    const match = /^(.*)\.([0-9]+)$/u.exec(stem);
    return match !== null && mdxKeys.has(match[1]) ? match[1] : null;
}

/**
 * Compare arbitrary-length volume numbers without Number precision loss.
 * The unnumbered MDD precedes numbered volumes, including volume zero.
 * @param {string} nameA
 * @param {string} nameB
 * @param {string} mdxKey
 * @returns {number}
 */
export function compareMddImportPaths(nameA, nameB, mdxKey) {
    const a = normalizeMdictImportPath(nameA);
    const b = normalizeMdictImportPath(nameB);
    if (a === b) { return 0; }
    if (a === `${mdxKey}.mdd`) { return -1; }
    if (b === `${mdxKey}.mdd`) { return 1; }
    const numberA = a.slice(mdxKey.length + 1, -4).replace(/^0+/u, '') || '0';
    const numberB = b.slice(mdxKey.length + 1, -4).replace(/^0+/u, '') || '0';
    if (numberA.length !== numberB.length) { return numberA.length - numberB.length; }
    if (numberA !== numberB) { return numberA < numberB ? -1 : 1; }
    return a < b ? -1 : 1;
}

/**
 * Group the complete selection before assigning MDD files. The function is
 * deterministic, does not read file bytes, and never mutates the input array.
 * Invalid/ambiguous groups are omitted; unrelated valid sources remain usable.
 * @param {File[]} files
 * @returns {{sources: DictionaryImportSource[], errors: Error[]}}
 */
export function createMdictImportSources(files) {
    /** @type {Map<string, {file: File, firstIndex: number, resources: File[], resourcePaths: Set<string>, invalid: boolean}>} */
    const groups = new Map();
    /** @type {Array<{firstIndex: number, source: DictionaryImportSource}>} */
    const pending = [];
    /** @type {Error[]} */
    const errors = [];
    // Index MDX paths first so file-picker/drop order cannot affect pairing.
    for (const [index, file] of files.entries()) {
        const path = getPath(file);
        if (path.endsWith('.zip')) {
            pending.push({firstIndex: index, source: {type: 'zip', file}});
        } else if (path.endsWith('.mdx')) {
            const key = path.slice(0, -4);
            const group = groups.get(key);
            if (typeof group !== 'undefined') {
                if (!group.invalid) {
                    errors.push(new Error(`Multiple MDX files matched the same dictionary group: ${file.name}. Import each dictionary separately; no files in this group were imported.`));
                }
                group.invalid = true;
            } else {
                groups.set(key, {file, firstIndex: index, resources: [], resourcePaths: new Set(), invalid: false});
            }
        } else if (!path.endsWith('.mdd')) {
            errors.push(new Error(`Unsupported dictionary file: ${file.name}. Select a Yomitan .zip archive or an .mdx file with its optional matching .mdd files.`));
        }
    }
    const mdxKeys = new Set(groups.keys());
    for (const [index, file] of files.entries()) {
        const path = getPath(file);
        if (!path.endsWith('.mdd')) { continue; }
        const key = resolveMddImportKey(path, mdxKeys);
        if (key === null) {
            errors.push(new Error(`Found MDD resources without a matching MDX file: ${file.name}. Select the matching .mdx and all its .mdd files together, using the original filenames and folder. An .mdd file cannot be imported on its own.`));
            continue;
        }
        const group = groups.get(key);
        if (typeof group === 'undefined' || group.invalid) { continue; }
        if (group.resourcePaths.has(path)) {
            group.invalid = true;
            errors.push(new Error(`Duplicate MDD resource path: ${file.name}. Select only one copy of each resource file; no files in this dictionary group were imported.`));
            continue;
        }
        group.resourcePaths.add(path);
        group.resources.push(file);
        group.firstIndex = Math.min(group.firstIndex, index);
    }
    for (const [key, group] of groups) {
        if (group.invalid) { continue; }
        group.resources.sort((a, b) => compareMddImportPaths(getPath(a), getPath(b), key));
        pending.push({firstIndex: group.firstIndex, source: {type: 'mdx', mdxFile: group.file, mddFiles: group.resources}});
    }
    pending.sort((a, b) => a.firstIndex - b.firstIndex);
    return {sources: pending.map(({source}) => source), errors};
}
