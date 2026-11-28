"""Prospective read-only browser storage witness; never changes package files."""
from hashlib import sha256
from pathlib import Path

ORIGINAL_E2E_SHA256 = 'd0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf'
SQLITE_BUNDLE_SHA256 = '044a5844df842a96908eb9aa5542896ae6df174c23866f2c8573ded2ea5df9a2'
SQLITE_WRAPPER_SHA256 = '87faa573e4cb1cfcf36a304ea4eb6ff18f56f85b481c680a20d98661d451da14'
COLLECTOR = Path(__file__).with_name('storage-activation.mjs')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def overlay(original_source: str) -> str:
    """Insert the exact observer after existing restart/media/lookup checks."""
    require(isinstance(original_source, str), 'Expected original E2E source text')
    require(sha256(original_source.encode()).hexdigest() == ORIGINAL_E2E_SHA256,
            'E2E source identity changed; review a new prospective overlay')
    helper = COLLECTOR.read_text()
    exported = 'export async function collectReferenceFormatActivation('
    require(helper.count(exported) == 1, 'Missing unique observer export')
    helper = helper.replace(exported, 'async function collectReferenceFormatActivation(', 1)
    anchor = 'async function evalSendMessage(page, expression, arg = null) {'
    require(original_source.count(anchor) == 1, 'Missing unique observer helper anchor')
    source = original_source.replace(anchor, helper + '\n\n' + anchor, 1)
    anchor = '                report.benchmark.validation = {'
    require(source.count(anchor) == 1, 'Missing unique completed-storage receipt anchor')
    observation = """                report.referenceFormatActivation = {status: 'running'};
                try {
                    report.referenceFormatActivation = await page.evaluate(collectReferenceFormatActivation, {
                        files: storage.files.filter(({path}) => path.startsWith('manabitan-term-records/') || path.startsWith('manabitan/sqlite-sahpool-v1/.opaque/')),
                        totalRows: fixture.termRows,
                        requestedFlag: e2eImportFlags?.experimentalReferenceTableFields === true,
                        generationMedia: restartedInfo[0].generationMedia ?? null,
                    });
                } catch (error) {
                    report.referenceFormatActivation = {status: 'failed', error: errorMessage(error)};
                    throw error;
                }
"""
    source = source.replace(anchor, observation + anchor, 1)
    # The harness writes an explicit JSON projection, not the report object.
    # Retain the supplemental witness without changing standard validation.
    anchor = '        benchmark: report.benchmark,\n'
    require(source.count(anchor) == 1, 'Missing unique JSON report projection anchor')
    return source.replace(anchor, anchor + '        referenceFormatActivation: report.referenceFormatActivation,\n', 1)


def validate_activation(receipt: dict, expected: dict) -> dict:
    """Check the supplemental receipt without changing the standard schema.

    Required expected keys: floor, formatCounts, format4Rows, totalRows, chunks.
    Optional requestedFlag must be an actual bool when supplied. Zero-count
    format keys may be omitted from the expectation, but not invented formats.
    """
    require(isinstance(receipt, dict) and isinstance(expected, dict), 'Expected receipt and expectation objects')
    require(type(receipt.get('schemaVersion')) is int and receipt['schemaVersion'] == 1 and receipt.get('success') is True,
            'Missing successful activation receipt')
    require(receipt.get('timingEligible') is False, 'Storage witness is not timing evidence')
    integer = lambda value: type(value) is int and value >= 0
    for name in ('floor', 'format4Rows', 'totalRows', 'chunks'):
        require(integer(expected.get(name)) and integer(receipt.get(name)), f'Invalid {name}')
        require(receipt[name] == expected[name], f'Unexpected {name}: {receipt[name]} != {expected[name]}')
    require(10 <= receipt['floor'] <= 13 and receipt['chunks'] > 0 and receipt['totalRows'] > 0, 'Invalid installed floor or empty import')
    formats = {'1', '2', '3', '4'}
    expected_formats = expected.get('formatCounts')
    observed_formats = receipt.get('formatCounts')
    rows = receipt.get('formatRows')
    require(isinstance(expected_formats, dict) and set(expected_formats).issubset(formats), 'Invalid expected formats')
    require(isinstance(observed_formats, dict) and set(observed_formats) == formats, 'Invalid observed formats')
    require(isinstance(rows, dict) and set(rows) == formats, 'Invalid per-format rows')
    for key in formats:
        wanted = expected_formats.get(key, 0)
        require(integer(wanted) and integer(observed_formats[key]) and integer(rows[key]), 'Invalid format count')
        require(observed_formats[key] == wanted, f'Unexpected format{key} count')
        require((rows[key] == 0) == (observed_formats[key] == 0), 'Format rows/count presence differs')
    require(sum(observed_formats.values()) == receipt['chunks'], 'Format chunk totals differ')
    require(sum(rows.values()) == receipt['totalRows'] and rows['4'] == receipt['format4Rows'], 'Format row totals differ')
    require(type(receipt.get('requestedFlag')) is bool, 'Invalid requested flag receipt')
    if 'requestedFlag' in expected:
        require(type(expected['requestedFlag']) is bool and receipt['requestedFlag'] == expected['requestedFlag'], 'Requested flag changed')
    require(receipt['requestedFlag'] or observed_formats['4'] == 0, 'Format4 present when disabled')
    packed_media = receipt.get('generationMedia') is not None
    required_floor = max(10, 11 if packed_media else 10, 13 if observed_formats['4'] else 10)
    require(receipt.get('minimumFloor') == required_floor and receipt['floor'] >= required_floor, 'Installed floor misses persisted format')
    database = receipt.get('database')
    require(isinstance(database, dict) and database.get('logicalPath') == '/dict.sqlite3' and database.get('floor') == receipt['floor'],
            'Floor is not bound to the associated main database')
    chunks = receipt.get('chunkHeaders')
    indexes = receipt.get('indexes')
    require(isinstance(chunks, list) and len(chunks) == receipt['chunks'], 'Missing chunk headers')
    require(isinstance(indexes, list) and len(indexes) > 0, 'Missing final index receipts')
    for item in indexes:
        require(isinstance(item, dict) and isinstance(item.get('path'), str), 'Invalid index receipt')
        require(all(integer(item.get(key)) and item[key] > 0 for key in ('rows', 'chunks', 'bytes')), 'Invalid index dimensions')
    require(len({item['path'] for item in indexes}) == len(indexes), 'Duplicate index path')
    for item in chunks:
        require(isinstance(item, dict) and type(item.get('format')) is int and str(item['format']) in formats, 'Invalid chunk format')
        require(all(integer(item.get(key)) and item[key] > 0 for key in ('firstId', 'count', 'fieldBytes')), 'Invalid chunk dimensions')
        require(item.get('path') in {index['path'] for index in indexes}, 'Chunk is not bound to a final index')
    next_id = 1
    for item in sorted(chunks, key=lambda value: value['firstId']):
        require(item['firstId'] == next_id, 'Chunk record intervals are not contiguous')
        next_id += item['count']
    require(next_id == receipt['totalRows'] + 1, 'Final record interval differs')
    require(sum(item['rows'] for item in indexes) == receipt['totalRows'], 'Final index rows differ')
    require(sum(item['chunks'] for item in indexes) == receipt['chunks'], 'Final index chunks differ')
    require(sum(item['bytes'] for item in indexes) == receipt.get('indexBytes'), 'Final index bytes differ')
    require(sum(item['fieldBytes'] for item in chunks) == receipt.get('fieldBytes'), 'Field bytes differ')
    for key in formats:
        matching = [item for item in chunks if str(item['format']) == key]
        require(len(matching) == observed_formats[key] and sum(item['count'] for item in matching) == rows[key], 'Chunk header format totals differ')
    return {name: receipt[name] for name in ('floor', 'minimumFloor', 'requestedFlag', 'formatCounts', 'formatRows',
                                           'format4Rows', 'totalRows', 'chunks', 'fieldBytes', 'indexBytes')}
