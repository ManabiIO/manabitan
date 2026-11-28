import hashlib
import json
import pathlib
import re
import struct
import sys
import zipfile

baseline, cache, capture, output = (pathlib.Path(value).resolve() for value in sys.argv[1:])
directory = pathlib.Path(__file__).resolve().parent
lock_path = baseline / 'test/perf/dictionaries.lock.json'
lock_bytes = lock_path.read_bytes()
assert hashlib.sha256(lock_bytes).hexdigest() == '60aa981791f3b60ca17588212aea5bd3536fb8f59288855e5accd019c6e4cf89'
fixture = json.loads(lock_bytes)['dictionaries']['jmdict']
assert fixture['sha256'] == '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f'
archive = cache / fixture['cacheFile']
archive_bytes = archive.read_bytes()
assert len(archive_bytes) == fixture['sizeBytes']
assert hashlib.sha256(archive_bytes).hexdigest() == fixture['sha256']
report_bytes = (capture / 'report.json').read_bytes()
report = json.loads(report_bytes)
assert report['complete'] is True
assert report['dictionary'] == 'jmdict'
assert report['fixture']['sha256'] == fixture['sha256']
assert report['lockSha256'] == hashlib.sha256(lock_bytes).hexdigest()
assert report['parserWasmSha256'] == '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee'
assert report['databaseSourceSha256'] == '75da1c10c8cefd238e17aaabb44fca71f39e2f4e412660420c1e675d9cc7b84b'
assert report['encodedByteSha256'] == '7dd16413a3775b36008a3b14bef7bd14272674a9edc1cc83eaf23ddd697d396b'
assert report['summary']['rows'] == 528299
assert report['summary']['groups'] == 12
expected_groups = json.loads((directory / 'source-groups.json').read_bytes())

def geometry(group):
    return {'files': group['files'], 'bytes': group['bytes']}

def first_bank(group):
    return int(re.fullmatch(r'term_bank_(\d+)\.json', group['files'][0])[1])

# Dispatch IDs are transient. Preserve the actual bank grouping and source
# order, independent of which worker first completed its asynchronous read.
observed_groups = sorted(report['sourceGroups'], key=first_bank)
assert [geometry(group) for group in observed_groups] == [geometry(group) for group in expected_groups]
entries = []
with zipfile.ZipFile(archive) as reader:
    for info in reader.infolist():
        match = re.fullmatch(r'term_bank_(\d+)\.json', info.filename)
        if match is None:
            continue
        assert info.compress_type == 8
        header = struct.unpack_from('<IHHHHHIIIHH', archive_bytes, info.header_offset)
        assert header[0] == 0x04034b50 and header[3] == 8
        offset = info.header_offset + 30 + header[9] + header[10]
        entries.append({'number': int(match[1]), 'name': info.filename, 'offset': offset,
                        'compressedBytes': info.compress_size, 'uncompressedBytes': info.file_size,
                        'crc32': info.CRC})
entries.sort(key=lambda entry: entry['number'])
assert len(entries) == 53
assert sum(entry['uncompressedBytes'] for entry in entries) == 171617523
result = {'dictionary': 'jmdict', 'fixture': fixture, 'archivePath': str(archive),
          'lockSha256': hashlib.sha256(lock_bytes).hexdigest(), 'entries': entries,
          'groups': expected_groups,
          'sourceGroupEvidence': {'captureReportSha256': hashlib.sha256(report_bytes).hexdigest(),
                                  'captureScriptSha256': report['scriptSha256'],
                                  'parserWasmSha256': report['parserWasmSha256'],
                                  'baselineCommit': '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'}}
with output.open('x') as stream:
    stream.write(json.dumps(result, indent=2) + '\n')
print(json.dumps({'complete': True, 'banks': len(entries), 'groups': len(expected_groups),
                  'fixtureSha256': fixture['sha256'], 'outputSha256': hashlib.sha256(output.read_bytes()).hexdigest()}))
