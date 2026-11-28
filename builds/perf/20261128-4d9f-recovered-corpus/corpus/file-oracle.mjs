import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readdir} from 'node:fs/promises';
import path from 'node:path';

// Exact original current-codec JMdict file oracle, including independent
// record/index generation linkage. Random generation bytes alone are masked.
export async function digestStoredFiles(root, saveRaw = null) {
    const rawFiles = [];
    const files = [];
    const generations = new Map();
    async function visit(relative) {
        const entries = await readdir(path.join(root, relative), {withFileTypes: true});
        entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
        for (const entry of entries) {
            const filename = path.join(relative, entry.name);
            if (entry.isDirectory()) {
                await visit(filename);
                continue;
            }
            const record = filename.startsWith('manabitan-term-records/') && filename.endsWith('.mbtr');
            const index = filename.startsWith('manabitan-term-records/') && filename.endsWith('.mbtr.mbti');
            const generationOffset = record ? 8 : (index ? 24 : null);
            const magic = record ? 'MBTRD16X' : (index ? 'MBTIDX11' : null);
            const hash = createHash('sha256');
            const rawHash = createHash('sha256');
            let bytes = 0;
            let generation;
            for await (const chunk of createReadStream(path.join(root, filename))) {
                rawHash.update(chunk);
                if (bytes === 0 && generationOffset !== null) {
                    assert(chunk.byteLength >= generationOffset + 16);
                    assert.equal(chunk.subarray(0, 8).toString('utf8'), magic);
                    generation = chunk.subarray(generationOffset, generationOffset + 16).toString('hex');
                    hash.update(chunk.subarray(0, generationOffset));
                    hash.update(new Uint8Array(16));
                    hash.update(chunk.subarray(generationOffset + 16));
                } else { hash.update(chunk); }
                bytes += chunk.byteLength;
            }
            if (generationOffset !== null) {
                assert(generation);
                const recordPath = index ? filename.slice(0, -'.mbti'.length) : filename;
                const pair = generations.get(recordPath) ?? {};
                pair[index ? 'index' : 'record'] = generation;
                generations.set(recordPath, pair);
            }
            rawFiles.push({path: filename, bytes, sha256: rawHash.digest('hex'), generation});
            files.push({path: filename,
                bytes,
                sha256: hash.digest('hex'),
                normalizedGenerationRange: generationOffset === null ? null : [generationOffset, generationOffset + 16]});
        }
    }
    await visit('');
    for (const pair of generations.values()) {
        assert(pair.record && pair.index);
        assert.equal(pair.record, pair.index);
    }
    if (saveRaw !== null) { await saveRaw({files: rawFiles, generations: [...generations]}); }
    return {files, shardCount: generations.size, generationLinkageVerified: true};
}
