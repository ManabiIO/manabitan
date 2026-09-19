#!/usr/bin/env python3
"""Diagnostic lane only: complete imports with descendant Chromium RSS/PSS.
Timing values in this lane are perturbed and must not be used for speed claims.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('owned', Path(__file__).with_name('owned-handoff-20260918.py'))
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)
original_command = owned.command


def sample(root_pid):
    processes = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            stat = (entry / 'stat').read_text()
            close = stat.rfind(')')
            fields = stat[close+2:].split()
            processes[int(entry.name)] = {'parent': int(fields[1]), 'name': stat[stat.index('(')+1:close]}
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    descendants = {root_pid}
    while True:
        found = {pid for pid, item in processes.items() if item['parent'] in descendants}
        additional = found - descendants
        if not additional:
            break
        descendants.update(additional)
    result = []
    for pid in descendants:
        item = processes.get(pid)
        if item is None or not item['name'].startswith(('chrome', 'chromium')):
            continue
        try:
            values = {}
            for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
                parts = line.split()
                if parts[0] in ('Rss:', 'Pss:'):
                    values[parts[0][:-1].lower() + 'Bytes'] = int(parts[1]) * 1024
            assert set(values) == {'rssBytes', 'pssBytes'}, (pid, values)
            result.append({'pid': pid, 'parent': item['parent'], 'name': item['name'], **values})
        except (FileNotFoundError, ProcessLookupError):
            continue
    return {'epochMs': time.time() * 1000, 'monotonicSeconds': time.monotonic(), 'processes': result,
            'rssBytes': sum(p['rssBytes'] for p in result), 'pssBytes': sum(p['pssBytes'] for p in result)}


def command(args, log=None, timeout=600, env=None):
    if len(args) < 2 or args[1] != 'dev/perf/import-benchmark.js':
        return original_command(args, log, timeout, env)
    assert log is not None
    log = Path(log)
    samples = []
    start = time.monotonic()
    with log.open('w') as output, log.with_suffix('.memory.jsonl').open('w') as memory:
        child = subprocess.Popen(args, cwd=owned.ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while child.poll() is None:
                before = time.monotonic()
                row = sample(child.pid)
                samples.append(row)
                memory.write(json.dumps(row) + '\n')
                memory.flush()
                if time.monotonic() - start > timeout:
                    raise subprocess.TimeoutExpired(args, timeout)
                time.sleep(max(0, 0.05 - (time.monotonic() - before)))
            if child.returncode != 0:
                raise subprocess.CalledProcessError(child.returncode, args)
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise
    populated = [row for row in samples if row['processes']]
    assert populated and len(populated) >= 5, 'No meaningful Chromium process samples'
    receipt = {
        'authoritativeTiming': False,
        'scope': 'whole descendant Chromium run including setup and post-import checks; sampling is not guaranteed true peak',
        'requestedIntervalMs': 50,
        'samples': len(samples), 'populatedSamples': len(populated),
        'peakPssBytes': max(row['pssBytes'] for row in populated),
        'peakRssBytes': max(row['rssBytes'] for row in populated),
        'maxProcesses': max(len(row['processes']) for row in populated),
    }
    log.with_suffix('.memory.json').write_text(json.dumps(receipt, indent=2) + '\n')


owned.command = command
owned.main()
