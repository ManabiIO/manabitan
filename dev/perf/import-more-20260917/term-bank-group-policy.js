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
 * Choose byte-balanced parser groups without increasing the nominal source
 * lead allowance. Physical banks remain indivisible, so this is not a bound
 * on total browser memory or on an individual oversized bank.
 * Conflicting opt-ins fail closed to the unchanged production policy.
 * @param {number} defaultGroupsPerWorker
 * @param {boolean} lazy
 * @param {import('dictionary-importer').ImportExperiments} [options]
 * @returns {{groupsPerWorker: number, targetGroupBytes: number}}
 */
export function getTermBankGroupPolicy(defaultGroupsPerWorker, lazy, options = {}) {
    const baseline = {groupsPerWorker: defaultGroupsPerWorker, targetGroupBytes: 24 * 1024 * 1024}
    if (!lazy) { return baseline }
    const selected = [
        options.experimentalParserGroups16MiB === true ? 16 : 0,
        options.experimentalParserGroups32MiB === true ? 32 : 0,
        options.experimentalParserGroups48MiB === true ? 48 : 0,
    ].filter((value) => value > 0)
    if (selected.length !== 1) { return baseline }
    const size = selected[0]
    return {
        groupsPerWorker: Math.max(1, Math.floor(defaultGroupsPerWorker * 24 / size)),
        targetGroupBytes: size * 1024 * 1024,
    }
}
