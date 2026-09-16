#!/usr/bin/env python3
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import time

BASE = '30ffb604e0a87f0aa252bd4331bc54668062b1e1'
TREE = 'c069f4ca92d8e6902a1a182281a06b2579610c05'
variant = os.environ['CANDIDATE']
dictionary = os.environ['DICTIONARY']
configs = {
    'workers3-groups4': (3, 4, 3),
    'workers4-groups4': (4, 4, 3),
    'workers3-groups3': (3, 3, 3),
    'workers4-groups2': (4, 2, 2),
}
assert variant in configs and dictionary in ('jmdict', 'jitendex')
root = Path.cwd()
out = root / 'builds/parser-concurrency-screen'
out.mkdir(parents=True, exist_ok=True)
package = root / 'builds/manabitan-chrome-dev.zip'
source = root / 'ext/js/dictionary/term-bank-wasm-parser.js'
worker_test = root / 'test/term-bank-wasm-parser.test.js'


def run(args):
    return subprocess.check_output(args, cwd=root, text=True).strip()


def sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


assert run(['git', 'rev-parse', 'HEAD']) == BASE
assert run(['git', 'rev-parse', 'HEAD^{tree}']) == TREE
base_package = Path(os.environ['RUNNER_TEMP']) / 'parser-base.zip'
shutil.copy2(package, base_package)
base_package_hash = sha(base_package)
workers, plain_groups, media_groups = configs[variant]
s = source.read_text()
for old, new in [
    ('const DEFAULT_PARALLEL_SOURCE_WORKER_COUNT = 2;', f'const DEFAULT_PARALLEL_SOURCE_WORKER_COUNT = {workers};'),
    ('const PLAIN_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = 4;', f'const PLAIN_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = {plain_groups};'),
    ('const MEDIA_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = 3;', f'const MEDIA_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = {media_groups};'),
]:
    assert s.count(old) == 1
    s = s.replace(old, new)
source.write_text(s)
# The policy tests intentionally pin the established default worker count. A
# source candidate that changes that policy must update the three affected
# expected values; all other parser tests remain unchanged.
t = worker_test.read_text()
for descriptor in [
    '{hardwareConcurrency: 12, deviceMemory: 4}',
    '{hardwareConcurrency: 4, deviceMemory: 8}',
    '{}',
]:
    old = f'[{descriptor}, 2]'
    new = f'[{descriptor}, {workers}]'
    assert t.count(old) == 1
    t = t.replace(old, new)
worker_test.write_text(t)
subprocess.run(['git', 'diff', '--check'], cwd=root, check=True)
with open(out/'focused.log','w') as log:
    subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'test/term-bank-wasm-parser.test.js', 'test/term-bank-experiments.test.js', 'test/term-bank-composite-state.test.js', 'test/lookup-construction-experiments.test.js'], cwd=root, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=240)
subprocess.run(['git', 'add', str(source.relative_to(root)), str(worker_test.relative_to(root))], cwd=root, check=True)
subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Manabitan contributors', '-c', 'user.email=contributors@manabi.io', 'commit', '-m', f'Isolated parser concurrency candidate: {variant}'], cwd=root, check=True, stdout=subprocess.DEVNULL)
candidate = run(['git', 'rev-parse', 'HEAD'])
candidate_tree = run(['git', 'rev-parse', 'HEAD^{tree}'])
with open(out/'candidate-build.log','w') as log:
    subprocess.run(['node', 'dev/bin/build.js', '--target', 'chrome-dev'], cwd=root, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=240)
candidate_package = Path(os.environ['RUNNER_TEMP']) / 'parser-candidate.zip'
shutil.copy2(package, candidate_package)
candidate_package_hash = sha(candidate_package)
(out/'candidate.patch').write_text(run(['git', 'diff', BASE, candidate, '--', str(source.relative_to(root)), str(worker_test.relative_to(root))]) + '\n')
identities = {
    'A': {'commit': BASE, 'tree': TREE, 'package': base_package_hash},
    'B': {'commit': candidate, 'tree': candidate_tree, 'package': candidate_package_hash},
}
plan = [
    {'kind':'warmup','pair':0,'arm':'A','binary':'A'},
    {'kind':'warmup','pair':0,'arm':'B','binary':'B'},
]
for pair in range(1, 7):
    order = 'AB' if pair % 2 else 'BA'
    plan.extend({'kind':'measured','pair':pair,'arm':arm,'binary':arm} for arm in order)
    if pair % 2 == 0:
        aa = 'AB' if pair != 4 else 'BA'
        plan.extend({'kind':'aa','pair':pair//2,'arm':arm,'binary':'A'} for arm in aa)
(out/'plan.json').write_text(json.dumps({'baseline':BASE,'candidate':candidate,'dictionary':dictionary,'variant':variant,'config':{'workers':workers,'plainGroupsPerWorker':plain_groups,'mediaGroupsPerWorker':media_groups},'identities':identities,'plan':plan,'noRetries':True,'noOutlierRemoval':True}, indent=2))
observations=[]
for ordinal,item in enumerate(plan,1):
    identity=identities[item['binary']]
    subprocess.run(['git','checkout','--detach',identity['commit']],cwd=root,check=True,stdout=subprocess.DEVNULL)
    if run(['git','status','--porcelain']): raise RuntimeError(f'dirty source {ordinal}')
    shutil.copy2(base_package if item['binary']=='A' else candidate_package, package)
    destination=out/f"{ordinal:02d}-{item['kind']}-{item['pair']}-{item['arm']}"
    started=time.monotonic()
    with open(str(destination)+'.log','w') as log:
        subprocess.run(['node','dev/perf/import-benchmark.js',dictionary,'--runs','1','--no-build','--flags','{}','--output',str(destination)],cwd=root,check=True,stdout=log,stderr=subprocess.STDOUT,timeout=240)
    summary=json.loads((destination/'summary.json').read_text()); report=json.loads((destination/'run-1.json').read_text())
    if report.get('status')!='success' or report.get('skippedVerification') is not False: raise RuntimeError(f'invalid report {ordinal}')
    measurement=summary['runs'][0]
    row={**item,'ordinal':ordinal,'ms':measurement['totalImportMs'],'workerMs':measurement['workerImportMs'],'browser':summary['browserVersion'],'validation':measurement['validation'],'importDebug':measurement.get('importDebug'),'sourceCommit':summary['source']['gitSha'],'package':summary['source']['sha256']['builds/manabitan-chrome-dev.zip'],'wallSeconds':time.monotonic()-started}
    if row['sourceCommit'] != identity['commit'] or row['package'] != identity['package']: raise RuntimeError(f'identity mismatch {ordinal}')
    observations.append(row); (out/'observations.json').write_text(json.dumps(observations,indent=2)); print(json.dumps({'ordinal':ordinal,'kind':item['kind'],'pair':item['pair'],'arm':item['arm'],'ms':row['ms']}),flush=True)
(out/'complete.json').write_text(json.dumps({'completed':len(observations),'planned':len(plan)},indent=2))
