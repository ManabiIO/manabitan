from pathlib import Path
import hashlib,json,sys
variant=sys.argv[1]
assert variant in ('media-inline64','media-inline256','dense-rehash')
if variant.startswith('media-'):
    source=Path('ext/js/dictionary/dictionary-importer.js')
    old="""        return await getData.call(entry, writer, {
            useWebWorkers: this._zipUseWebWorkers,
"""
    cap=64 if variant.endswith('64') else 256
    new="""        // Small images otherwise pay a ZIP worker round trip for each entry.
        // Keep large/unknown-size entries and the term-bank policy unchanged.
        const uncompressedSize = /** @type {unknown} */ (Reflect.get(entry, 'uncompressedSize'));
        const inlineMedia = (
            typeof uncompressedSize === 'number' &&
            Number.isSafeInteger(uncompressedSize) &&
            uncompressedSize >= 0 &&
            uncompressedSize <= CAP * 1024 &&
            getImageMediaTypeFromFileName(entry.filename) !== null
        );
        return await getData.call(entry, writer, {
            useWebWorkers: this._zipUseWebWorkers && !inlineMedia,
""".replace('CAP',str(cap))
    text=source.read_text();assert text.count(old)==1;source.write_text(text.replace(old,new))
    tests=[]
else:
    source=Path('ext/js/dictionary/dictionary-database.js')
    old="""        const oldSlotTable = this._termEntryContentMetaHashPairTable;
        const slotTable = new Uint32Array(tableSize);
        const mask = tableSize - 1;
        for (const encodedIndex of oldSlotTable) {
            if (encodedIndex === 0) { continue; }
            const index = encodedIndex - 1;
"""
    new="""        const slotTable = new Uint32Array(tableSize);
        const mask = tableSize - 1;
        for (let index = 0; index < this._termEntryContentMetaDenseCount; ++index) {
            const encodedIndex = index + 1;
"""
    text=source.read_text();assert text.count(old)==1;source.write_text(text.replace(old,new));tests=[]
print(json.dumps({'source':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'tests':tests}))
