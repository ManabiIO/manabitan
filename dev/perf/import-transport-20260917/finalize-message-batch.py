from pathlib import Path
TOOLS=Path(__file__).resolve().parent

def edit(name,old,new,count=1):
 p=Path(name);s=p.read_text();assert s.count(old)==count,(name,old[:60],s.count(old));p.write_text(s.replace(old,new))

p='ext/js/dictionary/zstd-term-content.js'
edit(p,"     * @param {import('dictionary-importer').ImportExperiments} [options]\n", "     * @param {import('dictionary-importer').ImportExperiments} [options]\n",9) if False else None
# The unwrapped synchronous codec needs no flag; its optional argument exists only
# to keep the batch/fallback call contract uniform.
a=Path(p).read_text().index('export function compressTermContentZstd(content, dictName, options = {})')
s=Path(p).read_text();start=s.rfind('/**',0,a)
s=s[:start]+s[start:a].replace('[options]','[_options]')+s[a:].replace('export function compressTermContentZstd(content, dictName, options = {})','export function compressTermContentZstd(content, dictName, _options = {})',1)
Path(p).write_text(s)
edit(p,'        this._nextId = 1;', '        this._nextId = 1;\n        this._transportStats = {logicalJobs: 0, messages: 0, batchPackets: 0, batchReplies: 0};')
edit(p,'        const id = this._nextId++;', '        const id = this._nextId++;\n        ++this._transportStats.logicalJobs;')
edit(p,'                    this._workers[workerIndex].postMessage({id, ...message}, transfer);', '                    this._workers[workerIndex].postMessage({id, ...message}, transfer);\n                    ++this._transportStats.messages;')
edit(p,"                this._workers[index].postMessage({type: 'compression-batch', jobs}, transfers);", "                this._workers[index].postMessage({type: 'compression-batch', jobs}, transfers);\n                ++this._transportStats.messages;\n                ++this._transportStats.batchPackets;")
edit(p,"        if (packet?.type === 'compression-batch-results') {", "        if (packet?.type === 'compression-batch-results') {\n            ++this._transportStats.batchReplies;")
edit(p,'/**\n * @returns {Promise<void>}\n */\nexport async function initializeTermContentZstd()', '''/** @returns {{logicalJobs: number, messages: number, batchPackets: number, batchReplies: number}|null} */
export function getTermContentCompressionTransportProfile() {
    return compressionPool === null ? null : {...compressionPool._transportStats};
}

/**
 * @returns {Promise<void>}
 */
export async function initializeTermContentZstd()''')
edit('ext/js/dictionary/dictionary-database.js','    initializeTermContentZstd,','    initializeTermContentZstd,\n    getTermContentCompressionTransportProfile,')
edit('ext/js/dictionary/dictionary-database.js','                    compressionExperiments: this._termContentBlockStore.getDiagnostics().compressionExperiments,','                    compressionExperiments: this._termContentBlockStore.getDiagnostics().compressionExperiments,\n                    compressionTransport: getTermContentCompressionTransportProfile(),')
p=TOOLS/'packet-abba.mjs';s=p.read_text();old="        const signature={rows:parser.rows,"
assert s.count(old)==1
s=s.replace(old,"""        const transport=finalization.compressionTransport
        assert.ok(transport&&transport.logicalJobs>0&&transport.messages>0,'Missing actual compression transport receipt')
        if(entry.flags.experimentalCompressionBatchMessages===true){
            assert.ok(transport.batchPackets>0&&transport.batchPackets===transport.batchReplies,'Batch must reach the real compression worker and return')
            assert.ok(transport.messages<transport.logicalJobs,'No transport reduction occurred')
        }else assert.equal(transport.batchPackets,0)
        const signature={compressionJobs:transport.logicalJobs,rows:parser.rows,""")
p.write_text(s)
print('Actual worker packet receipts required; compression settings, workers, block plan and stored bytes invariant')
