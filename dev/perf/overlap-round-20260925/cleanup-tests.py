from pathlib import Path

p = Path('test/term-content-block-store.test.js')
s = p.read_text()
old = "import {describe, expect, test, vi} from 'vitest';"
new = "import {afterEach, describe, expect, test, vi} from 'vitest';"
assert s.count(old) == 1
s = s.replace(old, new)
old = "/** @typedef {NonNullable<Awaited<ReturnType<TermContentBlockStore['_tryAppendPacked']>>>} TermContentBlockAppendResult */"
new = """const defaultBeginSharedCompression = vi.mocked(beginCompressWrappedTermContentZstdSpansBatch).getMockImplementation();

// A failed admission assertion must not leak an unused one-shot fault into
// the next case. Preserve the mock factory's implementation after resetting.
afterEach(() => {
    const mock = vi.mocked(beginCompressWrappedTermContentZstdSpansBatch);
    mock.mockReset();
    if (typeof defaultBeginSharedCompression === 'function') {
        mock.mockImplementation(defaultBeginSharedCompression);
    }
});

""" + old
assert s.count(old) == 1
p.write_text(s.replace(old, new))
