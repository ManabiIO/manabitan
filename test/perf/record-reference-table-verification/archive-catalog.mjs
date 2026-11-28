// Use the production catalog selector, including compact dense ZIP metadata.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function openSourceCatalog(sourceRoot, archive) {
    // The caller pins the CLI-selected checkout's complete runtime trees and files.
    // eslint-disable-next-line no-unsanitized/method
    const sourceModule = (file) => import(pathToFileURL(path.join(sourceRoot, file)).href);
    const {DictionaryImporter} = await sourceModule('ext/js/dictionary/dictionary-importer.js');
    // The bundled writer identity is essential: the production dense-entry
    // reader uses instanceof to admit its bounded native inline-text reader.
    const {TextWriter} = await sourceModule('ext/lib/zip.js');
    const importer = new DictionaryImporter(null);
    const {fileMap, zipReader, catalog} = await importer._getFilesFromArchive(archive);
    try {
        const entry = fileMap.get('index.json');
        assert(entry && typeof entry.getData === 'function');
        const index = JSON.parse(await entry.getData(new TextWriter(), {useWebWorkers: false}));
        const banks = [];
        for (const name of fileMap.keys()) {
            if (/^term_bank_\d+\.json$/.test(name)) { banks.push(fileMap.get(name)); }
        }
        banks.sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)));
        return {fileMap, zipReader, catalog, index, banks, entryCount: fileMap.size};
    } catch (error) {
        await zipReader.close();
        throw error;
    }
}

export const sourceManifest = (banks) => banks.map((bank) => [bank.filename,
    bank.offset,
    bank.compressedSize,
    bank.uncompressedSize,
    bank.compressionMethod,
    bank.signature]);

export const catalogSourceFiles = [
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/dense-zip-file-map.js',
    'ext/js/dictionary/dense-zip-filenames.js',
    'ext/lib/zip.js',
];
