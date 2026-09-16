/**
 * Reads one bounded ZIP entry from an immutable Blob without materializing the
 * complete archive. The established reader retains all local-header checks and
 * creates the independently transferable payload. Oversized entries stay on the
 * ordinary ZIP path; this experiment does not raise any single-read budget.
 */
export class RangeZipPayloadReader {
    /** @param {Blob} archiveContent */
    constructor(archiveContent) {
        /** @type {Blob} */
        this._archiveContent = archiveContent
    }

    /**
     * @param {ArrayBuffer|Blob} archiveContent
     * @param {TermBankSourceFile[]} files
     * @returns {boolean}
     */
    static supportsArchive(archiveContent, files) {
        return archiveContent instanceof Blob &&
            Number.isSafeInteger(archiveContent.size) &&
            archiveContent.size >= ZIP_LOCAL_FILE_HEADER_LENGTH &&
            files.length > 0 && files.every((file) => {
                const size = /** @type {unknown} */ (Reflect.get(file, 'compressedSize'))
                // The local name and extra field are independently uint16.
                return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 &&
                    size <= RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES - ZIP_LOCAL_FILE_HEADER_LENGTH - 2 * 0xffff
            })
    }

    /**
     * @param {TermBankSourceFile} file
     * @param {AbortSignal} signal
     * @returns {Promise<Uint8Array>}
     */
    async read(file, signal) {
        signal.throwIfAborted()
        const archive = this._archiveContent
        const offset = /** @type {unknown} */ (Reflect.get(file, 'offset'))
        const compressedSize = /** @type {unknown} */ (Reflect.get(file, 'compressedSize'))
        const compressionMethod = /** @type {unknown} */ (Reflect.get(file, 'compressionMethod'))
        if (
            typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
            typeof compressedSize !== 'number' || !Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
            (compressionMethod !== 0 && compressionMethod !== 8) ||
            offset > archive.size - ZIP_LOCAL_FILE_HEADER_LENGTH
        ) {
            throw new Error(`Raw ZIP metadata is invalid for '${file.filename}'`)
        }
        const header = await archive.slice(offset, offset + ZIP_LOCAL_FILE_HEADER_LENGTH).arrayBuffer()
        signal.throwIfAborted()
        if (header.byteLength !== ZIP_LOCAL_FILE_HEADER_LENGTH) {
            throw new Error(`Raw ZIP local header is truncated for '${file.filename}'`)
        }
        const view = new DataView(header)
        const entrySize = ZIP_LOCAL_FILE_HEADER_LENGTH + view.getUint16(26, true) + view.getUint16(28, true) + compressedSize
        if (entrySize > RAW_ZIP_WHOLE_ARCHIVE_MAX_BYTES || entrySize > archive.size - offset) {
            throw new Error(`Raw ZIP payload is out of bounds for '${file.filename}'`)
        }
        const bytes = await archive.slice(offset, offset + entrySize).arrayBuffer()
        signal.throwIfAborted()
        if (bytes.byteLength !== entrySize) {
            throw new Error(`Raw ZIP payload is truncated for '${file.filename}'`)
        }
        const localReader = new RawZipPayloadReader(bytes)
        return await localReader.read({
            filename: file.filename,
            offset: 0,
            compressedSize,
            compressionMethod,
            ...('rawFilename' in file ? {rawFilename: Reflect.get(file, 'rawFilename')} : {}),
        }, signal)
    }
}
