// SPDX-License-Identifier: GPL-3.0-or-later
// Source-bound research harness. No production eligibility is synthesized here.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {readFile, writeFile, rename, readdir, open, stat} from 'node:fs/promises';
import path from 'node:path';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const asBytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
export const PROBE_GROUPS = new Set([0, 1, 2, 87, 91, 92, 105, 123, 126, 139]);
export const MIXED_GROUPS = [1, 87, 91, 92, 105, 123, 126, 139];
export const utf8 = new TextDecoder('utf-8', {ignoreBOM: true, fatal: true});

export async function hashFile(filename) {
    const digest = createHash('sha256'); let bytes = 0;
    for await (const part of createReadStream(filename)) { digest.update(part); bytes += part.length; }
    return {bytes, sha256: digest.digest('hex')};
}
export async function saveJson(filename, object) {
    const temporary = filename + '.checkpoint.tmp';
    await writeFile(temporary, JSON.stringify(object, null, 2) + '\n');
    await rename(temporary, filename);
}
export async function listFiles(root, relative = '') {
    const result = [];
    for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
        const name = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) { result.push(...await listFiles(root, name)); }
        else { assert(entry.isFile()); result.push(name); }
    }
    return result.sort();
}
export async function verifyBindings(config) {
    const git = (...args) => execFileSync('git', args, {cwd: config.root, encoding: 'utf8'}).trim();
    assert.equal(git('rev-parse', 'HEAD'), config.localHead, 'Actual local checkout changed');
    assert.equal(git('status', '--short'), config.localStatus, 'Actual local working state changed');
    assert.equal(sha(await readFile(config.planPath)), config.planSha256, 'Prospective plan changed');
    for (const [relative, hash] of Object.entries(config.sourceHashes)) {
        assert.equal(sha(await readFile(path.join(config.root, relative))), hash, 'Runtime changed: ' + relative);
    }
    for (const [relative, hash] of Object.entries(config.harnessHashes)) {
        assert.equal(sha(await readFile(new URL(relative, import.meta.url))), hash, 'Harness changed: ' + relative);
    }
    assert.equal(sha(await readFile(config.fixtureManifest)), config.fixtureManifestSha256);
}
export function planOffsets(plan) {
    if (plan.stringOffsets instanceof Uint32Array) { return plan.stringOffsets; }
    const result = new Uint32Array(plan.stringLengths.length); let cursor = 0;
    for (let index = 0; index < result.length; ++index) { result[index] = cursor; cursor += plan.stringLengths[index]; }
    assert.equal(cursor, plan.stringsBuffer.byteLength);
    return result;
}
export function keyAt(plan, offsets, index) {
    assert(Number.isInteger(index) && index >= 0 && index < offsets.length);
    return plan.stringsBuffer.subarray(offsets[index], offsets[index] + plan.stringLengths[index]);
}
function canonicalJson(value) {
    if (Array.isArray(value)) { return value.map(canonicalJson); }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
    }
    return value;
}
export function definitionDigest(bytes, raw) {
    const decoded = raw.decodeRawTermContentTokenBinary(bytes, utf8);
    assert(decoded !== null, 'Expected a raw-v6 logical definition');
    return createHash('sha256').update(JSON.stringify([
        decoded.rules, decoded.definitionTags, decoded.termTags, canonicalJson(JSON.parse(decoded.glossaryJson)),
    ])).digest();
}
export function rowDigest() {
    const digest = createHash('sha256');
    const fixed = Buffer.alloc(29);
    return {
        add({id, score, sequence, expression, reading, content}) {
            fixed.writeUInt32LE(id, 0); fixed.writeDoubleLE(score, 4);
            fixed.writeDoubleLE(typeof sequence === 'number' && sequence >= 0 ? sequence : -1, 12);
            fixed[20] = reading === null ? 1 : 0;
            fixed.writeUInt32LE(expression.length, 21); fixed.writeUInt32LE(reading?.length ?? 0, 25);
            digest.update(fixed); digest.update(expression); if (reading !== null) { digest.update(reading); }
            assert.equal(content.length, 32); digest.update(content);
        },
        finish() { return digest.digest('hex'); },
    };
}
export function describeInput(chunk, firstId, raw) {
    const plan = chunk.termRecordPreinternedPlan; assert(plan);
    const offsets = planOffsets(plan), content = [];
    const metadata = chunk.contentMetaList;
    assert.equal(chunk.contentMetaByUniqueIndex, true);
    assert(metadata instanceof Uint32Array);
    const count = chunk.contentDedupPlan.uniqueCount;
    for (let index = 0; index < count; ++index) {
        const start = chunk.contentBytesBaseOffset + metadata[index * 4];
        const length = metadata[index * 4 + 1];
        assert(start >= 0 && length > 0 && start + length <= chunk.contentBytesBuffer.byteLength);
        content.push(definitionDigest(chunk.contentBytesBuffer.subarray(start, start + length), raw));
    }
    const digest = rowDigest();
    for (let row = 0; row < chunk.rowCount; ++row) {
        const equals = chunk.readingEqualsExpressionList[row] === 1 || chunk.readingEqualsExpressionList[row] === true;
        digest.add({id: firstId + row, score: chunk.scoreList[row], sequence: chunk.sequenceList[row],
            expression: keyAt(plan, offsets, plan.expressionIndexes[row]),
            reading: equals ? null : keyAt(plan, offsets, plan.readingIndexes[row]),
            content: content[chunk.contentUniqueIndexList[row]],
        });
    }
    const prepared = [...chunk.preparedLookupIndexes].map(([range, value]) => ({range, bytes: value.bytes.length,
        sha256: sha(value.bytes), routeFilterSha256: value.routeFilter ? sha(asBytes(value.routeFilter)) : null}));
    return {logicalSha256: digest.finish(), prepared, nativeUniqueCount: count, keyCount: plan.stringLengths.length,
        keyBytes: plan.stringsBuffer.byteLength, sourceContentBytes: chunk.contentBytesBuffer.byteLength,
        sourceContentSha256: sha(chunk.contentBytesBuffer), columnTypes: {
            expression: plan.expressionIndexes.constructor.name, reading: plan.readingIndexes.constructor.name,
            score: chunk.scoreList.constructor.name, sequence: chunk.sequenceList.constructor.name,
        }};
}
export function reference(chunk, offsets, lengths, names, row) {
    const refs = chunk.resolvedContentReferences;
    const unique = refs?.uniqueIndexList[row];
    return {offset: refs ? refs.offsets[unique] : offsets[row], length: refs ? refs.lengths[unique] : lengths[row],
        name: typeof names === 'string' ? names : names[row]};
}
export function referenceKey({offset, length, name}) { return name + ':' + offset + ':' + length; }
export async function readRange(filename, offset, length) {
    const file = await open(filename, 'r');
    try {
        const bytes = new Uint8Array(length); let cursor = 0;
        while (cursor < length) { const result = await file.read(bytes, cursor, length - cursor, offset + cursor); assert(result.bytesRead > 0); cursor += result.bytesRead; }
        return bytes;
    } finally { await file.close(); }
}
export async function fileInventory(root) {
    const result = [];
    for (const file of await listFiles(root)) {
        const absolute = path.join(root, file);
        const actual = await hashFile(absolute);
        let normalizedSha256 = actual.sha256;
        if (file.endsWith('.mbtr') || file.endsWith('.mbti')) {
            const offset = file.endsWith('.mbtr') ? 8 : 24;
            const digest = createHash('sha256'); let cursor = 0;
            for await (const part of createReadStream(absolute)) {
                if (cursor <= offset + 15 && cursor + part.length > offset) {
                    const copy = Buffer.from(part); copy.fill(0, Math.max(0, offset - cursor), Math.min(part.length, offset + 16 - cursor)); digest.update(copy);
                } else { digest.update(part); }
                cursor += part.length;
            }
            normalizedSha256 = digest.digest('hex');
        }
        result.push({file, ...actual, normalizedSha256});
    }
    return result;
}
export async function writeCanonicalMetadata(db, filename) {
    const fields = ['Hash1', 'Hash2', 'State', 'Id', 'Offset', 'Length', 'DictNameId', 'SignaturePresent', 'Signature1', 'Signature2', 'Signature3', 'RecentSourceBatchId', 'RecentSourceOffset'];
    const types = ['u32', 'u32', 'u32', 'f64', 'f64', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32'];
    const count = db._termEntryContentMetaDenseCount, width = 60, bytes = Buffer.alloc(count * width);
    const normalized = createHash('sha256'); let published = 0;
    for (let index = 0; index < count; ++index) {
        let cursor = index * width;
        for (let field = 0; field < fields.length; ++field) {
            const value = db['_termEntryContentMeta' + fields[field] + 'Table'][index];
            if (types[field] === 'f64') { bytes.writeDoubleLE(value, cursor); cursor += 8; }
            else { bytes.writeUInt32LE(value, cursor); cursor += 4; }
        }
        assert.equal(cursor, (index + 1) * width);
        if (db._termEntryContentMetaStateTable[index] === 1) { ++published; }
        const row = Buffer.from(bytes.subarray(index * width, cursor)); row.fill(0, 20, 28); normalized.update(row);
    }
    assert.equal(published, db._termEntryContentMetaHashPairCount);
    assert.equal(db._termEntryContentMetaHashPairPendingCount, 0);
    await writeFile(filename, bytes, {flag: 'wx'});
    return {file: path.basename(filename), width, count, published, fields, types, names: db._termEntryContentMetaDictNames,
        ...await hashFile(filename), logicalMetadataSha256: normalized.digest('hex')};
}
