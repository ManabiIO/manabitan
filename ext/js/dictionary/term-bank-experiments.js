/*
 * Copyright (C) 2026  Yomitan Authors
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

/* eslint @stylistic/semi: ["error", "never"] */

/**
 * Default-off import experiments. Snapshot before asynchronous work, and copy
 * the effective values into each worker request; no toggle survives an import.
 * @param {import('dictionary-importer').ImportExperiments} [options]
 * @returns {Readonly<Required<import('dictionary-importer').ImportExperiments>>}
 */
export function snapshotTermBankExperiments(options = {}) {
    return Object.freeze({
        experimentalLookupScratchReuse: options.experimentalLookupScratchReuse === true,
        experimentalNativeSegmentedLookup: options.experimentalNativeSegmentedLookup === true,
        experimentalDirectLookupArena: options.experimentalDirectLookupArena === true,
        experimentalSinglePassLookupCompaction: options.experimentalSinglePassLookupCompaction === true,
        experimentalTermBankSpans: options.experimentalTermBankSpans === true,
        experimentalNativeEscapedKeys: options.experimentalNativeEscapedKeys === true,
        experimentalValidatedGlossaryReuse: options.experimentalValidatedGlossaryReuse === true,
        experimentalFusedSingleBank: options.experimentalFusedSingleBank === true,
        experimentalGlobalExactContentReuse: options.experimentalGlobalExactContentReuse === true,
        experimentalFastGlossaryNormalization: options.experimentalFastGlossaryNormalization === true,
    })
}

/**
 * Default import policy, resolved once at the import boundary. Low-level parser
 * calls and worker snapshots remain explicit/default-off; only the import
 * owner selects native segmentation for oversized groups. Explicit overrides retain
 * the existing strict-boolean semantics and can disable any individual path.
 * @param {import('dictionary-importer').ImportExperiments} [options]
 * @returns {ReturnType<typeof snapshotTermBankExperiments>}
 */
export function resolveTermBankImportExperiments(options = {}) {
    return snapshotTermBankExperiments({
        experimentalNativeSegmentedLookup: true,
        ...options,
    })
}

/**
 * Must match EXPERIMENT_* in wasm/term-bank-parser.c. Single-bank admission and
 * lookup construction are selected in JavaScript and consume no native bit.
 * @param {import('dictionary-importer').ImportExperiments} options
 * @returns {number}
 */
export function getTermBankExperimentMask(options) {
    return (options.experimentalTermBankSpans === true ? 1 : 0) |
    (options.experimentalNativeEscapedKeys === true ? 2 : 0) |
    (options.experimentalValidatedGlossaryReuse === true ? 4 : 0) |
    (options.experimentalGlobalExactContentReuse === true ? 8 : 0) |
    (options.experimentalFastGlossaryNormalization === true ? 16 : 0)
}
