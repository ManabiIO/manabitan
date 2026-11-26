# SPDX-License-Identifier: GPL-3.0-or-later
"""Unchanged marker, fixed schedule, and paired memory gates from the prior study.

Source/package and semantic equality are the qualification caller's independent
responsibility. These helpers never make sampled timing authoritative.
"""

import math
import statistics


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
    if replication not in (1, 2):
        raise ValueError('Replication must be 1 or 2')
    arms = 'ABBA' if replication == 1 else 'BAAB'
    counts = {'A': 0, 'B': 0}
    result = []
    for index, arm in enumerate(arms, 1):
        counts[arm] += 1
        result.append({'index': index, 'arm': arm, 'name': f'{arm}{counts[arm]}', 'pair': (index - 1) // 2 + 1})
    return result


def memory_comparison(observations, dictionary, replication, schedule):
    if [row['name'] for row in observations] != [row['name'] for row in schedule(replication)]:
        raise ValueError('The fixed four-observation cohort is incomplete or reordered')
    pairs = []
    qualified = all(row['qualifiedForWholeTreePss'] for row in observations)
    for index in (1, 2):
        arms = {row['arm']: row for row in observations if row['pair'] == index}
        pair = {'pair': index, 'qualified': all(row['qualifiedForWholeTreePss'] for row in arms.values())}
        for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
            a, b = arms['A'][metric], arms['B'][metric]
            if pair['qualified'] and (type(a) not in (int, float) or type(b) not in (int, float) or
                                      not math.isfinite(a) or not math.isfinite(b) or a <= 0 or b < 0):
                raise ValueError('Invalid qualified memory maxima')
            pair[metric] = {'baseline': a, 'candidate': b,
                            'changePercent': 100 * (b / a - 1) if pair['qualified'] else None}
        pairs.append(pair)
    metrics = {}
    for metric in ('maxSampledPssKiB', 'maxSampledPrivateKiB'):
        changes = [pair[metric]['changePercent'] for pair in pairs]
        metrics[metric] = {'medianPairedChangePercent': statistics.median(changes) if qualified else None,
                           'maximumPairedChangePercent': max(changes) if qualified else None}
    passes = qualified and all(value['medianPairedChangePercent'] <= 5 and value['maximumPairedChangePercent'] <= 10
                               for value in metrics.values())
    return {'schemaVersion': 1, 'dictionary': dictionary, 'replication': replication, 'authoritativeTiming': False,
            'observations': observations, 'pairs': pairs, 'metrics': metrics, 'everyObservationQualified': qualified,
            'passesProspectiveMemoryScreen': passes}
