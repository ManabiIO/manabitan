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

import {ExtensionError} from './extension-error.js';
import {toError} from './to-error.js';

const code = 'DICTIONARY_STORAGE_UNAVAILABLE';

/**
 * @param {unknown} cause
 * @returns {ExtensionError}
 */
export function createDictionaryStorageUnavailableError(cause) {
    const error = new ExtensionError(toError(cause).message);
    error.cause = cause;
    error.data = {code};
    return error;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isDictionaryStorageUnavailableError(error) {
    const data = error instanceof ExtensionError ? error.data : null;
    return typeof data === 'object' && data !== null && 'code' in data && data.code === code;
}
