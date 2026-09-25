from pathlib import Path
import hashlib
import subprocess
import shutil

out = Path('builds/hash-round')
out.mkdir(parents=True, exist_ok=True)
p = Path('ext/js/dictionary/wasm/term-bank-parser.c')
assert hashlib.sha256(p.read_bytes()).hexdigest() == 'b65eebac1d7a83eeb6ae14969069afc376a0084ddb0f6ffa01a84d1266dde108'
shutil.copyfile(p, out / 'base.c')
shutil.copyfile('ext/lib/term-bank-parser.wasm', out / 'base.wasm')
subprocess.run(['git', 'apply', 'dev/perf/remaining-20260925/native-key.patch'], check=True)
assert hashlib.sha256(p.read_bytes()).hexdigest() == 'bd9f6754dcaa861af3c674a444c42b701088b852e1e60760efa49834235bc525'
p = Path('test/term-bank-wasm-parser.test.js')
s = p.read_text()
replacements = [
    ('expect(consumeLastTermBankWasmParseProfile()?.nativeStringPlanFallbackChunkCount).toBe(1);',
     'expect(consumeLastTermBankWasmParseProfile()?.nativeStringPlanFallbackChunkCount).toBe(0);'),
    ('encodes single-source native plans and leaves escaped plans to the fallback',
     'encodes single-source and escaped native plans with identical lookup bytes'),
    ('expect(escapedChunk.preparedLookupIndexes).toBeUndefined();',
     "expect(escapedChunk.preparedLookupIndexes?.get('0:2')?.bytes).toStrictEqual(encodePersistedTermLookupIndexFromPreinternedPlan(\n            escapedChunk.termRecordPreinternedPlan,\n            escapedChunk.readingEqualsExpressionList,\n            escapedChunk.sequenceList,\n            escapedChunk.rowCount,\n        ));"),
]
for old, new in replacements:
    assert s.count(old) == 1, old
    s = s.replace(old, new)
p.write_text(s)
subprocess.run(['npm', 'run', 'build:libs'], check=True)
shutil.copyfile('ext/js/dictionary/wasm/term-bank-parser.c', out / 'candidate.c')
shutil.copyfile('ext/lib/term-bank-parser.wasm', out / 'candidate.wasm')
(out / 'setup-note.txt').write_text('Initial run 36184891548 passed all 21 new native-key cases and 272 focused cases, but an old lookup test explicitly required escaped keys to have no native lookup result. The updated test requires exact byte equality against the JavaScript encoder instead. No runtime change and no timing observation preceded this correction. Initial outcomes are retained.\n')
