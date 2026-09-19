/* SPDX-License-Identifier: GPL-3.0-or-later */
import type {FindTermsResult} from '../../types/ext/translator';
import type {Summary} from '../../types/ext/dictionary-importer';
import type {DictionaryCounts} from '../../types/ext/dictionary-database';

export const API_VERSION = 1;

export const STORAGE_LOCK = 'manabitan-web:complete-dictionary-storage:v1';

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export type DefaultChoice = 'unasked' | 'declined' | 'installed' | 'deleted';

export interface Preferences {
    version: 1;
    disabled: string[];
    defaultChoice: DefaultChoice;
    defaultTitle: string | null;
}

export interface Status {
    dictionaries: Summary[];
    preferences: Preferences;
    counts: DictionaryCounts;
    storage: {usage?: number, quota?: number, persisted: boolean};
}

export type Operation = 'open' | 'status' | 'lookup' | 'import' | 'delete' | 'enable' | 'default' | 'media' | 'close';

export interface Request {
    version: 1;
    id: number;
    operation: Operation;
    parameters: unknown;
}

export type Message = Request | {version: 1, id: number, operation: 'cancel'};

export interface Reply {
    version: 1;
    id: number;
    result?: unknown;
    error?: {name: string, message: string, code?: string};
    progress?: unknown;
}

export type LookupResult = FindTermsResult;

export class WebRuntimeError extends Error {
    /**
     *
     * @param code
     * @param message
     */
    constructor(public readonly code: string, message: string) {
        super(message); /**
                         *
                         */
        this.name = 'WebRuntimeError';
    }
}

/**
 *
 * @param value
 */
export function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 *
 * @param value
 * @param maximum
 */
export function text(value: unknown, maximum = 256): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
        throw new WebRuntimeError('invalid_request', 'Invalid dictionary request text');
    }
    return value;
}

/**
 *
 * @param value
 */
export function isRequest(value: unknown): value is Message {
    return record(value) && value.version === API_VERSION && Number.isSafeInteger(value.id) &&
        Number(value.id) > 0 && typeof value.operation === 'string' &&
        ['open', 'status', 'lookup', 'import', 'delete', 'enable', 'default', 'media', 'close', 'cancel'].includes(value.operation);
}
