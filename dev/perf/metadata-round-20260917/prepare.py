from pathlib import Path
import sys
root=Path.cwd()
modes=set(sys.argv[1:] or ['sparse','allocate','intern'])
assert modes and modes <= {'sparse','allocate','intern'}
flags={'sparse':'experimentalSparseMetadataSlots','allocate':'experimentalDenseMetadataAllocation','intern':'experimentalMetadataLastDictionary'}
fields={'sparse':'_sparseMetadataSlots','allocate':'_denseMetadataAllocation','intern':'_metadataLastDictionary'}
def replace(p,a,b,count=1):
 p=root/p;s=p.read_text();assert s.count(a)==count,(p,a[:70],s.count(a));p.write_text(s.replace(a,b))
db='ext/js/dictionary/dictionary-database.js'
options=', '.join(flags[m]+'?: boolean' for m in sorted(modes))
for m in sorted(modes):
 name=flags[m];field=fields[m]
 replace('ext/js/dictionary/term-bank-experiments.js','    return Object.freeze({\n',f'    return Object.freeze({{\n        {name}: options.{name} === true,\n')
 replace('types/ext/dictionary-importer.d.ts','export type ImportExperiments = {\n',f'export type ImportExperiments = {{\n    {name}?: boolean;\n')
 replace(db,'export class DictionaryDatabase {\n    constructor() {\n',f'export class DictionaryDatabase {{\n    constructor() {{\n        this.{field} = false;\n')
 replace(db,'    setImportOptimizationFlags(options = {}) {\n',f'    setImportOptimizationFlags(options = {{}}) {{\n        this.{field} = options.{name} === true;\n')
replace(db,'@param {{termContentStorageMode?:',f'@param {{{{{options}, termContentStorageMode?:')
imp='ext/js/dictionary/dictionary-importer.js'
for label in ['const importOptimizationFlags = {\n','const importOptimizationOptions = {\n']:
 replace(imp,label,label+''.join(f'            {flags[m]}: this._termBankExperiments.{flags[m]},\n' for m in sorted(modes)))
replace(imp,'@type {{termContentStorageMode:',f'@type {{{{{options}, termContentStorageMode:')
if 'sparse' in modes:
 replace(db,'        if (!forceRehash && this._termEntryContentMetaHashPairTable.length >= effectiveRequiredCount * 2) {','        const loadFactor = this._sparseMetadataSlots ? 4 : 2;\n        if (!forceRehash && this._termEntryContentMetaHashPairTable.length >= effectiveRequiredCount * loadFactor) {')
 replace(db,'        while (tableSize < effectiveRequiredCount * 2) {','        while (tableSize < effectiveRequiredCount * loadFactor) {')
if 'allocate' in modes:
 replace(db,'    _allocateTermEntryContentMetaIndex() {\n','''    _allocateTermEntryContentMetaIndex() {
        if (this._denseMetadataAllocation && this._termEntryContentMetaFreeIndexes.length === 0) {
            const index = this._termEntryContentMetaDenseCount;
            if (index >= this._termEntryContentMetaStateTable.length) {
                this._ensureTermEntryContentMetaDenseCapacity(index + 1);
            }
            ++this._termEntryContentMetaDenseCount;
            return index;
        }
''')
if 'intern' in modes:
 replace(db,'    _internTermEntryContentMetaDictName(value) {\n','''    _internTermEntryContentMetaDictName(value) {
        if (this._metadataLastDictionary) {
            const last = this._termEntryContentMetaDictNames.length - 1;
            if (last >= 0 && this._termEntryContentMetaDictNames[last] === value) { return last; }
        }
''')
replace(db,'                    termContentTotalWriteBytes,\n','                    termContentTotalWriteBytes,\n'+''.join(f'                    {flags[m]}: this.{fields[m]},\n' for m in sorted(modes)))
print('Metadata modes:', sorted(modes))
