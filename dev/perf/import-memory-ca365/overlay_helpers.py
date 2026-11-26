"""Unchanged marker and fixed-schedule helpers from f2f08c8ee74cdea548c5c1b494ec15bf10360b46."""

def memory_overlay(source):
    """Add two test-only file markers to both arms; no runtime file is changed."""
    anchor = "import {existsSync, readFileSync} from 'node:fs';"
    if source.count(anchor) != 1:
        raise ValueError('Missing unique filesystem import anchor')
    source = source.replace(anchor, "import {appendFileSync, existsSync, readFileSync} from 'node:fs';")
    helper = """
const importMemoryMarkerPath = process.env.MANABITAN_IMPORT_MEMORY_MARKERS ?? '';
function recordImportMemoryMarker(event) {
    if (importMemoryMarkerPath.length > 0) {
        appendFileSync(importMemoryMarkerPath, JSON.stringify({event, monotonicNs: process.hrtime.bigint().toString(), epochMs: Date.now()}) + '\\n');
    }
}

"""
    anchor = '/**\n * Exercise real browser confirmation dialogs'
    if source.count(anchor) != 1:
        raise ValueError('Missing unique marker helper anchor')
    source = source.replace(anchor, helper + anchor)
    anchor = "        const initialImportTriggerStart = safePerformance.now();"
    if source.count(anchor) != 1:
        raise ValueError('Missing unique import start anchor')
    source = source.replace(anchor, "        recordImportMemoryMarker('start');\n" + anchor)
    anchor = "            const importTotalEnd = safePerformance.now();"
    if source.count(anchor) != 1:
        raise ValueError('Missing unique import end anchor')
    source = source.replace(anchor, "            recordImportMemoryMarker('end');\n" + anchor)
    return source

def schedule(replication):
    arms = 'ABBA' if replication == 1 else 'BAAB'
    counts = {'A': 0, 'B': 0}
    result = []
    for index, arm in enumerate(arms, 1):
        counts[arm] += 1
        result.append({'index': index, 'arm': arm, 'name': f'{arm}{counts[arm]}', 'pair': (index - 1) // 2 + 1})
    return result
