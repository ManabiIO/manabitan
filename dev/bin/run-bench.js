#!/usr/bin/env node
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

import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'path';

const nodeMajorVersion = Number.parseInt(process.versions.node.split('.')[0], 10);
if (!Number.isFinite(nodeMajorVersion) || nodeMajorVersion < 22) {
    console.error(
        `Benchmarks require Node.js 22 or newer. Detected ${process.version}. ` +
        'Use Node.js 22+ for deterministic benchmark collection.',
    );
    process.exit(1);
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, '..', '..');
const vitestBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const cliArgs = process.argv.slice(2);
const args = ['bench', '--root', 'benches', ...cliArgs];

const child = spawn(vitestBin, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
});

child.on('error', (error) => {
    console.error(error);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.exit(1);
    }
    process.exit(code ?? 1);
});
