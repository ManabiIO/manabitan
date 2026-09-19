from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PARSER = 'ext/js/dictionary/term-bank-wasm-parser.js'
OLD = '''                } finally {
                    result.consume?.();
                    delete chunk.releaseBorrowedContent;
                }
'''
NEW = '''                } finally {
                    try {
                        result.consume?.();
                    } finally {
                        delete chunk.releaseBorrowedContent;
                        // Fulfilled slots live until the whole import finishes.
                        // Retain progress/profile metadata, not consumed payloads.
                        result.chunk = null;
                        result.consume = null;
                    }
                }
'''


def prepare():
    path = ROOT / 'dev/perf/owned-handoff-20260918.py'
    text = path.read_text()
    replacements = [
        ('FILES = [BUILD, WORKER]', 'FILES = [BUILD, WORKER, ' + repr(PARSER) + ']'),
        ("default='private-owned,private-shared'", "default='release-only,owned-release'"),
        ("assert set(variants) <= {'private-owned', 'private-shared'}", "assert set(variants) <= {'release-only', 'owned-release'}"),
        ("allowed = {'lib/term-bank-parser.wasm', 'js/dictionary/term-bank-wasm-parser-worker.js'}",
         "allowed = {'lib/term-bank-parser.wasm', 'js/dictionary/term-bank-wasm-parser-worker.js', 'js/dictionary/term-bank-wasm-parser.js'}"),
        ("assert 'lib/term-bank-parser.wasm' in different", "assert 'js/dictionary/term-bank-wasm-parser.js' in different"),
    ]
    for old, new in replacements:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    begin = text.index('def configure(variant):')
    end = text.index('\ndef adjust_tests():', begin)
    replacement = '''def configure(variant):
    assert variant in ('baseline', 'release-only', 'owned-release')
    build, worker = original(BUILD), original(WORKER)
    if variant == 'owned-release':
        split = build.index('async function buildDictionaryWasm(out)')
        prefix, target = build[:split], build[split:]
        old = "            '-Wl,--shared-memory',\\n"
        assert target.count(old) == 1
        build = prefix + target.replace(old, '')
        old = 'resultChunk = copyWasmBackedColumnChunk(chunk, true);'
        assert worker.count(old) == 1
        worker = worker.replace(old, 'resultChunk = copyWasmBackedColumnChunk(chunk);')
    (ROOT / BUILD).write_text(build)
    (ROOT / WORKER).write_text(worker)
    parser = original(PARSER)
    if variant != 'baseline':
        assert parser.count(OLD) == 1
        parser = parser.replace(OLD, NEW)
    (ROOT / PARSER).write_text(parser)

'''
    text = text[:begin] + replacement + text[end:]
    text = text.replace('FILES = [BUILD, WORKER, ', 'PARSER = ' + repr(PARSER) + '\nOLD = ' + repr(OLD) + '\nNEW = ' + repr(NEW) + '\nFILES = [BUILD, WORKER, ', 1)
    output = path.with_name('bounded-handoff-driver-20260918.py')
    output.write_text(text)
    memory = path.with_name('owned-memory-20260918.py').read_text()
    old = "'owned-handoff-20260918.py'"
    assert memory.count(old) == 1
    memory = memory.replace(old, "'bounded-handoff-driver-20260918.py'")
    path.with_name('bounded-handoff-memory-20260918.py').write_text(memory)
    return output


if __name__ == '__main__':
    print(prepare())
