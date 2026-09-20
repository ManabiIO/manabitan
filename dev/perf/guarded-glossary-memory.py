#!/usr/bin/env python3
"""Diagnostic only: all elapsed times in this lane are instrumented, not authoritative."""
import importlib.util, json, os, signal, subprocess, sys, time
from pathlib import Path
p=Path(__file__).with_name('jj-glossary-confirm.py')
spec=importlib.util.spec_from_file_location('cohort',p)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original_run=m.run

def sample(root):
    parents={};commands={}
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():continue
        try:
            raw=(path/'stat').read_text();pid=int(path.name)
            parents[pid]=int(raw[raw.rfind(')')+2:].split()[1])
            commands[pid]=(path/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
        except (OSError,ValueError,IndexError):continue
    def descendants(ids):
        ids=set(ids)
        while True:
            new={pid for pid,parent in parents.items() if parent in ids}-ids
            if not new:return ids
            ids.update(new)
    browser={pid for pid in descendants([root]) if '/chrome-linux64/chrome ' in commands.get(pid,'')}
    if not browser:return None
    rows=[]
    for pid in descendants(browser):
        try:
            values={}
            for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
                key,_,value=line.partition(':')
                if key in ('Pss','Rss'):values[key]=int(value.split()[0])*1024
            if set(values)=={'Pss','Rss'}:rows.append({'pid':pid,'parent':parents.get(pid),**values})
        except (OSError,ValueError,IndexError):continue
    return {'monotonic':time.monotonic(),'processes':rows,'pss':sum(r['Pss'] for r in rows),'rss':sum(r['Rss'] for r in rows)} if rows else None

def measured(args,log):
    if len(args)<2 or args[1]!='dev/perf/import-benchmark.js':return original_run(args,log)
    samples=[]
    with Path(log).open('w') as f:
        child=subprocess.Popen(args,cwd=m.ROOT,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
        start=time.monotonic()
        try:
            while child.poll() is None:
                if time.monotonic()-start>180:raise TimeoutError('Memory-lane import timed out')
                row=sample(child.pid)
                if row:samples.append(row)
                time.sleep(.05)
            if child.returncode:raise subprocess.CalledProcessError(child.returncode,args)
            if len(samples)<3:raise RuntimeError('Missing usable complete-browser samples')
        finally:
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=10)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
            Path(log).with_suffix('.memory.json').write_text(json.dumps({'diagnosticOnly':True,'authoritativeTiming':False,'sampleTargetMs':50,'samples':samples,'peakPss':max((r['pss'] for r in samples),default=None),'peakRss':max((r['rss'] for r in samples),default=None)},indent=2))
m.run=measured
m.main()
out=Path(sys.argv[sys.argv.index('--out')+1]).resolve()
(out/'DIAGNOSTIC_ONLY.txt').write_text('Every observation in this lane has external memory sampling. Inner browser timing reports do not know about this sampler. None of their elapsed-time metrics may be used as authoritative speed evidence. Scope: all Chromium descendants of the harness, whole run including setup and probes. Target interval 50 ms; sampled peaks can miss true peaks. PSS apportions shared mappings; summed RSS double-counts them. Detached helpers are excluded.\n')
r=json.loads((out/'results.json').read_text());r['authoritativeTiming']=False;r['externalMemorySampling']=True
(out/'results.json').write_text(json.dumps(r,indent=2))
(out/'memory-driver.py').write_bytes(Path(__file__).read_bytes())
