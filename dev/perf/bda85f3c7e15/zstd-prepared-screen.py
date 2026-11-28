"""Fixed native JMdict component screen. Does not change product or measure browser imports."""
import argparse
import ctypes as C
import hashlib
import json
import pathlib
import platform
import statistics
import time

parser = argparse.ArgumentParser()
parser.add_argument('--library', required=True)
parser.add_argument('--wrapper', required=True)
parser.add_argument('--blocks', required=True)
parser.add_argument('--dictionary', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = pathlib.Path(args.blocks)
manifest_path = root / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
assert manifest['rows'] == 528299 and manifest['uniqueRows'] == 362032
assert manifest['persistedHits'] == 3998 and manifest['packedBytes'] == 100300626
assert manifest['blockTargetBytes'] == 1048576 and len(manifest['blocks']) == 103
dictionary = pathlib.Path(args.dictionary).read_bytes()
assert hashlib.sha256(dictionary).hexdigest() == 'f384a821c2f122bde518ee8a513ea76cbe9876c3534fc1fff4cacdf1ecc509cb'
dictionary_buffer = C.create_string_buffer(dictionary)
z = C.CDLL(str(pathlib.Path(args.library).resolve()))
w = C.CDLL(str(pathlib.Path(args.wrapper).resolve()))
P, S, I, U = C.c_void_p, C.c_size_t, C.c_int, C.c_uint

def bind(lib, name, types, result=S):
    function = getattr(lib, name)
    function.argtypes, function.restype = types, result
    return function

version = bind(z, 'ZSTD_versionString', [], C.c_char_p)
is_error = bind(z, 'ZSTD_isError', [S], U)
error_name = bind(z, 'ZSTD_getErrorName', [S], C.c_char_p)
create = bind(z, 'ZSTD_createCCtx', [], P)
free = bind(z, 'ZSTD_freeCCtx', [P])
context_size = bind(z, 'ZSTD_sizeof_CCtx', [P])
create_decoder = bind(z, 'ZSTD_createDCtx', [], P)
free_decoder = bind(z, 'ZSTD_freeDCtx', [P])
bound = bind(z, 'ZSTD_compressBound', [S])
raw = bind(z, 'ZSTD_compress_usingDict', [P, P, S, P, S, P, S, I])
decompress = bind(z, 'ZSTD_decompress_usingDict', [P, P, S, P, S, P, S])
prepare = bind(w, 'manabitan_screen_prepare', [P, S], P)
cached = bind(w, 'manabitan_screen_compress', [P, P, P, S, P, S])
cache_size = bind(w, 'manabitan_screen_size', [P])
eligible = bind(w, 'manabitan_screen_eligible', [P, S], I)
free_cache = bind(w, 'manabitan_screen_free', [P], None)

def checked(result):
    if is_error(result):
        raise RuntimeError(error_name(result).decode())
    return result

blocks = []
group_indexes = {}
for record in manifest['blocks']:
    data = (root / record['filename']).read_bytes()
    assert len(data) == record['bytes']
    assert hashlib.sha256(data).hexdigest() == record['sha256']
    group = record['group']
    index = group_indexes.get(group, 0)
    group_indexes[group] = index + 1
    blocks.append((C.create_string_buffer(data), len(data), index % 4, record))
del data
maximum = max(length for _, length, _, _ in blocks)
destination = C.create_string_buffer(bound(maximum))
decoded = C.create_string_buffer(maximum)
decoder = create_decoder()
contexts = {name: [create() for _ in range(4)] for name in ['A', 'B', 'C']}
assert decoder and all(context for group in contexts.values() for context in group)
started = time.process_time_ns()
caches = [prepare(dictionary_buffer, len(dictionary)) for _ in range(4)]
setup_cpu_ms = (time.process_time_ns() - started) / 1e6
assert all(caches)

def compress(name, block):
    source, length, worker, _ = block
    context = contexts[name][worker]
    if name == 'B':
        return checked(cached(context, caches[worker], destination, len(destination), source, length))
    return checked(raw(context, destination, len(destination), source, length, dictionary_buffer, len(dictionary), -1))

def qualification():
    result = {}
    for name in ['A', 'B', 'C']:
        frames = []
        for block in blocks:
            source, length, worker, record = block
            size = compress(name, block)
            digest = hashlib.sha256(destination.raw[:size]).hexdigest()
            decoded_size = checked(decompress(decoder, decoded, len(decoded), destination, size, dictionary_buffer, len(dictionary)))
            assert decoded_size == length and decoded.raw[:length] == source.raw[:length], (name, record['filename'])
            frames.append({'filename': record['filename'], 'bytes': size, 'sha256': digest})
        result[name] = frames
    assert result['A'] == result['B'] == result['C'], 'Prepared context changed compressed bytes'
    return result['A']

before = qualification()
expected_bytes = sum(frame['bytes'] for frame in before)
assert expected_bytes == 12324804
orders = []
for block_index in range(6):
    orders.append({'kind': 'candidate', 'block': block_index, 'order': 'ABBA' if block_index % 2 == 0 else 'BAAB'})
    orders.append({'kind': 'control', 'block': block_index, 'order': 'ACCA' if block_index % 2 == 0 else 'CAAC'})
plan = {'warmups': ['ABC', 'CBA', 'BCA', 'ACB'], 'measured': orders}
output = pathlib.Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.with_suffix('.plan.json').write_text(json.dumps(plan, indent=2) + '\n')
runs = []

def run(name, warmup, kind, block_index, position):
    wall = time.perf_counter_ns()
    cpu = time.process_time_ns()
    total = 0
    for block in blocks:
        total += compress(name, block)
    result = {'name': name, 'warmup': warmup, 'kind': kind, 'block': block_index, 'position': position, 'cpuMs': (time.process_time_ns() - cpu) / 1e6, 'wallMs': (time.perf_counter_ns() - wall) / 1e6, 'compressedBytes': total}
    assert total == expected_bytes
    runs.append(result)
    print(json.dumps(result), flush=True)

for index, order in enumerate(plan['warmups']):
    for position, name in enumerate(order):
        run(name, True, 'warmup', index, position)
for entry in orders:
    for position, name in enumerate(entry['order']):
        run(name, False, entry['kind'], entry['block'], position)
after = qualification()
assert before == after
summary = {}
for kind in ['candidate', 'control']:
    pairs = []
    for block_index in range(6):
        row = [r for r in runs if not r['warmup'] and r['kind'] == kind and r['block'] == block_index]
        for start in [0, 2]:
            pair = row[start:start + 2]
            a = next(r for r in pair if r['name'] == 'A')
            b = next(r for r in pair if r['name'] != 'A')
            pairs.append({'block': block_index, 'start': start, 'cpuDeltaPercent': 100 * (b['cpuMs'] / a['cpuMs'] - 1), 'wallDeltaPercent': 100 * (b['wallMs'] / a['wallMs'] - 1)})
    summary[kind] = {'pairs': pairs, 'pairedCpuMedianPercent': statistics.median(p['cpuDeltaPercent'] for p in pairs), 'pairedWallMedianPercent': statistics.median(p['wallDeltaPercent'] for p in pairs), 'fasterCpuPairs': sum(p['cpuDeltaPercent'] < 0 for p in pairs)}
sha = lambda path: hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
report = {
    'scope': 'Native serial component only. Fixed six ABBA/BAAB blocks, interleaved identical-code controls, four warmup passes per arm. Four reusable contexts use actual within-group round-robin assignment. No full-import or browser claim.',
    'sourceCommit': '82d322c4973d9e2968d94047a40892bc6d9a9bdf',
    'version': version().decode(), 'python': platform.python_version(), 'platform': platform.platform(),
    'librarySha256': sha(args.library), 'wrapperSha256': sha(args.wrapper), 'runnerSha256': sha(__file__),
    'manifestSha256': sha(manifest_path), 'dictionarySha256': sha(args.dictionary),
    'fixture': manifest['fixture'], 'blockCountsByGroup': group_indexes, 'inputBytes': sum(b[1] for b in blocks),
    'eligibleBlocks': sum(eligible(caches[b[2]], b[1]) for b in blocks),
    'setupCpuMs': setup_cpu_ms, 'preparedContextBytes': sum(cache_size(c) for c in caches),
    'workingContextBytes': {name: sum(context_size(c) for c in group) for name, group in contexts.items()},
    'dictionaryLifetime': 'Benchmark-owned immutable16384-byte input is shared with prepared contexts. Production-owned snapshot would add16KiB per realm if immutability cannot be proven.',
    'compressedFrames': before, 'plan': plan, 'runs': runs, 'summary': summary,
}
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'summary': summary, 'preparedContextBytes': report['preparedContextBytes'], 'eligibleBlocks': report['eligibleBlocks']}), flush=True)
for cache in caches:
    free_cache(cache)
for group in contexts.values():
    for context in group:
        free(context)
free_decoder(decoder)
