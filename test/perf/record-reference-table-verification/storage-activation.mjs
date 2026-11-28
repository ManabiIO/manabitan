/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Self-contained so Playwright can serialize this exact function into the
// settings page. It runs after restart, lookup and media verification. It does
// not import extension modules, acquire a write handle, or modify OPFS.
export async function collectReferenceFormatActivation(options, suppliedRoot = null) {
    const {files, totalRows, requestedFlag, generationMedia = null} = options;
    const check = (condition, message) => {
        if (!condition) { throw new Error(`Reference-format activation: ${message}`); }
    };
    const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
    const hex = (bytes) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    const text = (bytes) => new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
    const digest = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const safeU64 = (data, offset) => {
        const value = data.getUint32(offset, true) + data.getUint32(offset + 4, true) * 0x100000000;
        check(integer(value), 'Unsafe uint64 header value');
        return value;
    };
    check(Array.isArray(files) && files.length > 0, 'Missing final inventory');
    check(integer(totalRows, 1) && totalRows < 0xffffffff, 'Invalid expected row count');
    check(typeof requestedFlag === 'boolean', 'Missing explicit flag state');
    const recordPrefix = 'manabitan-term-records/';
    const sqlitePrefix = 'manabitan/sqlite-sahpool-v1/.opaque/';
    const inventory = new Map();
    for (const file of files) {
        check(file !== null && typeof file === 'object' && typeof file.path === 'string' && integer(file.bytes), 'Invalid inventory entry');
        check(!inventory.has(file.path), 'Duplicate inventory path');
        const prefix = file.path.startsWith(recordPrefix) ? recordPrefix : sqlitePrefix;
        check(file.path.startsWith(prefix), 'Unexpected inventory namespace');
        const name = file.path.slice(prefix.length);
        check(name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'), 'Noncanonical inventory path');
        inventory.set(file.path, file);
    }
    const root = suppliedRoot ?? await navigator.storage.getDirectory();
    let readBytes = 0;
    const snapshots = new Map();
    const getFile = async (filePath) => {
        if (snapshots.has(filePath)) { return snapshots.get(filePath); }
        const expected = inventory.get(filePath);
        check(expected, 'File absent from final inventory');
        const parts = filePath.split('/');
        let directory = root;
        for (const part of parts.slice(0, -1)) { directory = await directory.getDirectoryHandle(part); }
        const handle = await directory.getFileHandle(parts.at(-1));
        const file = await handle.getFile();
        check(file.size === expected.bytes, 'File size changed after final inventory');
        const result = {handle, file, filePath};
        snapshots.set(filePath, result);
        return result;
    };
    const read = async (snapshot, start, length) => {
        check(integer(start) && integer(length) && length <= 4196, 'Invalid or unbounded header read');
        check(start <= snapshot.file.size && length <= snapshot.file.size - start, 'Truncated header or chunk');
        const bytes = new Uint8Array(await snapshot.file.slice(start, start + length).arrayBuffer());
        check(bytes.byteLength === length, 'Clipped file read');
        readBytes += length;
        return bytes;
    };
    const stable = async (snapshot, prefix) => {
        const current = await snapshot.handle.getFile();
        check(current.size === snapshot.file.size, 'File size changed during observation');
        const bytes = new Uint8Array(await current.slice(0, prefix.length).arrayBuffer());
        check(equal(bytes, prefix), 'Header changed during observation');
        readBytes += bytes.length;
    };
    const indexes = [];
    const chunks = [];
    const formatCounts = {'1': 0, '2': 0, '3': 0, '4': 0};
    const formatRows = {'1': 0, '2': 0, '3': 0, '4': 0};
    const descriptors = new Set();
    let actualRows = 0;
    let fieldBytes = 0;
    for (const file of files.filter((item) => item.path.startsWith(recordPrefix) && item.path.endsWith('.mbtr.mbti'))) {
        const snapshot = await getFile(file.path);
        const header = await read(snapshot, 0, 40);
        check(text(header.subarray(0, 8)) === 'MBTIDX11', 'Invalid authoritative index magic');
        const data = view(header);
        const descriptorPath = file.path.slice(0, -5);
        const descriptor = await getFile(descriptorPath);
        const descriptorHeader = await read(descriptor, 0, 26);
        check(text(descriptorHeader.subarray(0, 8)) === 'MBTRD16X', 'Invalid record descriptor magic');
        check(equal(descriptorHeader.subarray(8, 24), header.subarray(24, 40)), 'Descriptor generation mismatch');
        check(safeU64(data, 8) === descriptor.file.size, 'Descriptor length mismatch');
        check(!descriptors.has(descriptorPath), 'Repeated descriptor');
        descriptors.add(descriptorPath);
        const expectedChunks = data.getUint32(16, true);
        const expectedRows = data.getUint32(20, true);
        check(expectedChunks > 0 && expectedChunks <= expectedRows && expectedRows <= totalRows, 'Invalid file row/chunk counts');
        let cursor = 40;
        let fileRows = 0;
        const fileChunks = [];
        for (let index = 0; index < expectedChunks; ++index) {
            const offset = cursor;
            const chunkHeader = await read(snapshot, cursor, 40);
            const chunk = view(chunkHeader);
            const firstId = chunk.getUint32(0, true);
            const count = chunk.getUint32(4, true);
            const contentOffsetBase = safeU64(chunk, 8);
            const payloadBytes = chunk.getUint32(16, true);
            const baseBytes = chunk.getUint32(20, true);
            const format = chunk.getUint32(36, true);
            check(firstId > 0 && count > 0 && firstId + count - 1 < 0xffffffff && count <= totalRows, 'Invalid chunk row interval');
            check([1, 2, 3, 4].includes(format), 'Unsupported record-field format');
            check(baseBytes >= 32 && payloadBytes >= 16 + baseBytes + 32, 'Invalid lookup payload dimensions');
            cursor += 40;
            const payloadHeader = view(await read(snapshot, cursor, 16));
            check(payloadHeader.getUint32(0, true) === 0x37494c4d && [7, 8].includes(payloadHeader.getUint32(4, true)), 'Invalid lookup container header');
            check(payloadHeader.getUint32(8, true) === baseBytes && payloadHeader.getUint32(12, true) + 16 + baseBytes === payloadBytes, 'Lookup section length mismatch');
            check(payloadBytes <= snapshot.file.size - cursor, 'Truncated lookup payload');
            cursor += payloadBytes;
            let bytes = count * (format === 3 ? 16 : 12);
            let scoreCount = null;
            let referenceCount = null;
            if (format === 2 || format === 4) {
                const fields = view(await read(snapshot, cursor, format === 4 ? 20 : 16));
                check(fields.getUint32(0, true) === (format === 4 ? 0x3446524d : 0x3246524d), 'Invalid record-field magic');
                check(fields.getUint32(4, true) === count && fields.getUint32(12, true) === format, 'Record-field header mismatch');
                scoreCount = fields.getUint32(8, true);
                check(scoreCount > 0 && scoreCount < 0xffff, 'Invalid score-table count');
                if (format === 4) {
                    referenceCount = fields.getUint32(16, true);
                    check(referenceCount > 0 && referenceCount < 0xffff, 'Invalid reference-table count');
                    bytes = 20 + scoreCount * 4 + referenceCount * 4 + Math.ceil(referenceCount / 2) * 4 + count * 4;
                    check(bytes < 16 + scoreCount * 4 + count * 8, 'Reference fields must be strictly smaller');
                } else { bytes = 16 + scoreCount * 4 + count * 8; }
            }
            check(integer(bytes, 1) && bytes <= snapshot.file.size - cursor, 'Truncated record fields');
            cursor += bytes;
            const receipt = {path: file.path, offset, firstId, count, contentOffsetBase, payloadBytes, format, fieldBytes: bytes, scoreCount, referenceCount};
            chunks.push(receipt);
            fileChunks.push(receipt);
            ++formatCounts[format];
            formatRows[format] += count;
            fileRows += count;
            fieldBytes += bytes;
        }
        check(cursor === snapshot.file.size, 'Trailing or missing index data');
        check(fileRows === expectedRows, 'Index row count does not match chunks');
        actualRows += fileRows;
        await stable(snapshot, header);
        await stable(descriptor, descriptorHeader);
        indexes.push({path: file.path,
            bytes: file.bytes,
            rows: fileRows,
            chunks: fileChunks.length,
            descriptorPath,
            descriptorBytes: descriptor.file.size,
            generation: hex(header.subarray(24, 40)),
            headerSha256: await digest(header)});
    }
    check(indexes.length > 0 && actualRows === totalRows, 'Complete term row count mismatch');
    check(files.filter((file) => file.path.startsWith(recordPrefix)).length === indexes.length * 2, 'Unexpected or unpaired term-record file');
    const intervals = [...chunks].sort((a, b) => a.firstId - b.firstId);
    let nextId = 1;
    for (const chunk of intervals) {
        check(chunk.firstId === nextId, 'Noncontiguous or overlapping record IDs');
        nextId += chunk.count;
    }
    check(nextId === totalRows + 1, 'Final record ID mismatch');
    check(requestedFlag || formatCounts['4'] === 0, 'Format4 appeared with the experiment disabled');

    // Pinned SQLite SAH-pool layout: 512 path bytes, big-endian flags, two
    // native-little-endian digest words, then SQLite data at byte4096.
    // Never guess the installed floor from an anonymous pooled file or a stale
    // main header while WAL/rollback recovery could change its effective value.
    const sqliteFiles = [];
    let database = null;
    for (const file of files.filter((item) => item.path.startsWith(sqlitePrefix))) {
        const snapshot = await getFile(file.path);
        check(snapshot.file.size >= 4096, 'Truncated SAH-pool file');
        const header = await read(snapshot, 0, 524);
        const data = view(header);
        const flags = data.getUint32(512, false);
        const terminator = header.subarray(0, 512).indexOf(0);
        check(terminator >= 0 && terminator < 511, 'Unterminated SAH-pool path');
        check(header.subarray(terminator, 512).every((value) => value === 0), 'Nonzero SAH path padding');
        const logicalPath = text(header.subarray(0, terminator));
        let h1 = 0;
        let h2 = 0;
        if ((flags & 0x80) !== 0) {
            h1 = 3735928559;
            h2 = 1103547991;
            for (const value of header.subarray(0, 516)) {
                h1 = Math.imul(h1 ^ value, 2654435761);
                h2 = Math.imul(h2 ^ value, 104729);
            }
        }
        check(data.getUint32(516, true) === (h1 >>> 0) && data.getUint32(520, true) === (h2 >>> 0), 'Invalid SAH-pool association digest');
        const logicalBytes = snapshot.file.size - 4096;
        if (logicalPath.length === 0) {
            check(flags === 0 && logicalBytes === 0, 'Unassigned pool file contains data or flags');
        } else {
            check((flags & 8) === 0 && (flags & (0x100 | 0x800 | 0x4000 | 0x80000)) !== 0, 'Nonpersistent SAH association');
            check(['/dict.sqlite3', '/dict.sqlite3-journal', '/dict.sqlite3-wal'].includes(logicalPath), 'Unexpected associated SQLite file');
            check(!sqliteFiles.some((item) => item.logicalPath === logicalPath), 'Duplicate SQLite association');
            if (logicalPath === '/dict.sqlite3-wal') { check(logicalBytes === 0, 'Live WAL prevents main-header floor observation'); }
            if (logicalPath === '/dict.sqlite3-journal' && logicalBytes > 0) {
                const journal = await read(snapshot, 4096, 8);
                check(journal.every((value) => value === 0), 'Hot rollback journal prevents floor observation');
            }
            if (logicalPath === '/dict.sqlite3') {
                check(database === null && (flags & 0x100) !== 0, 'Invalid main-database association');
                const sqliteHeader = await read(snapshot, 4096, 100);
                check(text(sqliteHeader.subarray(0, 16)) === 'SQLite format 3\0', 'Invalid SQLite main header');
                const sqliteView = view(sqliteHeader);
                let pageSize = sqliteView.getUint16(16, false);
                if (pageSize === 1) { pageSize = 65536; }
                check(pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0, 'Invalid SQLite page size');
                check(sqliteHeader[18] === 1 && sqliteHeader[19] === 1, 'WAL-format main header is not admitted');
                check(sqliteHeader[20] < pageSize && sqliteHeader[21] === 64 && sqliteHeader[22] === 32 && sqliteHeader[23] === 32, 'Invalid SQLite payload fractions');
                const pages = sqliteView.getUint32(28, false);
                check(pages > 0 && pages * pageSize === logicalBytes, 'SQLite main-file page count mismatch');
                check(sqliteView.getUint32(24, false) === sqliteView.getUint32(92, false), 'SQLite page-count validity counter mismatch');
                const floor = sqliteView.getUint32(60, false);
                check(floor >= 10 && floor <= 13, 'Unexpected installed schema floor');
                const current = await snapshot.handle.getFile();
                const reread = new Uint8Array(await current.slice(4096, 4196).arrayBuffer());
                check(current.size === snapshot.file.size && equal(reread, sqliteHeader), 'SQLite main header changed during observation');
                readBytes += reread.length;
                database = {path: file.path, logicalPath, logicalBytes, pageSize, pages, floor, headerSha256: await digest(sqliteHeader)};
            }
        }
        await stable(snapshot, header);
        sqliteFiles.push({path: file.path, bytes: file.bytes, logicalPath, logicalBytes, flags, associationSha256: await digest(header)});
    }
    check(database !== null, 'No associated SQLite main database');
    const packedMedia = generationMedia !== null;
    if (packedMedia) {
        check(generationMedia.version === 2 && integer(generationMedia.count, 1) && integer(generationMedia.dataBytes, 1), 'Invalid published media descriptor');
    }
    const minimumFloor = Math.max(10, packedMedia ? 11 : 10, formatCounts['4'] > 0 ? 13 : 10);
    check(database.floor >= minimumFloor, 'Installed floor is below actual persisted formats');
    return {schemaVersion: 1,
        success: true,
        timingEligible: false,
        requestedFlag,
        totalRows: actualRows,
        chunks: chunks.length,
        formatCounts,
        formatRows,
        format4Rows: formatRows['4'],
        fieldBytes,
        indexBytes: indexes.reduce((sum, item) => sum + item.bytes, 0),
        floor: database.floor,
        minimumFloor,
        generationMedia,
        database,
        sqliteFiles,
        indexes,
        chunkHeaders: chunks,
        readBytes,
        boundary: 'Bounded read-only headers after ordinary browser restart, content probes, complete lookup digests and media validation; actual MBTI dimensions/generation linkage and stable associated SQLite main-header floor. Payload and field values are not decoded by this supplemental observer.'};
}
