#!/usr/bin/env python3
"""Diagnostic lane only. Reuse exact source/fixture construction, never timing claims."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import types

path = Path(__file__).with_name('zip-ranges-20260919.py')
source = path.read_text()
old = "for layout, blocks in [('large', args.blocks), ('original', 2)]:"
assert source.count(old) == 1
# Two ABBA blocks plus same-binary controls and excluded warmups on large ZIPs.
source = source.replace(old, "for layout, blocks in [('large', args.blocks)]:")
module = types.ModuleType('zip_range_diagnostic')
module.__file__ = str(path)
exec(compile(source, str(path), 'exec'), module.__dict__)
original_run = module.run


def sample(root_pid):
    parents, commands = {}, {}
    for directory in Path('/proc').iterdir():
        if not directory.name.isdecimal():
            continue
        try:
            stat = (directory / 'stat').read_text()
            parents[int(directory.name)] = int(stat[stat.rfind(')') + 2:].split()[1])
            commands[int(directory.name)] = (directory / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
        except (OSError, ValueError, IndexError):
            pass
    descendants = {root_pid}
    while True:
        added = {pid for pid, parent in parents.items() if parent in descendants} - descendants
        if not added:
            break
        descendants.update(added)
    chrome = {pid for pid in descendants if '/chrome-linux64/chrome ' in commands.get(pid, '')}
    if not chrome:
        return None
    included = set(chrome)
    while True:
        added = {pid for pid, parent in parents.items() if parent in included} - included
        if not added:
            break
        included.update(added)
    processes = []
    for pid in sorted(included):
        try:
            values = {}
            for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
                key, _, rest = line.partition(':')
                if key in ('Rss', 'Pss', 'Private_Clean', 'Private_Dirty'):
                    values[key] = int(rest.split()[0]) * 1024
            if 'Pss' in values and 'Rss' in values:
                processes.append({'pid': pid, 'parent': parents.get(pid), **values})
        except (OSError, ValueError, IndexError):
            pass
    return {'monotonic': time.monotonic(), 'processes': processes,
            'pss': sum(p['Pss'] for p in processes), 'rss': sum(p['Rss'] for p in processes)} if processes else None


def monitored_run(args, log, timeout=300):
    if len(args) < 2 or args[1] != 'dev/perf/import-benchmark.js':
        return original_run(args, log, timeout)
    samples = []
    with Path(log).open('w') as output:
        process = subprocess.Popen(args, cwd=module.ROOT, stdout=output, stderr=subprocess.STDOUT)
        start = time.monotonic()
        try:
            while process.poll() is None:
                if time.monotonic() - start > timeout:
                    process.terminate()
                    raise TimeoutError('Diagnostic import timed out')
                value = sample(process.pid)
                if value:
                    samples.append(value)
                time.sleep(0.05)
            if process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, args)
            if len(samples) < 2:
                raise RuntimeError('No usable whole-browser memory samples')
        finally:
            Path(log).with_suffix('.memory.json').write_text(json.dumps({
                'diagnosticOnly': True, 'authoritativeTiming': False,
                'scope': 'Chromium descendants of the import harness; whole run including setup and probes',
                'sampleTargetMs': 50, 'samples': samples,
                'peakPss': max((v['pss'] for v in samples), default=None),
                'peakRss': max((v['rss'] for v in samples), default=None),
            }, indent=2))
module.run = monitored_run
module.main()
out = Path(sys.argv[sys.argv.index('--out') + 1]).resolve()
(out / 'DIAGNOSTIC_ONLY.txt').write_text('Memory sampling perturbs every import in this lane. None of its elapsed-time estimates are authoritative. PSS apportions shared mappings; RSS double counts them. Samples are whole-run and may miss true peaks. Detached helpers and unrelated browser processes are excluded.\n')
for name in ('baseline.zip', 'candidate.zip'):
    (out / name).unlink()
