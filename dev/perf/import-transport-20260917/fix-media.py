from pathlib import Path
p=Path('ext/js/dictionary/dictionary-importer.js')
s=p.read_text()
for field in ['expression','reading']:
    old=f'decodeUtf8Bytes(this._textDecoder, columnChunk.{field}BytesList[index])'
    new=f'decodeUtf8Bytes(this._textDecoder, row.{field}Bytes ?? columnChunk.{field}BytesList[index])'
    assert s.count(old)==1,(field,s.count(old))
    s=s.replace(old,new)
p.write_text(s)
