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

import path from 'node:path';
import {mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {DOMParser} from '../../ext/lib/linkedom.js';

export const DEFAULT_FREEMDICT_SHARE_URL = 'https://cloud.freemdict.com/index.php/s/pgKcDcbSDTCzXCs';
export const DEFAULT_FREEMDICT_DAV_URL = 'https://cloud.freemdict.com/public.php/dav/files/pgKcDcbSDTCzXCs/';

/**
 * @typedef {{
 *   url: string,
 *   href: string,
 *   relativePath: string,
 *   isDirectory: boolean,
 *   size: number|null,
 *   contentType: string|null,
 *   lastModified: string|null,
 * }} DavEntry
 */

/**
 * @typedef {{
 *   type: 'directory',
 *   id: string,
 *   url: string,
 *   relativePath: string,
 * }} DirectoryWorkItem
 */

/**
 * @typedef {{
 *   url: string,
 *   relativePath: string,
 *   size: number|null,
 *   contentType: string|null,
 * }} CaseFile
 */

/**
 * @typedef {{
 *   type: 'case',
 *   id: string,
 *   caseType: 'zip'|'mdx',
 *   relativePath: string,
 *   matchText: string,
 *   files: CaseFile[],
 * }} CaseWorkItem
 */

/**
 * @typedef {{
 *   type: 'skip',
 *   id: string,
 *   reason: string,
 *   relativePath: string,
 *   matchText: string,
 *   files: CaseFile[],
 * }} SkipWorkItem
 */

/**
 * @typedef {DirectoryWorkItem|CaseWorkItem|SkipWorkItem} WorkItem
 */

/**
 * @typedef {{
 *   resume: boolean,
 *   limit: number|null,
 *   match: string,
 *   stateFile: string,
 *   reportFile: string,
 *   tempDir: string,
 *   keepFailed: boolean,
 *   help: boolean,
 * }} ParsedCliArgs
 */

const TEXT_DECODER = new TextDecoder();

/**
 * @param {string} url
 * @returns {string}
 */
export function normalizeDavDirectoryUrl(url) {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/')) {
        parsed.pathname = `${parsed.pathname}/`;
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
}

/**
 * @param {string} shareUrl
 * @returns {string}
 */
export function convertShareUrlToDavUrl(shareUrl) {
    const parsed = new URL(shareUrl);
    const pathSegments = parsed.pathname.split('/').filter((value) => value.length > 0);
    const shareIndex = pathSegments.indexOf('s');
    if (shareIndex >= 0 && shareIndex < (pathSegments.length - 1)) {
        const token = pathSegments[shareIndex + 1];
        return `${parsed.origin}/public.php/dav/files/${encodeURIComponent(token)}/`;
    }
    if (parsed.pathname.includes('/public.php/dav/files/')) {
        return normalizeDavDirectoryUrl(parsed.href);
    }
    return normalizeDavDirectoryUrl(parsed.href);
}

/**
 * @param {string} rootDavUrl
 * @param {string} entryUrl
 * @returns {string}
 */
export function getShareRelativePath(rootDavUrl, entryUrl) {
    const root = new URL(normalizeDavDirectoryUrl(rootDavUrl));
    const entry = new URL(entryUrl);
    const rootPath = root.pathname;
    const entryPath = entry.pathname;
    const relativePath = entryPath.startsWith(rootPath) ? entryPath.slice(rootPath.length) : entryPath.replace(/^\/+/, '');
    return decodeURIComponent(relativePath.replace(/\/+$/, ''));
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isZipSharePath(value) {
    return /\.zip$/i.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isMdxSharePath(value) {
    return /\.mdx$/i.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isMddSharePath(value) {
    return /(?:\.\d+)?\.mdd$/i.test(value);
}

/**
 * @param {string} value
 * @returns {string|null}
 */
export function getMdxGroupKey(value) {
    const normalized = path.posix.basename(value).trim().toLowerCase();
    if (normalized.endsWith('.mdx')) {
        return normalized.slice(0, -4);
    }
    const match = /^(.*?)(?:\.\d+)?\.mdd$/i.exec(normalized);
    return match ? match[1] : null;
}

/**
 * @param {Node|Element|null|undefined} node
 * @param {string} tagName
 * @returns {string}
 */
function getFirstChildText(node, tagName) {
    const parent = /** @type {Element|null} */ (
        node && typeof node === 'object' && typeof Reflect.get(node, 'getElementsByTagName') === 'function' ? node : null
    );
    if (parent === null) { return ''; }
    const child = parent.getElementsByTagName(tagName)[0];
    return child && typeof child === 'object' ? String(child.textContent || '').trim() : '';
}

/**
 * @param {string} xml
 * @param {string} requestUrl
 * @param {string} rootDavUrl
 * @returns {DavEntry[]}
 */
export function parseDavMultistatus(xml, requestUrl, rootDavUrl = requestUrl) {
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    const responseNodes = [...document.getElementsByTagName('d:response')];
    /** @type {DavEntry[]} */
    const entries = [];
    for (const responseNode of responseNodes) {
        if (!(responseNode && typeof responseNode === 'object' && typeof responseNode.getElementsByTagName === 'function')) { continue; }
        const href = getFirstChildText(responseNode, 'd:href');
        if (href.length === 0) { continue; }
        const entryUrl = new URL(href, requestUrl).href;
        const propNode = responseNode.getElementsByTagName('d:prop')[0];
        const isDirectory = Boolean(propNode && typeof propNode.getElementsByTagName === 'function' && propNode.getElementsByTagName('d:collection').length > 0);
        const sizeText = getFirstChildText(propNode, 'd:getcontentlength');
        const sizeValue = sizeText.length > 0 ? Number(sizeText) : Number.NaN;
        entries.push({
            href,
            url: isDirectory ? normalizeDavDirectoryUrl(entryUrl) : entryUrl,
            relativePath: getShareRelativePath(rootDavUrl, entryUrl),
            isDirectory,
            size: Number.isFinite(sizeValue) ? sizeValue : null,
            contentType: normalizeText(getFirstChildText(propNode, 'd:getcontenttype')),
            lastModified: normalizeText(getFirstChildText(propNode, 'd:getlastmodified')),
        });
    }
    return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
}

/**
 * @param {string} value
 * @returns {string|null}
 */
function normalizeText(value) {
    const trimmed = String(value || '').trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function sanitizeCaseIdForPath(value) {
    const normalized = String(value || '').trim();
    return normalized.length > 0 ? normalized.replaceAll(/[^a-zA-Z0-9._-]+/g, '_') : 'item';
}

/**
 * @param {string} relativePath
 * @returns {DirectoryWorkItem}
 */
export function createDirectoryWorkItem(relativePath = '') {
    const trimmed = String(relativePath || '').replace(/^\/+/, '').replace(/\/+$/, '');
    const id = trimmed.length > 0 ? `dir:${trimmed}` : 'dir:.';
    return {
        type: 'directory',
        id,
        url: trimmed.length > 0 ? `${DEFAULT_FREEMDICT_DAV_URL}${encodePathSegments(trimmed)}/` : DEFAULT_FREEMDICT_DAV_URL,
        relativePath: trimmed,
    };
}

/**
 * @param {string} value
 * @returns {string}
 */
function encodePathSegments(value) {
    return value
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

/**
 * @param {string} rootDavUrl
 * @param {string} directoryUrl
 * @param {DavEntry[]} entries
 * @returns {WorkItem[]}
 */
export function discoverDirectoryWorkItems(rootDavUrl, directoryUrl, entries) {
    const directoryRelativePath = getShareRelativePath(rootDavUrl, directoryUrl);
    const directoryEntryUrl = normalizeDavDirectoryUrl(directoryUrl);
    const directoryEntries = entries.filter(({url}) => normalizeDavDirectoryUrl(url) !== directoryEntryUrl);
    /** @type {DavEntry[]} */
    const subdirectories = [];
    /** @type {DavEntry[]} */
    const files = [];
    for (const entry of directoryEntries) {
        if (entry.isDirectory) {
            subdirectories.push(entry);
        } else {
            files.push(entry);
        }
    }

    /** @type {CaseWorkItem[]} */
    const caseItems = [];
    /** @type {SkipWorkItem[]} */
    const skipItems = [];
    /** @type {Map<string, {mdxFiles: DavEntry[], mddFiles: DavEntry[]}>} */
    const mdxGroups = new Map();

    for (const file of files) {
        if (isZipSharePath(file.relativePath)) {
            caseItems.push({
                type: 'case',
                id: `zip:${file.relativePath}`,
                caseType: 'zip',
                relativePath: file.relativePath,
                matchText: file.relativePath,
                files: [entryToCaseFile(file)],
            });
            continue;
        }

        if (isMdxSharePath(file.relativePath) || isMddSharePath(file.relativePath)) {
            const groupKey = getMdxGroupKey(file.relativePath);
            if (groupKey === null) {
                skipItems.push(createSkipItem('unsupported-mdx-resource', file.relativePath, [file]));
                continue;
            }
            const group = mdxGroups.get(groupKey) || {mdxFiles: [], mddFiles: []};
            if (isMdxSharePath(file.relativePath)) {
                group.mdxFiles.push(file);
            } else {
                group.mddFiles.push(file);
            }
            mdxGroups.set(groupKey, group);
            continue;
        }

        skipItems.push(createSkipItem('unsupported-file-format', file.relativePath, [file]));
    }

    for (const [groupKey, group] of [...mdxGroups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
        if (group.mdxFiles.length === 1) {
            const [mdxFile] = group.mdxFiles;
            const groupedFiles = [
                mdxFile,
                ...group.mddFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en')),
            ];
            caseItems.push({
                type: 'case',
                id: `mdx:${mdxFile.relativePath}`,
                caseType: 'mdx',
                relativePath: mdxFile.relativePath,
                matchText: groupedFiles.map(({relativePath}) => relativePath).join('\n'),
                files: groupedFiles.map((file) => entryToCaseFile(file)),
            });
            continue;
        }

        const groupRelativePath = directoryRelativePath.length > 0 ? `${directoryRelativePath}/${groupKey}` : groupKey;
        if (group.mdxFiles.length === 0) {
            skipItems.push(createSkipItem('orphan-mdd-without-mdx', groupRelativePath, group.mddFiles));
            continue;
        }

        skipItems.push(createSkipItem('ambiguous-mdx-group', groupRelativePath, [
            ...group.mdxFiles,
            ...group.mddFiles,
        ]));
    }

    /** @type {DirectoryWorkItem[]} */
    const directoryItems = subdirectories
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'))
        .map((entry) => ({
            type: 'directory',
            id: `dir:${entry.relativePath}`,
            url: normalizeDavDirectoryUrl(entry.url),
            relativePath: entry.relativePath,
        }));

    caseItems.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
    skipItems.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));

    return [...caseItems, ...skipItems, ...directoryItems];
}

/**
 * @param {DavEntry} entry
 * @returns {CaseFile}
 */
function entryToCaseFile(entry) {
    return {
        url: entry.url,
        relativePath: entry.relativePath,
        size: entry.size,
        contentType: entry.contentType,
    };
}

/**
 * @param {string} reason
 * @param {string} relativePath
 * @param {DavEntry[]} files
 * @returns {SkipWorkItem}
 */
function createSkipItem(reason, relativePath, files) {
    const normalizedRelativePath = String(relativePath || '').trim();
    return {
        type: 'skip',
        id: `skip:${normalizedRelativePath}:${reason}`,
        reason,
        relativePath: normalizedRelativePath,
        matchText: [normalizedRelativePath, ...files.map(({relativePath: fileRelativePath}) => fileRelativePath)].join('\n'),
        files: files
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'))
            .map((file) => entryToCaseFile(file)),
    };
}

/**
 * @param {WorkItem} item
 * @param {string} match
 * @returns {boolean}
 */
export function matchesWorkItem(item, match) {
    const normalizedMatch = String(match || '').trim().toLowerCase();
    if (normalizedMatch.length === 0) { return true; }
    switch (item.type) {
        case 'directory':
            return item.relativePath.toLowerCase().includes(normalizedMatch);
        case 'case':
        case 'skip':
            return item.matchText.toLowerCase().includes(normalizedMatch);
        default:
            return true;
    }
}

/**
 * @param {DirectoryWorkItem} item
 * @param {string} match
 * @returns {boolean}
 */
export function shouldTraverseDirectory(item, match) {
    const normalizedMatch = String(match || '').trim().toLowerCase();
    if (normalizedMatch.length === 0) { return true; }
    const normalizedPath = item.relativePath.toLowerCase();
    if (normalizedPath.length === 0) { return true; }
    if (normalizedPath.includes(normalizedMatch) || normalizedMatch.includes(normalizedPath)) {
        return true;
    }
    return !(normalizedMatch.includes('/') || normalizedMatch.includes('\\'));
}

/**
 * @param {string[]} argv
 * @param {{stateFile: string, reportFile: string, tempDir: string}} defaults
 * @returns {ParsedCliArgs}
 */
export function parseCliArgs(argv, defaults) {
    /** @type {ParsedCliArgs} */
    const result = {
        resume: true,
        limit: null,
        match: '',
        stateFile: defaults.stateFile,
        reportFile: defaults.reportFile,
        tempDir: defaults.tempDir,
        keepFailed: false,
        help: false,
    };

    for (let index = 0; index < argv.length; ++index) {
        const argument = String(argv[index] || '');
        const nextValue = () => {
            index += 1;
            if (index >= argv.length) {
                throw new Error(`Missing value for ${argument}`);
            }
            return String(argv[index]);
        };
        if (argument === '--resume') {
            result.resume = true;
            continue;
        }
        if (argument === '--keep-failed') {
            result.keepFailed = true;
            continue;
        }
        if (argument === '--help' || argument === '-h') {
            result.help = true;
            continue;
        }
        if (argument === '--limit') {
            result.limit = parseLimit(nextValue());
            continue;
        }
        if (argument.startsWith('--limit=')) {
            result.limit = parseLimit(argument.slice('--limit='.length));
            continue;
        }
        if (argument === '--match') {
            result.match = nextValue();
            continue;
        }
        if (argument.startsWith('--match=')) {
            result.match = argument.slice('--match='.length);
            continue;
        }
        if (argument === '--state-file') {
            result.stateFile = nextValue();
            continue;
        }
        if (argument.startsWith('--state-file=')) {
            result.stateFile = argument.slice('--state-file='.length);
            continue;
        }
        if (argument === '--report-file') {
            result.reportFile = nextValue();
            continue;
        }
        if (argument.startsWith('--report-file=')) {
            result.reportFile = argument.slice('--report-file='.length);
            continue;
        }
        if (argument === '--temp-dir') {
            result.tempDir = nextValue();
            continue;
        }
        if (argument.startsWith('--temp-dir=')) {
            result.tempDir = argument.slice('--temp-dir='.length);
            continue;
        }
        throw new Error(`Unknown argument: ${argument}`);
    }

    return result;
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid --limit value: ${value}`);
    }
    return parsed;
}

/**
 * @template T
 * @param {string} filePath
 * @param {T} fallbackValue
 * @returns {Promise<T>}
 */
export async function loadJsonFile(filePath, fallbackValue) {
    try {
        const raw = await readFile(filePath, 'utf8');
        return /** @type {T} */ (JSON.parse(raw));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ENOENT/i.test(message)) {
            return fallbackValue;
        }
        throw error;
    }
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonFileAtomic(filePath, value) {
    const directory = path.dirname(filePath);
    await mkdir(directory, {recursive: true});
    const tempPath = `${filePath}.tmp`;
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(tempPath, payload, 'utf8');
    await rm(filePath, {force: true});
    await rename(tempPath, filePath);
}

/**
 * @param {string} tempDir
 * @param {{preserve: boolean}} options
 * @returns {Promise<void>}
 */
export async function cleanupCaseTempDir(tempDir, {preserve}) {
    if (preserve) { return; }
    await rm(tempDir, {recursive: true, force: true});
}

/**
 * @param {string} tempRoot
 * @param {{removeAll: boolean}} options
 * @returns {Promise<void>}
 */
export async function cleanupTempRoot(tempRoot, {removeAll}) {
    if (removeAll) {
        await rm(tempRoot, {recursive: true, force: true});
        return;
    }

    const stack = [tempRoot];
    /** @type {string[]} */
    const directories = [];
    while (stack.length > 0) {
        const current = /** @type {string} */ (stack.pop());
        directories.push(current);
        let entries;
        try {
            entries = await readdir(current, {withFileTypes: true});
        } catch (_) {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                stack.push(path.join(current, entry.name));
            }
        }
    }

    for (const directory of directories.sort((a, b) => b.length - a.length)) {
        try {
            const entries = await readdir(directory);
            if (entries.length === 0) {
                await rm(directory, {recursive: true, force: true});
            }
        } catch (_) {
            // Ignore cleanup races.
        }
    }
}

/**
 * @param {string|Uint8Array|ArrayBuffer} value
 * @returns {string}
 */
export function toText(value) {
    if (typeof value === 'string') { return value; }
    if (value instanceof Uint8Array) {
        return TEXT_DECODER.decode(value);
    }
    return TEXT_DECODER.decode(new Uint8Array(value));
}
