#!/usr/bin/env python3
"""Build one existing checkout and preserve the outcome without changing source."""

from pathlib import Path
import json
import subprocess
import sys

root = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(__file__).resolve().parents[2]
stage = root / 'evidence-staging/package'
stage.mkdir(parents=True, exist_ok=True)
name = sys.argv[1]
if name not in ['manabitan-base', 'jmdict', 'jitendex', 'vndb']:
    raise SystemExit('Unknown checkout')
repo = root / name
receipt_path = stage / f'{name}-build.json'
log_path = stage / f'{name}-build.log'
command = ['npm', 'run', 'build', '--', '--target', 'chrome']
receipt = {
    'checkout': name,
    'path': str(repo),
    'head': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
    'command': command,
    'status': 'running',
    'exitCode': None,
    'log': log_path.name,
    'trackedStatusBefore': subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain', '--untracked-files=no'], text=True),
}
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
with log_path.open('wb') as log:
    completed = subprocess.run(command, cwd=repo, stdout=log, stderr=subprocess.STDOUT, check=False)
receipt['exitCode'] = completed.returncode
receipt['status'] = 'success' if completed.returncode == 0 else 'failed'
receipt['trackedStatusAfter'] = subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain', '--untracked-files=no'], text=True)
receipt['trackedDiffAfter'] = subprocess.check_output(['git', '-C', str(repo), 'diff', '--stat'], text=True)
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
raise SystemExit(completed.returncode)
