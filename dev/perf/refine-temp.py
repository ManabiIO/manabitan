from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


e2e = Path("test/chromium/extension-two-dictionary-import.e2e.js")
text = e2e.read_text()

old = """        await context.addInitScript(({flagsFromRunner, useProductionDefaults}) => {
            Reflect.set(globalThis, '__manabitanImportCompletionSignalEnabled', true);
            if (useProductionDefaults) {
                delete globalThis.manabitanImportUseSession;
            } else {
                globalThis.manabitanImportUseSession = false;
            }
            globalThis.manabitanDisableIntegrityCounts = true;
            globalThis.manabitanImportPerformanceFlags = (flagsFromRunner && typeof flagsFromRunner === 'object') ? {...flagsFromRunner} : {};
        }, {flagsFromRunner: e2eImportFlags, useProductionDefaults: useProductionImportDefaults});
"""
new = """        await context.addInitScript(({flagsFromRunner, useProductionDefaults}) => {
            Reflect.set(globalThis, '__manabitanImportCompletionSignalEnabled', true);
            if (useProductionDefaults) {
                delete globalThis.manabitanImportUseSession;
                delete globalThis.manabitanDisableIntegrityCounts;
                if (flagsFromRunner && typeof flagsFromRunner === 'object') {
                    globalThis.manabitanImportPerformanceFlags = {...flagsFromRunner};
                } else {
                    delete globalThis.manabitanImportPerformanceFlags;
                }
            } else {
                globalThis.manabitanImportUseSession = false;
                globalThis.manabitanDisableIntegrityCounts = true;
                globalThis.manabitanImportPerformanceFlags = (flagsFromRunner && typeof flagsFromRunner === 'object') ? {...flagsFromRunner} : {};
            }
        }, {flagsFromRunner: e2eImportFlags, useProductionDefaults: useProductionImportDefaults});
"""
text = replace_once(text, old, new, "init-script production defaults")

old = """            await page.evaluate(({flagsFromRunner, useProductionDefaults}) => {
                if (useProductionDefaults) {
                    delete globalThis.manabitanImportUseSession;
                } else {
                    globalThis.manabitanImportUseSession = false;
                }
                globalThis.manabitanDisableIntegrityCounts = true;
                globalThis.manabitanImportPerformanceFlags = (flagsFromRunner && typeof flagsFromRunner === 'object') ? {...flagsFromRunner} : {};
                Reflect.set(globalThis, '__manabitanImportCompletionSequence', 0);
                Reflect.set(globalThis, '__manabitanLastImportCompletion', null);
            }, {flagsFromRunner: importFlags, useProductionDefaults: useProductionImportDefaults});
"""
new = """            await page.evaluate(({flagsFromRunner, useProductionDefaults}) => {
                if (useProductionDefaults) {
                    delete globalThis.manabitanImportUseSession;
                    delete globalThis.manabitanDisableIntegrityCounts;
                    if (flagsFromRunner && typeof flagsFromRunner === 'object') {
                        globalThis.manabitanImportPerformanceFlags = {...flagsFromRunner};
                    } else {
                        delete globalThis.manabitanImportPerformanceFlags;
                    }
                } else {
                    globalThis.manabitanImportUseSession = false;
                    globalThis.manabitanDisableIntegrityCounts = true;
                    globalThis.manabitanImportPerformanceFlags = (flagsFromRunner && typeof flagsFromRunner === 'object') ? {...flagsFromRunner} : {};
                }
                Reflect.set(globalThis, '__manabitanImportCompletionSequence', 0);
                Reflect.set(globalThis, '__manabitanLastImportCompletion', null);
            }, {flagsFromRunner: importFlags, useProductionDefaults: useProductionImportDefaults});
"""
text = replace_once(text, old, new, "page production defaults")

old = """            });
            const importDebug = await getLastImportDebug(page);
            const importDebugHistory = await getImportDebugHistory(page);
            const importStepTimingHistory = await getImportStepTimingHistory(page);
            // Keep the visible boundary honest if the browser has signalled UI
            // completion but its main thread is still unable to serve the exact
            // completed import snapshot under load.
            const importTotalEnd = safePerformance.now();
"""
new = """            });
            // Benchmark timing stops at the visible completion boundary. The
            // diagnostic reads below are test-only work and must not contaminate
            // authoritative import timings. Functional E2E keeps its historical
            // boundary, which includes proving that the completed snapshot is readable.
            const benchmarkImportEnd = quickImportBenchmarkMode ? safePerformance.now() : null;
            const importDebug = await getLastImportDebug(page);
            const importDebugHistory = await getImportDebugHistory(page);
            const importStepTimingHistory = await getImportStepTimingHistory(page);
            const importTotalEnd = benchmarkImportEnd ?? safePerformance.now();
"""
text = replace_once(text, old, new, "benchmark timing boundary")

old = """                    importDebug,
                    importDebugHistory,
                    stepTimingSummary: importStepTimingSummary,
"""
new = """                    importDebug,
                    stepTimingSummary: importStepTimingSummary,
"""
text = replace_once(text, old, new, "structured report history")

old = "const importSessionMode = useProductionImportDefaults ? 'production default import session behavior' : 'manabitanImportUseSession=false';"
new = "const importSessionMode = useProductionImportDefaults ? 'production default import globals' : 'functional E2E import overrides';"
text = replace_once(text, old, new, "import mode label")
e2e.write_text(text)

ab = Path("test/chromium/import-flags-ab-benchmark.js")
text = ab.read_text()

old = """            MANABITAN_E2E_SKIP_BUILD: skipBuild ? '1' : '0',
            MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(baselineRunImportFlags),
        });
"""
new = """            MANABITAN_E2E_SKIP_BUILD: skipBuild ? '1' : '0',
            ...(Object.keys(baselineRunImportFlags).length > 0 ? {
                MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(baselineRunImportFlags),
            } : {}),
        });
"""
text = replace_once(text, old, new, "A/B baseline flags")

old = """            MANABITAN_E2E_SKIP_BUILD: skipBuild ? '1' : '0',
            MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(variantImportFlags),
        });
"""
new = """            MANABITAN_E2E_SKIP_BUILD: skipBuild ? '1' : '0',
            ...(Object.keys(variantImportFlags).length > 0 ? {
                MANABITAN_E2E_IMPORT_FLAGS_JSON: JSON.stringify(variantImportFlags),
            } : {}),
        });
"""
text = replace_once(text, old, new, "A/B variant flags")
ab.write_text(text)

mise = Path("mise.toml")
text = mise.read_text()
text = replace_once(
    text,
    '[tools]\nnode = "24.20.0"\n',
    '[tools]\nnode = "24"\n\n[settings]\nlockfile = true\n',
    "mise node request",
)
text = text.replace("npx vitest ", "node ./node_modules/vitest/vitest.mjs ")
mise.write_text(text)

Path("mise.lock").write_text("""lockfile_version = 1

[[tools.node]]
version = "24.20.0"
backend = "core:node"
specifiers = ["24"]
""")

host = Path("dev/perf/host-environment.js")
host.write_text(r"""/*
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

import {readFileSync} from 'node:fs';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

/**
 * @param {string} name
 * @returns {string|null}
 */
function readCgroupFile(name) {
    if (process.platform !== 'linux') {
        return null;
    }
    try {
        return readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim() || null;
    } catch (_) {
        return null;
    }
}

/**
 * @param {string|null} value
 * @returns {number|null}
 */
function parseCgroupBytes(value) {
    if (value === null || value === 'max') {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * @param {string|null} cpuMax
 * @returns {number|null}
 */
function parseCpuQuotaCores(cpuMax) {
    if (cpuMax === null) {
        return null;
    }
    const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
    if (quotaRaw === 'max') {
        return null;
    }
    const quota = Number(quotaRaw);
    const period = Number(periodRaw);
    return Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0 ? quota / period : null;
}

/**
 * Returns stable environment metadata that belongs next to performance results.
 * Git metadata is intentionally excluded because exported/offline snapshots may
 * not contain a .git directory.
 * @returns {Record<string, unknown>}
 */
export function getHostEnvironment() {
    const cpus = os.cpus();
    const cgroupCpuMax = readCgroupFile('cpu.max');
    return {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus[0]?.model ?? null,
        logicalCpuCount: cpus.length,
        availableParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : null,
        totalMemoryBytes: os.totalmem(),
        cgroupCpuMax,
        cgroupCpuQuotaCores: parseCpuQuotaCores(cgroupCpuMax),
        cgroupMemoryMaxBytes: parseCgroupBytes(readCgroupFile('memory.max')),
        cgroupMemoryCurrentBytes: parseCgroupBytes(readCgroupFile('memory.current')),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log(JSON.stringify(getHostEnvironment(), null, 2));
}
""")

readme = Path("dev/perf/README.md")
text = readme.read_text()
text = replace_once(
    text,
    "Without `mise`, invoke the corresponding Node/Vitest commands from `mise.toml` directly.",
    "Without `mise`, run the `dev/perf/*.js` programs directly. Microbenchmarks can be run offline with `node ./node_modules/vitest/vitest.mjs bench`; no task requires npm package resolution at execution time.",
    "README offline command",
)
text = replace_once(
    text,
    "Normal import benchmark runs disable the E2E page CPU profiler, phase screenshots, and browser-process sampling during the measured run.",
    "Normal import benchmark runs use production import globals (except the completion signal required by the harness) and disable the E2E page CPU profiler, phase screenshots, and browser-process sampling. Their total-import timer stops before test-only diagnostic reads.",
    "README benchmark fidelity",
)
readme.write_text(text)

bundle = Path(".github/workflows/perf-bundle.yml")
text = bundle.read_text()
old = """          if [[ "${GITHUB_EVENT_NAME}" == "issue_comment" ]]; then
            source_sha="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" --jq .head.sha)"
          else
"""
new = """          if [[ "${GITHUB_EVENT_NAME}" == "issue_comment" ]]; then
            pr_json="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}")"
            head_repo="$(jq -r .head.repo.full_name <<<"${pr_json}")"
            if [[ "${head_repo}" != "${GITHUB_REPOSITORY}" ]]; then
              echo "Refusing to execute an offline-bundle build from fork ${head_repo}" >&2
              exit 1
            fi
            source_sha="$(jq -r .head.sha <<<"${pr_json}")"
          else
"""
text = replace_once(text, old, new, "perf-bundle fork guard")
bundle.write_text(text)
