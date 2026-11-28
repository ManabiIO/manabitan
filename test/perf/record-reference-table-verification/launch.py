#!/usr/bin/env python3
"""Run one complete corpus verification and preserve every exit/signal/log."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--node', default='node', help='Node v22.22.0 executable')
parser.add_argument('--source-root', required=True)
parser.add_argument('--source-id', required=True, help='Exact checkout HEAD; runtime trees must match the recorded arm')
parser.add_argument('--corpus', choices=['jmdict', 'jitendex', 'vndb'], required=True)
parser.add_argument('--arm', choices=['A', 'B'], required=True)
parser.add_argument('--cache-dir', required=True, help='Directory containing archives from test/perf/dictionaries.lock.json')
parser.add_argument('--output', required=True, help='New acquisition directory; existing data is never overwritten')
parser.add_argument('--evidence-dir', help='Defaults to the evidence directory in the helper checkout')
parser.add_argument('--node-sha256', help='Optional exact platform-specific Node executable digest')
args = parser.parse_args()
here = Path(__file__).resolve().parent
node = shutil.which(args.node)
if node is None:
    parser.error(f'Cannot find Node executable: {args.node}')
output = Path(args.output).resolve()
logs = {kind: Path(str(output) + suffix) for kind, suffix in {
    'stdout': '.stdout.log', 'stderr': '.stderr.log', 'launcher': '.launcher.json'
}.items()}
if output.exists() or any(file.exists() for file in logs.values()):
    parser.error('Refusing to overwrite an existing acquisition or sidecar')
output.parent.mkdir(parents=True, exist_ok=True)
command = [node, '--max-old-space-size=512', str(here / 'run.mjs'),
           '--source-root', str(Path(args.source_root).resolve()), '--source-id', args.source_id,
           '--corpus', args.corpus, '--arm', args.arm,
           '--cache-dir', str(Path(args.cache_dir).resolve()), '--output', str(output)]
if args.evidence_dir is not None:
    command += ['--evidence-dir', str(Path(args.evidence_dir).resolve())]
if args.node_sha256 is not None:
    command += ['--node-sha256', args.node_sha256]
receipt = {'schemaVersion': 1, 'timingEligible': False, 'command': command,
           'deadlineSeconds': 1200, 'startedEpoch': time.time(),
           'launcherSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}

def checkpoint():
    logs['launcher'].write_text(json.dumps(receipt, indent=2) + '\n')

with logs['stdout'].open('xb') as stdout, logs['stderr'].open('xb') as stderr:
    child = subprocess.Popen(command, stdout=stdout, stderr=stderr)
    receipt.update(status='running', pid=child.pid)
    checkpoint()
    try:
        code = child.wait(timeout=receipt['deadlineSeconds'])
    except subprocess.TimeoutExpired:
        receipt['deadlineExceeded'] = True
        child.kill()
        code = child.wait()
    receipt.update(returncode=code,
                   terminatingSignal=signal.Signals(-code).name if code < 0 else None,
                   finishedEpoch=time.time(), status='complete' if code == 0 else 'failed')
    checkpoint()
print(json.dumps(receipt, indent=2))
sys.exit(0 if code == 0 else 1)
