#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Separate, instrumented worker/readiness checks after import qualification.

This overlays only the existing E2E harness in the already-built A/B worktrees.
It does not contribute timings to the authoritative import cohort.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit


HELPER = r"""
const sahpoolDiagnostic = {
    authoritativeTiming: false,
    readinessBoundary: 'before browser launch to first settings-page database-state RPC completion; includes browser startup and automation',
    contexts: [],
    firstLookup: null,
}
let sahpoolObserver = null
async function observeSahpoolWorkers(context, launchStartedMs) {
    const browser = context.browser()
    if (browser === null) { throw new Error('Missing browser for worker diagnostic') }
    const session = await browser.newBrowserCDPSession()
    const workers = new Map()
    const receipt = {launchStartedMs, readyMs: null, workers: []}
    const remember = (targetInfo) => {
        if (!['worker', 'service_worker', 'shared_worker'].includes(targetInfo.type)) { return }
        workers.set(targetInfo.targetId, {id: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url})
        receipt.workers = [...workers.values()]
    }
    session.on('Target.targetCreated', ({targetInfo}) => remember(targetInfo))
    session.on('Target.targetInfoChanged', ({targetInfo}) => remember(targetInfo))
    // Browser-level discovery covers existing and future nested workers. The
    // explicit catch-all filter avoids relying on the protocol's default filter.
    await session.send('Target.setDiscoverTargets', {discover: true, filter: [{}]})
    const snapshot = async () => {
        const {targetInfos} = await session.send('Target.getTargets', {filter: [{}]})
        for (const info of targetInfos) { remember(info) }
        receipt.workers = [...workers.values()]
    }
    sahpoolDiagnostic.contexts.push(receipt)
    sahpoolObserver = {receipt, snapshot}
    await snapshot()
}
async function recordSahpoolReadiness(page) {
    await evalSendMessage(page, 'benchmarkDictionaryState')
    sahpoolObserver.receipt.readyMs = safePerformance.now() - sahpoolObserver.receipt.launchStartedMs
    await sahpoolObserver.snapshot()
}
async function recordFirstSahpoolLookup(page, title, term) {
    const lookup = await evalSendMessage(page, 'sahpoolFirstLookup', {title, terms: [term]})
    if (lookup.observations.length !== 1) { throw new Error('Missing first query diagnostic') }
    sahpoolDiagnostic.firstLookup = {
        timingBoundary: 'first settings-page termsFind RPC after observed post-UI import completion, before integrity probes; excludes result hashing',
        ...lookup.observations[0],
    }
    await sahpoolObserver.snapshot()
}

"""


def replace_once(source, anchor, replacement):
    if source.count(anchor) != 1:
        raise ValueError(f'Missing unique diagnostic anchor: {anchor[:90]}')
    return source.replace(anchor, replacement)


def overlay(source):
    source = replace_once(source, '/**\n * Exercise real browser confirmation dialogs',
                          HELPER + '/**\n * Exercise real browser confirmation dialogs')
    source = replace_once(
        source,
        'authoritativeTiming: importTracePath.length === 0 && !capturePhaseProfiles && !capturePhaseScreenshots && !captureProcessSamples,',
        'authoritativeTiming: false, // Separate worker diagnostic; never a timing observation.',
    )
    source = replace_once(source, "        if (expression === 'benchmarkLookups') {",
                          "        if (expression === 'benchmarkLookups' || expression === 'sahpoolFirstLookup') {")
    source = replace_once(source, '            for (let pass = 0; pass < 6; ++pass) {',
                          "            for (let pass = 0; pass < (expression === 'sahpoolFirstLookup' ? 1 : 6); ++pass) {")
    source = replace_once(
        source,
        '            return await chromium.launchPersistentContext(userDataDir, getChromiumLaunchOptions(launchOptions));',
        '''            const launchStartedMs = safePerformance.now()
            const result = await chromium.launchPersistentContext(userDataDir, getChromiumLaunchOptions(launchOptions))
            await observeSahpoolWorkers(result, launchStartedMs)
            return result''',
    )
    source = replace_once(
        source, '        const settingsOpenEnd = safePerformance.now();',
        '        await recordSahpoolReadiness(page)\n        const settingsOpenEnd = safePerformance.now();',
    )
    source = replace_once(
        source, '        const jitendexProbeTerms = await loadDictionaryProbeTermsFromArchive(cachedDictionaries.jitendexPath, 80);',
        '''        const sahpoolProbeTerms = await loadBenchmarkProbeTerms(initialImportSpec.filePath)
        if (sahpoolProbeTerms.length !== 12) { throw new Error('Incomplete diagnostic probe fixture') }
        const jitendexProbeTerms = await loadDictionaryProbeTermsFromArchive(cachedDictionaries.jitendexPath, 80);''',
    )
    source = replace_once(
        source, '            const importTotalEnd = safePerformance.now();',
        '''            const importTotalEnd = safePerformance.now();
            await recordFirstSahpoolLookup(page, cachedDictionaries.fixtures[quickImportBenchmarkDictionaryId].expectedTitle, sahpoolProbeTerms[0])''',
    )
    source = replace_once(
        source, '                const restartedState = await evalSendMessage(page, \'benchmarkDictionaryState\');',
        '''                await recordSahpoolReadiness(page)
                const restartedState = await evalSendMessage(page, 'benchmarkDictionaryState');''',
    )
    source = replace_once(
        source, '            await mkdir(path.dirname(reportPath), {recursive: true});',
        '''            if (sahpoolObserver !== null) { await sahpoolObserver.snapshot() }
            await writeFile(process.env.MANABITAN_SAHPOOL_DIAGNOSTIC_PATH, JSON.stringify(sahpoolDiagnostic, null, 2))
            await mkdir(path.dirname(reportPath), {recursive: true});''',
    )
    return source


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_workers(receipt, candidate):
    if receipt.get('authoritativeTiming') is not False:
        raise ValueError('Worker diagnostics must be explicitly non-authoritative')
    contexts = receipt.get('contexts', [])
    if len(contexts) != 2:
        raise ValueError('Expected initial launch and persistence restart diagnostics')
    counts = []
    for context in contexts:
        ready = context.get('readyMs')
        if type(ready) not in (int, float) or not 0 < ready < float('inf'):
            raise ValueError('Missing cold readiness boundary')
        workers = context.get('workers', [])
        primary = [row for row in workers if row['type'] == 'worker' and
                   urlsplit(row['url']).path == '/js/background/offscreen-dictionary-worker.js']
        proxies = [row for row in workers if
                   urlsplit(row['url']).path.endswith('/sqlite3-opfs-async-proxy.js')]
        if not primary:
            raise ValueError('Observer did not see the production dictionary worker')
        if candidate:
            if proxies or any('opfs-disable' not in parse_qs(urlsplit(row['url']).query, keep_blank_values=True)
                              for row in primary):
                raise ValueError('Candidate started an OPFS proxy or omitted the disable parameter')
        elif not proxies:
            raise ValueError('Baseline proxy was not observed; zero candidate proxies is inconclusive')
        counts.append({'workersSeen': len(workers), 'dictionaryWorkers': len(primary),
                       'sqliteProxyWorkers': len(proxies), 'readyMs': ready})
    first = receipt.get('firstLookup')
    if not isinstance(first, dict) or first.get('pass') != 0 or first.get('hasExactHeadwordMatch') is not True:
        raise ValueError('Missing correct first post-import query')
    term = first.get('term')
    if not isinstance(term, str) or not term or first.get('originalTextLength') != len(term.encode('utf-16-le')) // 2:
        raise ValueError('First query did not match its complete source term')
    if type(first.get('results')) is not int or first['results'] < 1 or re.fullmatch(r'[a-f0-9]{64}', first.get('sha256', '')) is None:
        raise ValueError('First query result or digest is missing')
    elapsed = first.get('elapsedMs')
    if type(elapsed) not in (int, float) or not 0 <= elapsed < float('inf'):
        raise ValueError('First query elapsed interval is missing')
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-root', type=Path, required=True)
    parser.add_argument('--candidate-root', type=Path, required=True)
    parser.add_argument('--dictionary', choices=('jmdict', 'jitendex', 'vndb'), required=True)
    parser.add_argument('--order', choices=('AB', 'BA'), required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / 'dev/perf/import-memory-20261125-a7f7'))
    from qualification_receipts import canonicalize_validation
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    roots = {'A': args.baseline_root.resolve(), 'B': args.candidate_root.resolve()}
    relative = 'test/chromium/extension-two-dictionary-import.e2e.js'
    original = (roots['A'] / relative).read_text()
    if (roots['B'] / relative).read_text() != original:
        raise ValueError('Diagnostic harness inputs differ')
    instrumented = overlay(original)
    (output / 'harness-original.js').write_text(original)
    (output / 'harness-instrumented.js').write_text(instrumented)
    (output / 'scope.json').write_text(json.dumps({
        'authoritativeTiming': False, 'order': args.order,
        'scope': 'Separate CDP worker inventory, cold readiness, and first exact query diagnostics; no timing qualification',
        'overlaySha256': hashlib.sha256(instrumented.encode()).hexdigest(),
        'vndbSahAllocationUnits': [37, 37] if args.dictionary == 'vndb' else None,
        'vndbPolicyEvidence': ('https://github.com/ManabiIO/manabitan/blob/'
                              '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2/dev/perf/import-experiments-20260914.md'
                              '#november-26-2026-index-setup-coverage-and-frozen-screen') if args.dictionary == 'vndb' else None,
    }, indent=2) + '\n')
    fixture = json.loads((root / 'test/perf/dictionaries.lock.json').read_text())['dictionaries'][args.dictionary]
    results = {}
    semantic = {}
    for arm in args.order:
        target = roots[arm]
        folder = output / arm
        folder.mkdir()
        package = target / 'builds/manabitan-chrome.zip'
        package_sha = digest(package)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('MANABITAN_E2E_', 'MANABITAN_CHROMIUM_'))}
        env.update({
            'MANABITAN_CHROMIUM_BROWSER': 'chromium', 'MANABITAN_CHROMIUM_HEADLESS': '1',
            'MANABITAN_CHROMIUM_ALLOW_HEADED_FALLBACK': '0', 'MANABITAN_CHROMIUM_BUILD_TARGET': 'chrome',
            'MANABITAN_CHROMIUM_E2E_REPORT': str(folder / 'run.html'),
            'MANABITAN_E2E_STRICT_RUNTIME': '1', 'MANABITAN_E2E_IMPORT_BENCH_QUICK': '1',
            'MANABITAN_E2E_IMPORT_BENCH_DICTIONARY': args.dictionary, 'MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK': '1',
            'MANABITAN_E2E_BENCH_MEDIA_CHECK': 'sample', 'MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS': '1',
            'MANABITAN_E2E_PHASE_PROFILING': '0', 'MANABITAN_E2E_PHASE_SCREENSHOTS': '0',
            'MANABITAN_E2E_PROCESS_SAMPLING': '0', 'MANABITAN_E2E_SKIP_BUILD': '1',
            'MANABITAN_SAHPOOL_DIAGNOSTIC_PATH': str(folder / 'workers.json'),
        })
        try:
            (target / relative).write_text(instrumented)
            with (folder / 'run.log').open('wb') as log:
                subprocess.run(['node', relative], cwd=target, env=env, stdout=log,
                               stderr=subprocess.STDOUT, timeout=1800, check=True)
        finally:
            (target / relative).write_text(original)
            if digest(package) != package_sha:
                raise ValueError('Product package changed during diagnostics')
        report = json.loads((folder / 'run.json').read_text())
        if report.get('status') != 'success' or report['benchmark']['authoritativeTiming'] is not False:
            raise ValueError('Instrumented import did not pass the existing strict verifier')
        semantic[arm] = canonicalize_validation(report['benchmark']['validation'], dictionary=args.dictionary,
                                               fixture=fixture, media_check='sample',
                                               vndb_sah_allocation_units=(37, 37))
        receipt = json.loads((folder / 'workers.json').read_text())
        source_sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=target, text=True).strip()
        results[arm] = {'sourceSha': source_sha, 'packageSha256': package_sha, 'contexts': verify_workers(receipt, arm == 'B'),
                        'firstLookup': receipt['firstLookup']}
    if semantic['A'] != semantic['B']:
        raise ValueError('Persisted content, media, storage, or restart lookup results differ')
    first_queries = [{key: value for key, value in results[arm]['firstLookup'].items() if key != 'elapsedMs'} for arm in 'AB']
    if first_queries[0] != first_queries[1]:
        raise ValueError('First post-import lookup differs across sources')
    (output / 'verification.json').write_text(json.dumps({'status': 'passed', 'authoritativeTiming': False,
                                                         'dictionary': args.dictionary, 'arms': results}, indent=2) + '\n')


if __name__ == '__main__':
    main()
