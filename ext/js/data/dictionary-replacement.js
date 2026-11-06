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

/**
 * Identify completed storage cutovers whose page-side settings migration may
 * have been interrupted. A display-title match alone is not a receipt.
 * Multiple candidates stay explicit so callers preserve preferences rather
 * than choosing an arbitrary target.
 * @param {import('dictionary-importer').Summary[]} dictionaries
 * @returns {Map<string, import('dictionary-importer').Summary[]>}
 */
export function getCompletedDictionaryReplacements(dictionaries) {
    const installedNames = new Set(dictionaries.map(({title}) => title));
    /** @type {Map<string, import('dictionary-importer').Summary[]>} */
    const replacements = new Map();
    for (const dictionary of dictionaries) {
        const sourceName = dictionary.replacedDictionaryTitle;
        if (
            typeof sourceName !== 'string' || sourceName.length === 0 || installedNames.has(sourceName) ||
            dictionary.sourceTitle !== dictionary.title || dictionary.importSuccess !== true ||
            typeof dictionary.storageGenerationId !== 'string' || dictionary.storageGenerationId.length === 0 ||
            typeof dictionary.updateSessionToken !== 'string' || dictionary.updateSessionToken.trim().length === 0 ||
            (typeof dictionary.transientUpdateStage === 'string' && dictionary.transientUpdateStage.length > 0)
        ) { continue; }
        const candidates = replacements.get(sourceName) ?? [];
        candidates.push(dictionary);
        replacements.set(sourceName, candidates);
    }
    return replacements;
}
