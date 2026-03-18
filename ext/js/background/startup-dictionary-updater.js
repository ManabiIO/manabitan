/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

export class StartupDictionaryUpdater {
    /**
     * @param {{
     *   isEnabled: () => Promise<boolean>,
     *   hasRunThisSession: () => Promise<boolean>,
     *   markRunThisSession: () => Promise<void>,
     *   getDictionaryInfo: () => Promise<import('dictionary-importer').Summary[]>,
     *   checkForUpdate: (dictionaryInfo: import('dictionary-importer').Summary) => Promise<unknown | null>,
     *   updateDictionary: (dictionaryTitle: string, updateCandidate: unknown) => Promise<boolean>,
     *   onError: (error: unknown, details: {dictionaryTitle: string, phase: 'check' | 'update'}) => void
     * }} dependencies
     */
    constructor({
        isEnabled,
        hasRunThisSession,
        markRunThisSession,
        getDictionaryInfo,
        checkForUpdate,
        updateDictionary,
        onError,
    }) {
        /** @type {() => Promise<boolean>} */
        this._isEnabled = isEnabled;
        /** @type {() => Promise<boolean>} */
        this._hasRunThisSession = hasRunThisSession;
        /** @type {() => Promise<void>} */
        this._markRunThisSession = markRunThisSession;
        /** @type {() => Promise<import('dictionary-importer').Summary[]>} */
        this._getDictionaryInfo = getDictionaryInfo;
        /** @type {(dictionaryInfo: import('dictionary-importer').Summary) => Promise<unknown | null>} */
        this._checkForUpdate = checkForUpdate;
        /** @type {(dictionaryTitle: string, updateCandidate: unknown) => Promise<boolean>} */
        this._updateDictionary = updateDictionary;
        /** @type {(error: unknown, details: {dictionaryTitle: string, phase: 'check' | 'update'}) => void} */
        this._onError = onError;
    }

    /**
     * @returns {Promise<number>}
     */
    async run() {
        if (!await this._isEnabled()) { return 0; }
        if (await this._hasRunThisSession()) { return 0; }

        await this._markRunThisSession();

        let updateCount = 0;
        const dictionaries = await this._getDictionaryInfo();
        for (const dictionaryInfo of dictionaries) {
            let updateCandidate;
            try {
                updateCandidate = await this._checkForUpdate(dictionaryInfo);
            } catch (e) {
                this._onError(e, {dictionaryTitle: dictionaryInfo.title, phase: 'check'});
                continue;
            }

            if (updateCandidate === null) { continue; }

            try {
                if (await this._updateDictionary(dictionaryInfo.title, updateCandidate)) {
                    ++updateCount;
                }
            } catch (e) {
                this._onError(e, {dictionaryTitle: dictionaryInfo.title, phase: 'update'});
            }
        }

        return updateCount;
    }
}
