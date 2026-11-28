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

import {parseContentPhysicalFile} from './term-content-physical-file-store.js';

const REGION_BYTES = 128 * 1024 * 1024;
const MAX_REGIONS = 32768;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * Builds identity metadata for observed, closed files. File sizes determine
 * physical bounds only; logical addresses are supplied explicitly by the owner.
 * No bytes are copied and existing regions are never rounded or extended.
 * @param {string} namespace
 * @param {number} logicalStart
 * @param {number} logicalHighWater
 * @param {import('dictionary-import-journal').TermContentArenaFile[]} files
 * @returns {{regions: import('./term-content-storage-snapshots.js').ContentRootRegion[], layouts: Array<{layoutId: string, regionId: string, manifest: import('./term-content-layout.js').Manifest}>, files: Array<{fileId: string, path: string, byteLength: number}>}}
 * @throws {TypeError} If the input files do not exactly cover the logical interval.
 */
export function planContentIdentityLayouts(namespace, logicalStart, logicalHighWater, files) {
    if (!IDENTIFIER.test(namespace) || namespace.length > 96 ||
    !Number.isSafeInteger(logicalStart) || logicalStart < 0 ||
    !Number.isSafeInteger(logicalHighWater) || logicalHighWater < logicalStart ||
    !Array.isArray(files) || files.length > MAX_REGIONS) {
        throw new TypeError('Invalid content identity layout input');
    }
    /** @type {import('./term-content-storage-snapshots.js').ContentRootRegion[]} */
    const regions = [];
    /** @type {Array<{layoutId: string, regionId: string, manifest: import('./term-content-layout.js').Manifest}>} */
    const layouts = [];
    const observations = [];
    const fileIds = new Set();
    const paths = new Set();
    let cursor = logicalStart;
    for (const file of files) {
        const observed = parseContentPhysicalFile(file);
        if (fileIds.has(observed.fileId) || paths.has(observed.path) ||
        file.logicalStart !== cursor || !Number.isSafeInteger(file.logicalEnd) ||
        observed.byteLength > Number.MAX_SAFE_INTEGER - cursor ||
        file.logicalEnd !== cursor + observed.byteLength || file.logicalEnd > logicalHighWater) {
            throw new TypeError('Content identity files must uniquely cover their logical interval');
        }
        fileIds.add(observed.fileId);
        paths.add(observed.path);
        if (observed.byteLength === 0) { continue; }
        observations.push({fileId: observed.fileId, path: observed.path, byteLength: observed.byteLength});
        let physicalOffset = 0;
        while (physicalOffset < observed.byteLength) {
            if (regions.length >= MAX_REGIONS) { throw new RangeError('Content identity region directory exceeds its bound'); }
            const logicalLength = Math.min(REGION_BYTES, observed.byteLength - physicalOffset);
            const regionId = `${namespace}-r${regions.length}`;
            const layoutId = `${namespace}-l${regions.length}`;
            regions.push({regionId, layoutId, logicalStart: cursor, logicalLength});
            layouts.push({layoutId,
                regionId,
                manifest: {
                    version: 1,
                    regionId,
                    logicalStart: cursor,
                    logicalLength,
                    extents: [{logicalOffset: 0, length: logicalLength, fileId: observed.fileId, physicalOffset}],
                    blocks: [],
                    removed: [],
                }});
            cursor += logicalLength;
            physicalOffset += logicalLength;
        }
    }
    if (cursor !== logicalHighWater) { throw new TypeError('Content identity files do not reach logical high-water'); }
    return {regions, layouts, files: observations};
}
