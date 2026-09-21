
    /**
     * @param {{dictionary: string, rowCount: number, expressionBytesList: Uint8Array[], readingBytesList: Uint8Array[], readingEqualsExpressionList: boolean[]|Uint8Array, scoreList: number[]|Int32Array|Float64Array, sequenceList: (number|undefined)[]|Int32Array, contentBytesList: Uint8Array[], contentHash1List?: number[]|Uint32Array, contentHash2List?: number[]|Uint32Array, contentBytesBuffer?: Uint8Array, contentBytesBaseOffset?: number, contentMetaList?: Uint32Array, contentDictNameList: ((string|null)[]|null), termRecordPreinternedPlan?: import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan|null, uniformContentDictName?: string|null, dictionaryTotalRows?: number}} chunk
     * @returns {Promise<void>}
     */
    async bulkAddArtifactTermsChunk(chunk) {
        this._lastBulkAddTermsMetrics = null;
        this._termEntryContentCache.clear();
        if (!this._bulkImportTransactionOpen) {
            this._termEntryContentIdByHash.clear();
            this._termEntryContentIdByKey.clear();
