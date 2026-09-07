/*
 * Copyright (C) 2026  Manabitan authors
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

import {readFileSync} from 'node:fs';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

/**
 * @param {string} name
 * @returns {string|null}
 */
function readCgroupFile(name) {
    if (process.platform !== 'linux') {
        return null;
    }
    try {
        return readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim() || null;
    } catch (_) {
        return null;
    }
}

/**
 * @param {string|null} value
 * @returns {number|null}
 */
function parseCgroupBytes(value) {
    if (value === null || value === 'max') {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * @param {string|null} cpuMax
 * @returns {number|null}
 */
function parseCpuQuotaCores(cpuMax) {
    if (cpuMax === null) {
        return null;
    }
    const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
    if (quotaRaw === 'max') {
        return null;
    }
    const quota = Number(quotaRaw);
    const period = Number(periodRaw);
    return Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0 ? quota / period : null;
}

/**
 * Returns stable environment metadata that belongs next to performance results.
 * Git metadata is intentionally excluded because exported/offline snapshots may
 * not contain a .git directory.
 * @returns {Record<string, unknown>}
 */
export function getHostEnvironment() {
    const cpus = os.cpus();
    const cgroupCpuMax = readCgroupFile('cpu.max');
    return {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus[0]?.model ?? null,
        logicalCpuCount: cpus.length,
        availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : null,
        totalMemoryBytes: os.totalmem(),
        cgroupCpuMax,
        cgroupCpuQuotaCores: parseCpuQuotaCores(cgroupCpuMax),
        cgroupMemoryMaxBytes: parseCgroupBytes(readCgroupFile('memory.max')),
        cgroupMemoryCurrentBytes: parseCgroupBytes(readCgroupFile('memory.current')),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log(JSON.stringify(getHostEnvironment(), null, 2));
}
