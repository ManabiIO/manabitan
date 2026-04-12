/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {log} from '../core/log.js';
import {reportDiagnostics} from '../core/diagnostics-reporter.js';
import {WebExtension} from '../extension/web-extension.js';
import {Backend} from './backend.js';

const backendStartupFailureStorageKey = 'manabitanLastBackendStartupError';

/**
 * @param {Record<string, unknown>|null} value
 * @returns {Promise<void>}
 */
async function persistBackendStartupFailure(value) {
    try {
        if (chrome.storage?.session && typeof chrome.storage.session.set === 'function') {
            await chrome.storage.session.set({[backendStartupFailureStorageKey]: value});
            return;
        }
    } catch (_) {
        // NOP
    }
    try {
        if (chrome.storage?.local && typeof chrome.storage.local.set === 'function') {
            await chrome.storage.local.set({[backendStartupFailureStorageKey]: value});
        }
    } catch (_) {
        // NOP
    }
}

/** Entry point. */
async function main() {
    const webExtension = new WebExtension();
    log.configure(webExtension.extensionName);
    let manifestVersion = '';
    let runtimeId = '';
    try {
        const manifest = chrome.runtime.getManifest();
        manifestVersion = typeof manifest.version === 'string' ? manifest.version : '';
        runtimeId = typeof chrome.runtime.id === 'string' ? chrome.runtime.id : '';
    } catch (_) {
        // NOP
    }
    reportDiagnostics('extension-start', {
        extensionName: webExtension.extensionName,
        manifestVersion,
        runtimeId,
    });

    const backend = new Backend(webExtension);
    try {
        await backend.prepare();
        await persistBackendStartupFailure(null);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error && typeof error.name === 'string' ? error.name : 'Error';
        const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
        reportDiagnostics('extension-startup-failure', {
            extensionName: webExtension.extensionName,
            manifestVersion,
            runtimeId,
            errorName: name,
            errorMessage: message,
            errorStack: stack,
        });
        await persistBackendStartupFailure({
            atIso: new Date().toISOString(),
            extensionName: webExtension.extensionName,
            manifestVersion,
            runtimeId,
            errorName: name,
            errorMessage: message,
            errorStack: stack,
        });
        log.error(error);
        throw error;
    }
}

void main();
