#!/usr/bin/env python3
"""Audit retained media receipts without rerunning imports or corpus parsing.

Reads the locked archive directory, raw local headers, and the packed source
range to independently reproduce metadata/index/Blob digests. It does not
inflate term banks, run product modules, or repeat the native media CRC pass.
"""
import hashlib
import json
import re
import struct
import subprocess
import zlib
import zipfile
from pathlib import Path
from urllib.parse import urljoin

root = Path(__file__).resolve().parents[2]
out = Path(__file__).with_suffix('.json')
base = root / 'manabitan'
candidate = root / 'vndb-media-bookkeeping'
pack_path = root / 'vndb-bookkeeping-pack-parity.json'
projection_path = root / 'vndb-bookkeeping-projection-parity.json'
pack = json.loads(pack_path.read_text())
projection = json.loads(projection_path.read_text())
remote = json.loads(Path(__file__).with_name('media-components-pr863-identity.json').read_text())
lock = json.loads((base / 'test/perf/dictionaries.lock.json').read_text())['dictionaries']['vndb']
archive = base / 'builds/e2e-dictionary-cache' / lock['cacheFile']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def git(checkout, *args):
    return subprocess.check_output(['git', *args], cwd=checkout)


def file_digest(path, start=0, length=None):
    h = hashlib.sha256()
    with path.open('rb') as f:
        f.seek(start)
        while length is None or length > 0:
            b = f.read(1024 * 1024 if length is None else min(1024 * 1024, length))
            if not b:
                assert length in (None, 0)
                break
            h.update(b)
            if length is not None:
                length -= len(b)
    return h.hexdigest()


assert pack['status'] == projection['status'] == 'passed'
assert projection['fixture'] == lock
assert remote['head'] == 'ebb0777114578c5cee879877274e7d872bfea27e'
assert remote['tree'] == pack['candidate']['tree'] == '923cd36b875afbbee6e6674fd1b4450bed6ce362'
assert remote['base'] == pack['baseline']['head'] == 'd24b4e56ceb1fe14ad96ef3853f4d397efa6fa26'
assert remote['parents'] == [remote['base']]
assert archive.stat().st_size == pack['source']['bytes'] == lock['sizeBytes']
assert file_digest(archive) == pack['source']['sha256'] == lock['sha256']

identities = []
for label, checkout in [('baseline', base), ('candidate', candidate)]:
    recorded = next(x for x in projection['checkouts'] if x['label'] == label)
    assert git(checkout, 'rev-parse', 'HEAD').decode().strip() == pack[label]['head'] == recorded['head']
    assert git(checkout, 'rev-parse', 'HEAD^{tree}').decode().strip() == pack[label]['tree'] == recorded['tree']
    assert not git(checkout, 'diff', 'HEAD', '--name-only')
    importer_path = 'ext/js/dictionary/dictionary-importer.js'
    original = git(checkout, 'show', f"{recorded['head']}:{importer_path}")
    assert original == (checkout / importer_path).read_bytes()
    assert digest(original) == recorded['originalImporterSha256']
    uri = (checkout / importer_path).as_uri()
    parser_uri = urljoin(uri, './term-bank-wasm-parser.js')
    source = original.decode().replace('    parseTermBankWithWasmColumnChunks,\n', '    parseTermBankWithWasmColumnChunks as nativeParseTermBankWithWasmColumnChunks,\n')
    source = re.sub(r'''from (['"])([.][.]?/[^'"\n]+)\1''', lambda m: f'from {m[1]}{urljoin(uri, m[2])}{m[1]}', source)
    source = source.replace('import.meta.url', json.dumps(uri))
    source += f'\nimport {{copyWasmBackedColumnChunk as projectOwnedChunk}} from {json.dumps(parser_uri)}\n'
    source += 'async function parseTermBankWithWasmColumnChunks(source, version, onChunk, size, options) {\n'
    source += '    return await nativeParseTermBankWithWasmColumnChunks(source, version, async (chunk, progress) => {\n'
    source += '        const projected = projectOwnedChunk(chunk, false, true)\n'
    source += f'        globalThis.__vndbProjectionStats({json.dumps(label)}, projected)\n'
    source += '        await onChunk(projected, progress)\n'
    source += '    }, size, options)\n}\n'
    assert digest(source.encode()) == recorded['transportWrapperSha256']
    wasm = (checkout / 'ext/lib/term-bank-parser.wasm').read_bytes()
    assert wasm == git(checkout, 'show', f"{recorded['head']}:dev/data/dictionary-wasm/term-bank-parser.wasm")
    assert digest(wasm) == recorded['wasmSha256'] == '25149bac5db0dda3bba85fe8e133fb06d51881a822f27565e4587ba223dde41c'
    runtime_hashes = {}
    for name in ['dictionary-importer.js', 'source-zip-media-pack.js', 'term-bank-wasm-parser.js', 'term-bank-source-pipeline.js', 'dense-zip-directory.js', 'dictionary-generation-media-store.js']:
        relative = 'ext/js/dictionary/' + name
        data = (checkout / relative).read_bytes()
        assert data == git(checkout, 'show', f"{recorded['head']}:{relative}")
        runtime_hashes[relative] = digest(data)
    identities.append({**recorded, 'postRunTrackedTreeClean': True, 'currentRuntimeHashesMatchCommit': runtime_hashes, 'currentZipBundleSha256': digest((checkout / 'ext/lib/zip.js').read_bytes())})
assert identities[0]['currentZipBundleSha256'] == identities[1]['currentZipBundleSha256']

omit = {'label', 'denseGetDataTemporaryObjects', 'mediaOrderSortCalls', 'mediaOrderComparatorCalls'}
a, b = pack['runs']
assert a['label'] == 'baseline' and b['label'] == 'candidate'
assert {k: v for k, v in a.items() if k not in omit} == {k: v for k, v in b.items() if k not in omit}
assert [json.loads(x) for x in (root / 'vndb-bookkeeping-pack-parity.log').read_text().splitlines()][:-1] == pack['runs']

# Independent archive metadata and source-range digest checks; no decompression.
with zipfile.ZipFile(archive) as z:
    infos = z.infolist()
    media = [x for x in infos if re.fullmatch(r'img/cc[1-9][0-9]*[.]webp', x.filename)]
    banks = sorted((x for x in infos if re.fullmatch(r'term_bank_[0-9]+[.]json', x.filename)), key=lambda x: int(x.filename[10:-5]))
    assert len(infos) == a['catalogEntries'] == 147237
    assert len(media) == a['mediaEntries'] == lock['mediaFiles'] == 146570
    assert len(banks) == a['termBanks'] == len(projection['banks']) == 665
    assert [x.filename for x in banks] == [x['filename'] for x in projection['banks']]
    assert [x.filename for x in banks] == [f'term_bank_{i}.json' for i in range(1, 666)]
    assert all(x.file_size == y['sourceBytes'] for x, y in zip(banks, projection['banks']))
    assert sum(x.compress_size for x in media) == a['metrics']['compressedBytes']
    assert sum(x.file_size for x in media) == a['metrics']['uncompressedBytes'] == lock['mediaBytes']
    assert all(media[i].header_offset <= media[i + 1].header_offset for i in range(len(media) - 1))
    catalog_hash = hashlib.sha256()
    for entry in infos:
        raw_name = entry.filename.encode('ascii')
        assert not entry.flag_bits & 1
        catalog_hash.update((compact([entry.filename, entry.header_offset, entry.CRC, entry.compress_type, entry.compress_size, entry.file_size, False]) + '\n').encode())
        catalog_hash.update(raw_name)
    assert catalog_hash.hexdigest() == a['catalogSha256']
    # index.json is small; this is the only ZIP entry decoded by this audit.
    assert digest(z.read('index.json')) == a['sourceIndexJsonSha256']
    start = media[0].header_offset
    records_hash = hashlib.sha256()
    ids = [int(x.filename[6:-5]) for x in media]
    first, last = min(ids), max(ids)
    index = bytearray((last - first + 1) * 24)
    stored_bodies = 0
    with archive.open('rb') as raw:
        for entry, ident in zip(media, ids):
            raw.seek(entry.header_offset)
            header = raw.read(30)
            assert header[:4] == b'PK\x03\x04'
            name_length, extra_length = struct.unpack_from('<HH', header, 26)
            assert raw.read(name_length) == entry.filename.encode('ascii')
            raw.read(extra_length)
            payload_offset = raw.tell()
            prefix = raw.read(5)
            packed_offset = payload_offset - start
            packed_length = entry.compress_size
            method = entry.compress_type
            if method == 8 and len(prefix) == 5 and entry.compress_size - 5 == entry.file_size and entry.file_size <= 65535 and prefix[0] & 7 == 1:
                length, inverse = struct.unpack_from('<HH', prefix, 1)
                if length == entry.file_size and inverse == length ^ 65535:
                    packed_offset += 5
                    packed_length = entry.file_size
                    method = 0
                    stored_bodies += 1
            record = {'path': entry.filename, 'mediaType': 'image/webp', 'offset': entry.header_offset, 'compressedSize': entry.compress_size, 'uncompressedLength': entry.file_size, 'compressionMethod': method, 'packedOffset': packed_offset, 'packedLength': packed_length, 'signature': entry.CRC}
            records_hash.update((compact(record) + '\n').encode())
            struct.pack_into('<IIII', index, (ident - first) * 24, packed_offset + 1, packed_length | (0x80000000 if method == 8 else 0), entry.file_size, entry.CRC)
            end = payload_offset + entry.compress_size
    for i in range(last - first + 1):
        offset = i * 24
        struct.pack_into('<I', index, offset + 16, first + i)
        struct.pack_into('<I', index, offset + 20, zlib.crc32(index[offset:offset + 20]))
    assert end - start == a['packedBlobBytes']
    assert file_digest(archive, start, end - start) == a['packedBlobSha256']
    assert records_hash.hexdigest() == a['mediaRecordSha256']
    assert len(index) == a['planIndexBytes'] and digest(index) == a['planIndexSha256']
    assert a['planDescriptor'] == {'version': 2, 'prefix': 'img/cc', 'suffix': '.webp', 'firstId': first, 'slotCount': last - first + 1, 'count': len(media), 'dataBytes': end - start}

totals = {}
columns = ['rows', 'projectedRows', 'requirements', 'uniqueDeferred']
aggregate_hashes = {k: hashlib.sha256() for k in ['sourceSha256', 'columnsHash', 'requirementHash', 'diagnosticHash', 'deferredHash']}
for item in projection['banks']:
    left, right = item['runs']
    assert left['label'] == 'baseline' and right['label'] == 'candidate'
    assert {k: v for k, v in left.items() if k != 'label'} == {k: v for k, v in right.items() if k != 'label'}
    assert left['chunks'] == right['chunks'] == 1
    for key in aggregate_hashes:
        value = item[key] if key == 'sourceSha256' else left[key]
        assert re.fullmatch('[0-9a-f]{64}', value)
        aggregate_hashes[key].update((item['filename'] + '\0' + value + '\n').encode())
for role in ('baseline', 'candidate'):
    sums = {key: sum(next(x for x in item['runs'] if x['label'] == role)[key] for item in projection['banks']) for key in columns}
    assert {'label': role, **sums} == next(x for x in projection['totals'] if x['label'] == role)
    totals[role] = sums
assert totals['baseline'] == totals['candidate'] == {'rows': 6648310, 'projectedRows': 147186, 'requirements': 147186, 'uniqueDeferred': 146570}
assert projection['earlyDeferredDiagnosticErrors'][0]['errors'] == projection['earlyDeferredDiagnosticErrors'][1]['errors']
assert len(projection['earlyDeferredDiagnosticErrors'][0]['errors']) == 3
assert all(x['message'].startswith('Could not find image at path ') for x in projection['earlyDeferredDiagnosticErrors'][0]['errors'])
assert projection['structuralObjectLiteralReduction']['projectedEntryWrappers'] == totals['baseline']['projectedRows']
assert projection['structuralObjectLiteralReduction']['additionalRequirementAndSourceClonesInAllUniqueDeferredReplay'] == 2 * totals['baseline']['uniqueDeferred']
for item in [json.loads(line) for line in (root / 'vndb-bookkeeping-projection-parity.log').read_text().splitlines()]:
    if 'banksCompleted' in item:
        prefix = projection['banks'][:item['banksCompleted']]
        assert item['totalBanks'] == len(projection['banks'])
        assert item['rows'] == sum(x['runs'][0]['rows'] for x in prefix)
        assert item['projectedRows'] == sum(x['runs'][0]['projectedRows'] for x in prefix)
        assert item['uniqueMediaPaths'] == sum(x['runs'][0]['uniqueDeferred'] for x in prefix)
    else:
        assert item['status'] == 'passed' and item['totals'] == projection['totals']
        assert item['structuralObjectLiteralReduction'] == projection['structuralObjectLiteralReduction']

report = {
    'schema': 1,
    'status': 'passed with explicit provenance and scope limits',
    'method': 'Read-only code inspection, current frozen-tree and module hashing, log/receipt arithmetic, independent ZIP-directory/metadata/index and raw packed-range digest reconstruction. No dictionary imports, term-bank inflation, product module execution, native CRC rerun, or performance measurement.',
    'publishedIdentity': remote,
    'inputs': [{'path': p.name, 'bytes': p.stat().st_size, 'sha256': file_digest(p)} for p in [root / f'vndb-bookkeeping-{kind}-parity.{ext}' for kind in ('pack', 'projection') for ext in ('mjs', 'json', 'log')]],
    'sourceIdentities': identities,
    'archive': {'sha256': lock['sha256'], 'bytes': archive.stat().st_size, 'catalogEntries': len(infos), 'termBanks': len(banks), 'mediaEntries': len(media)},
    'independentPackedReconstruction': {'catalogSha256': catalog_hash.hexdigest(), 'mediaRecordSha256': records_hash.hexdigest(), 'packedBlobSha256': a['packedBlobSha256'], 'packedBlobBytes': end - start, 'sourceRangeStart': start, 'sourceRangeEnd': end, 'planIndexSha256': digest(index), 'planIndexBytes': len(index), 'singleStoredDeflateBodies': stored_bodies, 'descriptor': a['planDescriptor']},
    'projection': {'banks': len(projection['banks']), 'totalsRecomputedFromEveryBank': totals, 'aggregateReceiptDigests': {k: v.hexdigest() for k, v in aggregate_hashes.items()}, 'aggregateDigestEncoding': 'For each bank in numeric order: filename + NUL + recorded per-bank digest + newline; this audits receipt consistency, not independent source-bank decompression.', 'earlyDiagnosticSamples': 3},
    'enforcedCodeChecks': [
        'Packer selects every image entry accepted by the exact dense catalog; the retained count matches all 146570 locked media files.',
        'Every packed batch awaits the unmodified production native CRC/decoded-length validator before acceptance. The wrapper invokes inflate_zip_media_batch with every signature, rejects negative status and requires total decoded bytes to match.',
        'Packer receipt compares all metadata, descriptor, Blob digest and index digest; it also directly compares the complete baseline/candidate index arrays.',
        'Projection calls the real parser and importer for every bank; its wrapper changes only transport ownership and projects image paths to reproduce worker delivery.',
        'Projection hashes all selected typed columns, content slab/list bytes, preinterned plan arrays, and prepared lookup index bytes; the contentBytesBuffer field is a Uint8Array and is hashed as bytes.',
        'Per-bank requirement, diagnostic and deferred hashes are compared in order. Requirement shape/type is deliberately normalized across old nested and new flat representations.',
        'Owned exact-length diagnostic byte buffers are asserted. The first three retained diagnostics are exercised again after every later native bank call and their error messages compare exactly.',
    ],
    'workCounts': {'denseGetDataTemporaryObjectLiteralsRemoved': a['denseGetDataTemporaryObjects'] - b['denseGetDataTemporaryObjects'], 'copiedPhysicalOrderSortsRemoved': a['mediaOrderSortCalls'] - b['mediaOrderSortCalls'], 'sortComparatorCallsRemoved': a['mediaOrderComparatorCalls'] - b['mediaOrderComparatorCalls'], **projection['structuralObjectLiteralReduction']},
    'limits': [
        'Both scripts record Git heads; projection additionally records importer/wrapper/WASM hashes. Neither script enforces clean tracked state or rechecks all source/module hashes after execution. Pack records no loaded module hashes. This audit verifies current committed files and recorded projection hashes against exact PR863; it cannot retroactively prove source immutability throughout the original executions.',
        'Projection copies lock metadata but does not itself hash the whole archive. The separate pack run hashes that same file and this independent audit rehashed it against the exact VNDB lock; original mid-run archive immutability is not separately attested.',
        'Native media CRC and decoded-length validation is exhaustive in the inspected product path. The component does not decode image pixels/dimensions or independently compare every decoded media payload to another implementation.',
        'All 665 bank receipts agree for the selected columns/content/projections. The audit does not repeat bank decompression or independently derive every glossary/term semantic value; it checks ordered receipt digests and the script enforcement.',
        'Only three early diagnostic errors are exercised after arena reuse. Every diagnostic arena is hashed at its callback, but this is not an exhaustive delayed-error test.',
        'The 147186 entry-wrapper and 293140 extra-clone reductions belong to a one-bank-at-a-time, all-unique-deferred component replay. Browser grouping and prefetch/defer selection can change these counts. Object-literal executions are not allocated bytes, peak memory, or import latency.',
    ],
    'conclusion': 'The advertised parity and structural-work claims are supported within their stated component scope. Independent archive-derived catalog, record, packed-Blob and index digests match both arms. No observed source identity mismatch or parity failure; retain the provenance limits and do not present component counts as browser performance or memory gains.',
}
out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'status': report['status'], 'output': str(out), 'projectionRows': totals['baseline']['rows'], 'media': len(media), 'sha256': file_digest(out)}, indent=2))
