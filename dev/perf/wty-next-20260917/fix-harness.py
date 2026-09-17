from pathlib import Path
import hashlib

# Benchmark-only correction. The checksum-pinned WTY first bank is 73,116,311
# UTF-8 bytes; the upstream probe's 32 MiB child-output cap rejects it after a
# successful import. Keep the cap bounded and still inspect all twelve probes.
p = Path('test/chromium/extension-two-dictionary-import.e2e.js')
source = p.read_text()
old = 'maxBuffer: 32 * 1024 * 1024'
assert source.count(old) == 2, source.count(old)
p.write_text(source.replace(old, 'maxBuffer: 256 * 1024 * 1024'))
print('Probe harness SHA-256:', hashlib.sha256(p.read_bytes()).hexdigest())
