/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

/**
 * @param {import('backend').Mode} mode
 * @param {(url: string) => Promise<chrome.tabs.Tab>} createTab
 * @returns {Promise<void>}
 */
export async function openSettingsPage(mode, createTab) {
    const manifest = chrome.runtime.getManifest();
    const optionsUI = manifest.options_ui;
    if (typeof optionsUI === 'undefined') { throw new Error('Failed to find options_ui'); }
    const {page} = optionsUI;
    if (typeof page === 'undefined') { throw new Error('Failed to find options_ui.page'); }
    const url = chrome.runtime.getURL(page);
    switch (mode) {
        case 'existingOrNewTab':
            {
                /** @type {Error|null} */
                let openOptionsPageError = null;
                if (typeof chrome.runtime.openOptionsPage === 'function') {
                    try {
                        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
                            chrome.runtime.openOptionsPage(() => {
                                const e = chrome.runtime.lastError;
                                if (e) {
                                    reject(new Error(e.message));
                                } else {
                                    resolve();
                                }
                            });
                        }));
                        break;
                    } catch (error) {
                        openOptionsPageError = (error instanceof Error ? error : new Error(`${error}`));
                    }
                }
                try {
                    await createTab(url);
                } catch (error) {
                    if (openOptionsPageError !== null) {
                        const createTabError = (error instanceof Error ? error : new Error(`${error}`));
                        throw new Error(`Failed to open the options page directly or create a settings tab: ${openOptionsPageError.message}; ${createTabError.message}`);
                    }
                    throw error;
                }
            }
            break;
        case 'newTab':
            await createTab(url);
            break;
    }
}
