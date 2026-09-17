from pathlib import Path

def edit(name,old,new,count=1):
 p=Path(name);s=p.read_text();assert s.count(old)==count,(name,old[:70],s.count(old));p.write_text(s.replace(old,new))
p='ext/js/dictionary/zstd-term-content.js'
edit(p,'this._workers.map(() => (/** @type {CompressionMessageBatch} */ ({jobs: [], transfers: []}))) : null;', 'this._workers.map(() => (/** @type {CompressionMessageBatch} */ ({jobs: [], transfers: []}))) :\n            null;',2)
edit(p,'const packet = /** @type {{type?: unknown, responses?: unknown}} */ (event.data);','const packetData = /** @type {unknown} */ (event.data);\n        const packet = /** @type {{type?: unknown, responses?: unknown}} */ (packetData);')
edit(p,'    /** @param {MessageEvent} event */\n    _onMessage(event)', '    /** @param {MessageEvent<unknown>} event */\n    _onMessage(event)')
edit(p,'this._onMessage(/** @type {MessageEvent} */ ({data: response}));','this._onMessage(/** @type {MessageEvent<unknown>} */ ({data: /** @type {unknown} */ (response)}));')
edit(p,'    /** */\n    close() {','''    /** @returns {{logicalJobs: number, messages: number, batchPackets: number, batchReplies: number}} */
    getTransportProfile() {
        return {...this._transportStats};
    }

    /** */
    close() {''')
edit(p,'return compressionPool === null ? null : {...compressionPool._transportStats};','return compressionPool === null ? null : compressionPool.getTransportProfile();')
p='ext/js/dictionary/zstd-term-content-compression-worker.js'
edit(p,'/** @param {Record<string, unknown>} data @param {Transferable[]} [values] */','''/**
     * @param {Record<string, unknown>} data
     * @param {Transferable[]} [values]
     */''')
edit(p,'await compressContent(/** @type {MessageEvent} */ ({data: job}), post);','await compressContent(/** @type {MessageEvent<unknown>} */ ({data: /** @type {unknown} */ (job)}), post);')
p='test/zstd-term-content-pool.test.js'
edit(p,'/** @param {Record<string, unknown>} message @returns {Record<string, unknown>} */','''/**
     * @param {Record<string, unknown>} message
     * @returns {Record<string, unknown>}
     */''')
edit(p,'/** @type {Record<string, unknown>[]} */ (message.jobs) : [message];','/** @type {Record<string, unknown>[]} */ (message.jobs) :\n            [message];')
print('Explicit unknown packet boundaries, diagnostic accessor and JSDoc formatting; unchanged compression algorithms')
