#!/usr/bin/env python3
"""Run a child under the reused Linux process-tree memory observer."""

import argparse
import json
from pathlib import Path
import sys

from chromium_memory import run_with_sampling


parser = argparse.ArgumentParser()
parser.add_argument('--cwd', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--storage-path')
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
if args.command and args.command[0] == '--':
    args.command = args.command[1:]
if not args.command:
    parser.error('provide a command after --')
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
summary = run_with_sampling(args.command, args.cwd, out/'process.log', out/'memory.json', out/'markers.jsonl')
if args.storage_path:
    root = Path(args.storage_path)
    files = [path for path in root.rglob('*') if path.is_file()]
    summary['storage'] = {'path': str(root), 'fileCount': len(files),
                          'logicalBytes': sum(path.stat().st_size for path in files),
                          'allocatedBytes': sum(path.stat().st_blocks * 512 for path in files)}
    receipt = out/'memory.json'
    receipt.write_text(json.dumps({**json.loads(receipt.read_text()), 'storage': summary['storage']}, indent=2) + '\n')
print(json.dumps(summary, separators=(',', ':')))
sys.exit(0 if summary['qualifiedForWholeTreePss'] else 1)
