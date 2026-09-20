#!/usr/bin/env python3
"""Diagnostic-only browser memory; elapsed values from these runs are not evidence."""
import importlib.util,json,os,shutil,subprocess,sys,time
from pathlib import Path
p=Path(__file__).with_name('jj-lazy-screen.py')
s=importlib.util.spec_from_file_location('lazy_candidate',p);module=importlib.util.module_from_spec(s);s.loader.exec_module(module)
m=module.m
original=m.run

def sample(root):
    parents={};names={}
    for directory in Path('/proc').iterdir():
        if not directory.name.isdecimal():continue
        try:
            value=(directory/'stat').read_text();pid=int(directory.name)
            parents[pid]=int(value[value.rfind(')')+2:].split()[1])
            names[pid]=Path(os.readlink(directory/'exe')).name
        except (OSError,ValueError,IndexError):pass
    descendants={root}
    while True:
        added={pid for pid,parent in parents.items() if parent in descendants}-descendants
        if not added:break
        descendants.update(added)
    included={pid for pid in descendants if names.get(pid) in ('chrome','chromium','headless_shell')}
    if not included:return None
    while True:
        added={pid for pid,parent in parents.items() if parent in included}-included
        if not added:break
        included.update(added)
    processes=[]
    for pid in sorted(included):
        try:
            values={}
            for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
                key,_,rest=line.partition(':')
                if key in ('Pss','Rss'):values[key]=int(rest.split()[0])*1024
            if set(values)=={'Pss','Rss'}:processes.append(dict(pid=pid,**values))
        except (OSError,ValueError,IndexError):pass
    return dict(monotonic=time.monotonic(),processes=processes,pss=sum(p['Pss'] for p in processes),rss=sum(p['Rss'] for p in processes)) if processes else None

def run(args,log,timeout=300):
    if len(args)<2 or args[1]!='dev/perf/import-benchmark.js':return original(args,log,timeout)
    samples=[]
    with Path(log).open('w') as output:
        process=subprocess.Popen(args,cwd=m.ROOT,stdout=output,stderr=subprocess.STDOUT);start=time.monotonic()
        try:
            while process.poll() is None:
                if time.monotonic()-start>timeout:
                    process.terminate();process.wait(timeout=10);raise TimeoutError('Diagnostic import timed out')
                value=sample(process.pid)
                if value:samples.append(value)
                time.sleep(.05)
            if process.returncode!=0:raise subprocess.CalledProcessError(process.returncode,args)
            if len(samples)<3:raise RuntimeError('Insufficient browser memory samples')
        finally:
            Path(log).with_suffix('.memory.json').write_text(json.dumps(dict(diagnosticOnly=True,authoritativeTiming=False,sampleTargetMs=50,scope='descendant browser processes; whole run including setup and probes',samples=samples,peakPss=max((s['pss'] for s in samples),default=None),peakRss=max((s['rss'] for s in samples),default=None)),indent=2))
m.run=run
try:m.main()
finally:
    out=Path(sys.argv[sys.argv.index('--out')+1]).resolve()
    if out.exists():
        for name in ['jj-message-screen.py','jj-lazy-screen.py','jj-lazy-memory.py']:shutil.copyfile(p.with_name(name),out/name)
        (out/'DIAGNOSTIC_ONLY.txt').write_text('Sampling perturbs all runs here. Do not use their elapsed times as performance evidence. Whole-run samples can miss true peaks. PSS apportions shared mappings; RSS double-counts them. Detached helpers are excluded.\n')
