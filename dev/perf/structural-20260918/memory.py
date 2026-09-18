#!/usr/bin/env python3
"""Diagnostic memory lane only; never use these runs as authoritative timing."""
import json
import os
import pathlib
import re
import statistics
import subprocess
import time

out = pathlib.Path('builds/bounded-memory')
out.mkdir(parents=True, exist_ok=True)
dictionary = os.environ['DICTIONARY']
plan = list('ABBAABBA')
(out / 'plan.json').write_text(json.dumps(plan))
results = []

def sample(root_pid):
    table = {}
    for proc in pathlib.Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            text = (proc / 'stat').read_text()
            # stat fields after the parenthesized comm begin at field 3.
            tail = text[text.rindex(')') + 2:].split()
            table[int(proc.name)] = (int(tail[1]), tail[19])
        except (OSError, ValueError, IndexError):
            continue
    descendants = {root_pid}
    previous = -1
    while previous != len(descendants):
        previous = len(descendants)
        descendants.update(pid for pid, (parent, _) in table.items() if parent in descendants)
    rows = []
    vanished = []
    for pid in sorted(descendants):
        p = pathlib.Path('/proc') / str(pid)
        try:
            exe = os.readlink(p / 'exe')
            if '/chrome' not in exe or pathlib.Path(exe).name not in ['chrome', 'chrome_crashpad_handler', 'headless_shell']:
                continue
            smaps = (p / 'smaps_rollup').read_text()
            values = {key: int(value) for key, value in re.findall(r'^(Rss|Pss):\s+(\d+)\s+kB$', smaps, re.M)}
            assert set(values) == {'Rss', 'Pss'}
            stat = (p / 'stat').read_text()
            if stat[stat.rindex(')') + 2:].split()[19] != table[pid][1]:
                vanished.append(pid)
                continue
            rows.append({'pid': pid, 'startTicks': table[pid][1], 'exe': exe, 'rssKiB': values['Rss'], 'pssKiB': values['Pss']})
        except FileNotFoundError:
            vanished.append(pid)
        except ProcessLookupError:
            vanished.append(pid)
    return {'processes': rows, 'vanishedPids': vanished,
            'rssKiB': sum(x['rssKiB'] for x in rows), 'pssKiB': sum(x['pssKiB'] for x in rows)}

for index, arm in enumerate(plan):
    report = out / f'{index:02d}-{arm}.html'
    env = {k: v for k, v in os.environ.items() if not k.startswith(('MANABITAN_E2E_', 'MANABITAN_CHROMIUM_'))}
    env.update({
        'MANABITAN_CHROMIUM_HEADLESS': '1',
        'MANABITAN_CHROMIUM_E2E_REPORT': str(report),
        'MANABITAN_E2E_IMPORT_BENCH_QUICK': '1',
        'MANABITAN_E2E_IMPORT_BENCH_DICTIONARY': dictionary,
        'MANABITAN_E2E_USE_PERF_DICTIONARY_LOCK': '1',
        'MANABITAN_E2E_IMPORT_USE_PRODUCTION_DEFAULTS': '1',
        'MANABITAN_E2E_IMPORT_FLAGS_JSON': json.dumps({'experimentalNativeSegmentedLookup': True} if arm == 'B' else {}),
        'MANABITAN_E2E_SKIP_BUILD': '1',
        'MANABITAN_E2E_PHASE_PROFILING': '0',
        'MANABITAN_E2E_PHASE_SCREENSHOTS': '0',
        # Mark the entire run diagnostic; parent-only built-in sampling is not
        # the complete process-tree data collected by this external sampler.
        'MANABITAN_E2E_PROCESS_SAMPLING': '1',
    })
    samples = []
    start = time.monotonic()
    with (out / f'{index:02d}-{arm}.log').open('w') as log:
        child = subprocess.Popen(['node', 'test/chromium/extension-two-dictionary-import.e2e.js'], env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            while child.poll() is None:
                if time.monotonic() - start > 240:
                    raise TimeoutError('Memory import did not finish')
                data = sample(child.pid)
                data['elapsedSeconds'] = time.monotonic() - start
                samples.append(data)
                time.sleep(0.05)
            if child.returncode != 0:
                raise RuntimeError(f'Import failed: {index} {arm} {child.returncode}')
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=15)
            (out / f'{index:02d}-{arm}-samples.json').write_text(json.dumps(samples))
    data = json.loads(report.with_suffix('.json').read_text())
    assert data['status'] == 'success'
    active = [s for s in samples if len(s['processes']) >= 3]
    assert len(active) >= 10
    result = {'index': index, 'arm': arm, 'sampleCount': len(samples),
              'peakSampledTreeRssKiB': max(s['rssKiB'] for s in active),
              'peakSampledTreePssKiB': max(s['pssKiB'] for s in active),
              'maxProcesses': max(len(s['processes']) for s in active),
              'authoritativeTiming': False}
    results.append(result)
    (out / 'observations.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(result), flush=True)
summary = {'scope': '50ms-target whole-run descendant Chromium samples, including setup and post-import validation; sampled peaks, not guaranteed true peaks',
           'rssCaveat': 'Summed RSS double counts shared mappings; summed PSS apportions them.', 'authoritativeTiming': False}
for metric in ['peakSampledTreeRssKiB', 'peakSampledTreePssKiB']:
    a = [x[metric] for x in results if x['arm'] == 'A']
    b = [x[metric] for x in results if x['arm'] == 'B']
    changes = []
    for offset in [0, 4]:
        for ai, bi in [(0, 1), (3, 2)]:
            changes.append(100 * (results[offset+bi][metric] / results[offset+ai][metric] - 1))
    summary[metric] = {'offMedianKiB': statistics.median(a), 'onMedianKiB': statistics.median(b), 'pairedPct': changes, 'medianPairedPct': statistics.median(changes)}
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
