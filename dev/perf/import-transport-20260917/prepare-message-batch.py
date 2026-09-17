from pathlib import Path
import subprocess
ROOT=Path.cwd()
TOOLS=Path(__file__).resolve().parent
s=(TOOLS/'select-balanced.py').read_text().replace('options.experimentalBalancedCompression === true ? -3 : JMDICT_COMPRESSION_LEVEL','JMDICT_COMPRESSION_LEVEL').replace('experimentalBalancedCompression','experimentalGenericSpanCompression')
s=s.replace("['experimentalZstdFast2','experimentalCompressionWorkers2','experimentalGenericSpanCompression']", "['experimentalZstdFast2','experimentalCompressionWorkers2']")
s=s.replace("print('Isolated balanced compression: trained level -3, generic level 1 with native span/envelope, unchanged four-worker scheduling; all other candidates excluded')", "print('Isolated generic packing: original compression levels and worker count retained')")
local=TOOLS/'select-exact.py';local.write_text(s)
subprocess.run(['python3',str(local)],check=True)

def edit(file,old,new,count=1):
 p=ROOT/file;s=p.read_text();assert s.count(old)==count,(file,old[:70],s.count(old));p.write_text(s.replace(old,new))

flag='experimentalCompressionBatchMessages'
edit('ext/js/dictionary/term-bank-experiments.js','    return Object.freeze({\n',f'    return Object.freeze({{\n        {flag}: options.{flag} === true,\n')
edit('types/ext/dictionary-importer.d.ts','export type ImportExperiments = {\n',f'export type ImportExperiments = {{\n    {flag}?: boolean;\n')
p='ext/js/dictionary/zstd-term-content.js'
edit(p,'const COMPRESSION_WORKER_COUNT = 4;', '/** @typedef {{jobs: Record<string, unknown>[], transfers: Transferable[]}} CompressionMessageBatch */\n\nconst COMPRESSION_WORKER_COUNT = 4;')
edit(p,'        const envelopeMsByWorker = new Float64Array(this._workers.length);', '''        const messageBatches = compressionExperiments.experimentalCompressionBatchMessages === true ?
            this._workers.map(() => (/** @type {CompressionMessageBatch} */ ({jobs: [], transfers: []}))) : null;
        const envelopeMsByWorker = new Float64Array(this._workers.length);''',2)
edit(p,'                [blockOffsets.buffer, blockSourceLengths.buffer],\n            );', '                [blockOffsets.buffer, blockSourceLengths.buffer],\n                messageBatches?.[workerIndex],\n            );')
edit(p,'        const sourceConsumed = Promise.all(jobs.map', '        this._flushMessageBatches(messageBatches);\n        const sourceConsumed = Promise.all(jobs.map')
edit(p,'        const chunks = await Promise.all(contents.map(async (content, index) => {','        const jobs = contents.map(async (content, index) => {')
edit(p,'                transfer,\n            );','                transfer,\n                messageBatches?.[workerIndex],\n            );')
edit(p,'        }));\n        return {chunks, envelopeMs: Math.max(0, ...envelopeMsByWorker)};', '        });\n        this._flushMessageBatches(messageBatches);\n        const chunks = await Promise.all(jobs);\n        return {chunks, envelopeMs: Math.max(0, ...envelopeMsByWorker)};')
edit(p,'    _dispatch(workerIndex, message, transfer) {\n        return this._startDispatch(workerIndex, message, transfer, false).completion;', '    _dispatch(workerIndex, message, transfer, batch = null) {\n        return this._startDispatch(workerIndex, message, transfer, false, batch).completion;')
edit(p,'    _dispatchWithSourceConsumed(workerIndex, message, transfer) {\n        const {sourceConsumed, completion} = this._startDispatch(workerIndex, message, transfer, true);','    _dispatchWithSourceConsumed(workerIndex, message, transfer, batch = null) {\n        const {sourceConsumed, completion} = this._startDispatch(workerIndex, message, transfer, true, batch);')
edit(p,'    _startDispatch(workerIndex, message, transfer, trackSourceConsumed) {','    _startDispatch(workerIndex, message, transfer, trackSourceConsumed, batch = null) {')
edit(p,'                this._workers[workerIndex].postMessage({id, ...message}, transfer);', '''                if (batch === null) {
                    this._workers[workerIndex].postMessage({id, ...message}, transfer);
                } else {
                    batch.jobs.push({id, ...message});
                    for (const value of transfer) { batch.transfers.push(value); }
                }''')
edit(p,'     * @param {Transferable[]} transfer\n     * @returns', '     * @param {Transferable[]} transfer\n     * @param {CompressionMessageBatch|null} [batch]\n     * @returns',2)
edit(p,'     * @param {boolean} trackSourceConsumed\n', '     * @param {boolean} trackSourceConsumed\n     * @param {CompressionMessageBatch|null} [batch]\n')
edit(p,'    /** */\n    close() {', '''    /** @param {CompressionMessageBatch[]|null} batches */
    _flushMessageBatches(batches) {
        if (batches === null) { return; }
        for (let index = 0; index < batches.length; ++index) {
            const {jobs, transfers} = batches[index];
            if (jobs.length === 0) { continue; }
            try {
                this._workers[index].postMessage({type: 'compression-batch', jobs}, transfers);
            } catch (error) {
                this._fail(error instanceof Error ? error : new Error(String(error)));
                return;
            }
        }
    }

    /** */
    close() {''')
edit(p,'    _onMessage(event) {\n        const rawData = /** @type {unknown} */ (event.data);\n', '''    _onMessage(event) {
        const packet = /** @type {{type?: unknown, responses?: unknown}} */ (event.data);
        if (packet?.type === 'compression-batch-results') {
            if (!Array.isArray(packet.responses) || packet.responses.some((response) => (
                response === null || typeof response !== 'object' ||
                !Number.isSafeInteger(response.id) ||
                (typeof response.type !== 'undefined' && response.type !== 'source-consumed')
            ))) {
                this._fail(new Error('Term content compression worker returned an invalid batch'));
                return;
            }
            for (const response of packet.responses) {
                this._onMessage(/** @type {MessageEvent} */ ({data: response}));
            }
            return;
        }
        const rawData = /** @type {unknown} */ (event.data);
''')
edit(p,"dictName === 'jmdict' ? (JMDICT_COMPRESSION_LEVEL) : 1", "dictName === 'jmdict' ? JMDICT_COMPRESSION_LEVEL : 1")
p='ext/js/dictionary/zstd-term-content-compression-worker.js'
edit(p,'''self.addEventListener('message', (event) => {
    void compressContent(event);
});''','''self.addEventListener('message', (event) => {
    if (event.data?.type === 'compression-batch') {
        void compressBatch(event.data.jobs);
    } else {
        void compressContent(event);
    }
});

/**
 * @param {unknown} jobs
 * @returns {Promise<void>}
 */
async function compressBatch(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) { return; }
    /** @type {Record<string, unknown>[]} */
    const responses = [];
    /** @type {Transferable[]} */
    const transfers = [];
    /** @param {Record<string, unknown>} data @param {Transferable[]} [values] */
    const post = (data, values = []) => {
        responses.push(data);
        for (const value of values) { transfers.push(value); }
    };
    for (const job of jobs) {
        await compressContent(/** @type {MessageEvent} */ ({data: job}), post);
    }
    self.postMessage({type: 'compression-batch-results', responses}, transfers);
}''')
edit(p,'''/** @param {MessageEvent} event */
async function compressContent(event) {''','''/**
 * @param {MessageEvent} event
 * @param {(data: Record<string, unknown>, transfers?: Transferable[]) => void} [post]
 */
async function compressContent(event, post = (data, transfers = []) => self.postMessage(data, transfers)) {''')
edit(p,"            self.postMessage({type: 'source-consumed', id});", "            post({type: 'source-consumed', id});")
edit(p,'        self.postMessage({id, compressed, envelopeMs}, [compressed]);','        post({id, compressed, envelopeMs}, [compressed]);')
edit(p,'        self.postMessage({id, error: `${error}`});','        post({id, error: `${error}`});')
edit('test/term-bank-experiments.test.js',"test.each(['experimentalGenericSpanCompression'])", "test.each(['experimentalGenericSpanCompression', 'experimentalCompressionBatchMessages'])")
with Path('test/zstd-term-content-pool.test.js').open('a') as f:
 f.write((TOOLS/'test-message-batches.js').read_text())
for name in ['ext/js/dictionary/zstd-term-content.js','ext/js/dictionary/zstd-term-content-compression-worker.js']:
 text=(ROOT/name).read_text()
 assert 'Fast2' not in text and 'Workers2' not in text and 'BalancedCompression' not in text
assert 'const JMDICT_COMPRESSION_LEVEL = -1;' in (ROOT/'ext/js/dictionary/zstd-term-content.js').read_text()
# Preserve the original ABBA validation, replace only the registered variant plan.
s=(TOOLS/'abba.mjs').read_text();a=s.index('const variants=');b=s.index('\nconst selected=',a)
s=s[:a]+"const variants={control:{},generic:{experimentalGenericSpanCompression:true},packets:{experimentalCompressionBatchMessages:true},both:{experimentalGenericSpanCompression:true,experimentalCompressionBatchMessages:true}}"+s[b:]
s=s.replace("'control,fast2,workers2,generic,both'", "'control,generic,packets,both'")
s=s.replace("base:'2f407e86fae0d3e39f506e6b1ce30886697698ea'", "base:'e6f85c1fb8fec871eef76363ac0ba3c59aff78f7'")
s=s.replace('storedRecordBytes:finalization.termRecordTotalWriteBytes,', 'storedContentBytes:finalization.termContentTotalWriteBytes,storedRecordBytes:finalization.termRecordTotalWriteBytes,')
(TOOLS/'packet-abba.mjs').write_text(s)
subprocess.run(['git','diff','--check'],check=True)
print('Two isolated default-off algorithms; trained level -1, generic level 1, four workers and block boundaries unchanged')
