/*
 * Copyright (C) 2026  Manabitan authors
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

import {reportDiagnostics} from './diagnostics-reporter.js';

/**
 * @returns {HTMLElement|null}
 */
function getDocumentElement() {
    const documentValue = Reflect.get(globalThis, 'document');
    const documentElement = /** @type {{documentElement?: unknown}|undefined} */ (documentValue)?.documentElement;
    return documentElement instanceof HTMLElement ? documentElement : null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function serializeValue(value) {
    try {
        return JSON.stringify(value);
    } catch (_) {
        return null;
    }
}

/**
 * @returns {boolean}
 */
function isDevBuild() {
    try {
        const manifest = chrome.runtime?.getManifest?.();
        return typeof manifest?.name === 'string' && manifest.name.includes('(dev)');
    } catch (_) {
        return false;
    }
}

/**
 * @returns {boolean}
 */
function shouldReportDevTimingSnapshot() {
    const globalFlag = Reflect.get(globalThis, 'manabitanDevReportTimingDiagnostics');
    if (globalFlag === true) {
        return true;
    }
    const documentElement = getDocumentElement();
    return documentElement?.dataset.manabitanDevReportTimingDiagnostics === 'true';
}

/**
 * @param {string} datasetKey
 * @param {unknown} payload
 * @param {string|null} [diagnosticsEvent]
 * @returns {void}
 */
export function publishDevTimingSnapshot(datasetKey, payload, diagnosticsEvent = null) {
    const documentElement = getDocumentElement();
    const serialized = serializeValue(payload);
    if (documentElement !== null) {
        if (serialized !== null) {
            Reflect.set(documentElement.dataset, datasetKey, serialized);
        } else {
            Reflect.deleteProperty(documentElement.dataset, datasetKey);
        }
    }

    if (diagnosticsEvent !== null && isDevBuild() && shouldReportDevTimingSnapshot()) {
        const diagnosticsPayload = (
            typeof payload === 'object' &&
            payload !== null &&
            !Array.isArray(payload)
        ) ?
            /** @type {Record<string, unknown>} */ (payload) :
            {value: payload};
        reportDiagnostics(diagnosticsEvent, diagnosticsPayload);
    }
}

/**
 * @param {string[]} datasetKeys
 * @returns {void}
 */
export function clearDevTimingSnapshots(datasetKeys) {
    const documentElement = getDocumentElement();
    if (documentElement === null) { return; }
    for (const datasetKey of datasetKeys) {
        Reflect.deleteProperty(documentElement.dataset, datasetKey);
    }
}
