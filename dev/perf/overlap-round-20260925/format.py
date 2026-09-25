from pathlib import Path
import hashlib

p = Path('ext/js/dictionary/term-content-block-store.js')
s = p.read_text()
assert hashlib.sha256(s.encode()).hexdigest() == '353496180bf8626098e6fdb6b6a98a144b6c42f1107630591be8ba1b3aa2157c'
old = "            (compressionDictName !== 'jmdict' &&\n                !(force && this._compressionExperiments.experimentalGenericSpanCompression)) ||"
new = "            (compressionDictName !== 'jmdict' && !(force && this._compressionExperiments.experimentalGenericSpanCompression)) ||"
assert s.count(old) == 1
formatted = s.replace(old, new)
assert ''.join(s.split()) == ''.join(formatted.split())
assert hashlib.sha256(formatted.encode()).hexdigest() == '8b64e9d63cee8c6587dfc408c865928f852341b27d0c2b54326d64a1aee2bece'
p.write_text(formatted)
Path('builds/overlap-round/candidate.js').write_text(formatted)
