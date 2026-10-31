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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {execFileSync} from 'node:child_process';
import {realpathSync, renameSync} from 'node:fs';
import path from 'node:path';

/**
 * Move an owned fixture to its fresh Trash destination. CI may mount the
 * temporary directory and home on different filesystems; mv handles EXDEV.
 * @param {string} source
 * @param {string} destination
 */
export function moveFixtureToTrash(source, destination) {
    const resolvedSource = realpathSync(source);
    const resolvedDestination = path.join(realpathSync(path.dirname(destination)), path.basename(destination));
    try {
        renameSync(resolvedSource, resolvedDestination);
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) {
            throw error;
        }
        execFileSync('mv', ['--', resolvedSource, resolvedDestination]);
    }
}
