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

/** Native exports used by the handwritten Zstd adapter. */
export interface ZstdModule {
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(pointer: number): void;
    _ZSTD_isError(code: number): number;
    _ZSTD_createCCtx(): number;
    _ZSTD_createDCtx(): number;
    _ZSTD_freeCCtx(context: number): number;
    _ZSTD_freeDCtx(context: number): number;
    _ZSTD_compressBound(size: number): number;
    _ZSTD_compress(destination: number, capacity: number, source: number, size: number, level: number): number;
    _ZSTD_compress_usingDict(context: number, destination: number, capacity: number, source: number, size: number, dictionary: number, dictionarySize: number, level: number): number;
    _ZSTD_decompress(destination: number, capacity: number, source: number, size: number): number;
    _ZSTD_decompress_usingDict(context: number, destination: number, capacity: number, source: number, size: number, dictionary: number, dictionarySize: number): number;
    _ZSTD_getFrameContentSize(source: number, size: number): bigint;
    _manabitan_write_block_envelope(destination: number, size: number): number;
}

export default function createZstdModule(options: {locateFile?(fileName: string): string, wasmBinary?: Uint8Array}): Promise<ZstdModule>;
