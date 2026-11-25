"""Identical test-only import markers and diagnostic labels for both arms."""


HARNESS_PATH = 'test/chromium/extension-two-dictionary-import.e2e.js'
SUPPORT_PATH = 'dev/perf/benchmark-support.js'
BENCHMARK_PATH = 'dev/perf/import-benchmark.js'
OVERLAY_PATHS = (HARNESS_PATH, SUPPORT_PATH, BENCHMARK_PATH)


def replace_once(source, anchor, replacement):
    if source.count(anchor) != 1:
        raise ValueError(f'Missing unique overlay anchor: {anchor!r}')
    return source.replace(anchor, replacement)


def memory_overlay(source):
    """Mark the original automation window without changing product code."""
    source = replace_once(
        source,
        "import {existsSync, readFileSync} from 'node:fs';",
        "import {appendFileSync, existsSync, readFileSync} from 'node:fs'",
    )
    helper = """
const importMemoryMarkerPath = process.env.MANABITAN_IMPORT_MEMORY_MARKERS ?? ''
function recordImportMemoryMarker(event) {
    if (importMemoryMarkerPath.length > 0) {
        appendFileSync(importMemoryMarkerPath, JSON.stringify({event, monotonicNs: process.hrtime.bigint().toString(), epochMs: Date.now()}) + '\\n')
    }
}

"""
    anchor = '/**\n * Exercise real browser confirmation dialogs'
    source = replace_once(source, anchor, helper + anchor)
    anchor = '        const initialImportTriggerStart = safePerformance.now();'
    source = replace_once(source, anchor, "        recordImportMemoryMarker('start')\n" + anchor)
    anchor = '            const importTotalEnd = safePerformance.now();'
    source = replace_once(source, anchor, "            recordImportMemoryMarker('end')\n" + anchor)
    anchor = 'authoritativeTiming: importTracePath.length === 0 && !capturePhaseProfiles && !capturePhaseScreenshots && !captureProcessSamples,'
    return replace_once(source, anchor, anchor[:-1] + ' && importMemoryMarkerPath.length === 0,')


def overlay_sources(sources):
    """Keep strict validation while explicitly labeling instrumented timings."""
    if set(sources) != set(OVERLAY_PATHS):
        raise ValueError('Expected the exact three test-only overlay sources')
    return {
        HARNESS_PATH: memory_overlay(sources[HARNESS_PATH]),
        SUPPORT_PATH: replace_once(
            sources[SUPPORT_PATH],
            'benchmark.authoritativeTiming !== !traceEnabled ||',
            "benchmark.authoritativeTiming !== (!traceEnabled && (process.env.MANABITAN_IMPORT_MEMORY_MARKERS ?? '').length === 0) ||",
        ),
        BENCHMARK_PATH: replace_once(
            sources[BENCHMARK_PATH],
            'authoritativeTiming: !options.trace,',
            "authoritativeTiming: !options.trace && (process.env.MANABITAN_IMPORT_MEMORY_MARKERS ?? '').length === 0,",
        ),
    }


def schedule(replication):
    if replication not in (1, 2):
        raise ValueError('Expected memory replication 1 or 2')
    arms = 'ABBA' if replication == 1 else 'BAAB'
    counts = {'A': 0, 'B': 0}
    result = []
    for index, arm in enumerate(arms, 1):
        counts[arm] += 1
        result.append({'index': index, 'arm': arm, 'name': f'{arm}{counts[arm]}', 'pair': (index - 1) // 2 + 1})
    return result
