# SPDX-License-Identifier: GPL-3.0-or-later
"""One explicit post-validation overlay, identical for all study arms/modes."""
import hashlib
import json
from pathlib import Path

ANCHOR = """                    restart: {title: restartedInfo[0].title, revision: restartedInfo[0].revision, termRows: restartedState.counts[0].terms, mediaFiles: restartedState.counts[0].media, contentReadable: true, probeCount: restartedProbeResults.length},
                };
            }
            report.status = 'success';
            console.log(`${e2eLogTag} PASS: Quick import benchmark mode completed (${initialImportSpec.label}).`);
"""


def layout_overlay(source, exporter_path, expected_source_sha256):
    """Return exact overlay plus provenance; never edit the product checkout here."""
    if hashlib.sha256(source.encode()).hexdigest() != expected_source_sha256:
        raise ValueError('Original browser harness hash changed')
    exporter = Path(exporter_path)
    if not exporter.is_absolute():
        raise ValueError('Exporter path must be absolute')
    if source.count(ANCHOR) != 1 or 'exportBrowserTermLayoutFromHarness' in source:
        raise ValueError('Expected one untouched post-validation insertion boundary')
    hook = (
        '                // Explicit frozen research hook: all import timing has ended.\n'
        '                const {exportBrowserTermLayoutFromHarness} = await import(' + json.dumps(exporter.as_uri()) + ');\n'
        '                await exportBrowserTermLayoutFromHarness({page, validation: report.benchmark.validation, fixture,\n'
        '                    beforeProbes: probeResults, afterProbes: restartedProbeResults, importDebug: initialImportDebug});\n'
    )
    replacement = ANCHOR.replace('                };\n            }\n', '                };\n' + hook + '            }\n')
    result = source.replace(ANCHOR, replacement)
    return result, {'originalSha256': expected_source_sha256, 'overlaySha256': hashlib.sha256(result.encode()).hexdigest(),
        'exporterPath': str(exporter), 'anchorSha256': hashlib.sha256(ANCHOR.encode()).hexdigest(),
        'hook': hook, 'boundary': 'After original timed endpoint, restart/probe/lookup/media/storage validation; before quick-mode context cleanup',
        'productChanged': False, 'sourceDirty': True,
        'modes': 'Same hook bytes: preflight export or ordinary hash-only selected by frozen per-observation request JSON'}
