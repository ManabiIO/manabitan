/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Only classify confirmed browser-runtime capability failures as optional
 * skips. Dictionary lookup, import, and integrity failures are regressions,
 * even if appended diagnostics mention OPFS capabilities.
 * @param {string} message
 * @returns {string}
 */
export function getUnsupportedRuntimeSkipReason(message) {
    const text = String(message);
    if (
        text.includes('OPFS is required but unavailable') ||
        text.includes('no such vfs: opfs') ||
        text.startsWith('Firefox runtime does not satisfy opfs-sahpool prerequisites:') ||
        text.includes('opfs-sahpool runtime prerequisites are unavailable') ||
        text.includes('opfs-sahpool requires a DedicatedWorkerGlobalScope')
    ) {
        return 'Firefox automation runtime does not expose the required OPFS SyncAccessHandle worker surface in this local Selenium stack; skipping this lane locally without enabling any SQLite fallback.';
    }
    if (text.includes('background.service_worker is currently disabled')) {
        return 'Firefox automation runtime does not support MV3 background service workers in this local Selenium/browser stack; skipping this lane locally.';
    }
    if (
        text.includes('Failed to read marionette port') ||
        text.includes('Failed to decode response from marionette')
    ) {
        return 'Firefox automation runtime failed before extension startup in this local Selenium/Marionette stack; skipping this lane locally.';
    }
    return '';
}
