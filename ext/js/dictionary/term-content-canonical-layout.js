/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

// Private ABI v1: the kernel owns only the reserved prefix, never table copies.
export const CANONICAL_SCAN_ABI_VERSION = 1;

export const CANONICAL_SCAN_MAX_ROWS = 100000;

export const TERM_CONTENT_METADATA_PREFIX_BYTES = 8388608;

export const CANONICAL_SCAN_EXACT_BATCH_SIZE = 4096;

const META = 131072;
const IDENT = META + CANONICAL_SCAN_MAX_ROWS * 16;
const ROWS = IDENT + CANONICAL_SCAN_MAX_ROWS * 4;
const SIGS = ROWS + CANONICAL_SCAN_MAX_ROWS * 4;
const FLAGS = SIGS + CANONICAL_SCAN_MAX_ROWS * 12;
const OUT = FLAGS + CANONICAL_SCAN_MAX_ROWS;
const JOURNAL = OUT + CANONICAL_SCAN_MAX_ROWS * 24;
const EXACT = JOURNAL + CANONICAL_SCAN_MAX_ROWS * 12;
const EPOCHS = EXACT + CANONICAL_SCAN_EXACT_BATCH_SIZE * 8;
const INDEXES = EPOCHS + CANONICAL_SCAN_MAX_ROWS * 4;

export const CANONICAL_SCAN_LAYOUT = Object.freeze({
    MAX: CANONICAL_SCAN_MAX_ROWS,
    PREFIX: TERM_CONTENT_METADATA_PREFIX_BYTES,
    META,
    IDENT,
    ROWS,
    SIGS,
    FLAGS,
    OUT,
    JOURNAL,
    EXACT,
    EPOCHS,
    INDEXES,
    usedBytes: INDEXES + CANONICAL_SCAN_MAX_ROWS * 4,
});
