declare module 'dictionary-import-journal' {
    export type TermContentCheckpoint = {
        segments: Array<{fileName: string; fileLength: number}>;
    };

    export type TermRecordCheckpoint = {
        shards: Array<{fileName: string; fileLength: number}>;
    };

    export type DictionaryImportJournalRecord = {
        version: 1;
        sessionId: string;
        contentCheckpoint: TermContentCheckpoint;
        recordCheckpoint: TermRecordCheckpoint;
        createdAt: number;
    };
}
