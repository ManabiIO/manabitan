from pathlib import Path
p=Path('ext/js/background/backend.js')
s=p.read_text()
pairs=[("dictionaryTitle.trim() : ''", "dictionaryTitle : ''", 2), ("[probe.expression, probe.reading].map((value) => value.trim()).filter", "[probe.expression, probe.reading].filter", 1), ('probe.expression.trim().length > 0 ? probe.expression.trim() : probe.reading.trim()', 'probe.expression.length > 0 ? probe.expression : probe.reading', 1), ("String(dictionaryNameRaw || '').trim()", "String(dictionaryNameRaw || '')", 1)]
for a,b,n in pairs:
 assert s.count(a)==n,(a,s.count(a))
 s=s.replace(a,b)
p.write_text(s)
p=Path('ext/js/background/offscreen-dictionary-worker.js')
s=p.read_text(); a="String(dictionaryNameRaw || '').trim()"
assert s.count(a)==2
p.write_text(s.replace(a,"String(dictionaryNameRaw || '')"))
