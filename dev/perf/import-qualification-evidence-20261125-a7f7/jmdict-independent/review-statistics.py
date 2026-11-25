# SPDX-License-Identifier: GPL-3.0-or-later
"""Reproduce the isolated synthetic review of the frozen qualification runner."""

import ast
import collections
import hashlib
import json
from pathlib import Path
import random
import statistics
import sys
from types import SimpleNamespace

path = Path(sys.argv[1])
source = path.read_text()
receipt = json.loads((Path(__file__).resolve().parent / 'receipts/qualification-statistical-review.json.txt').read_text())
assert hashlib.sha256(source.encode()).hexdigest() == receipt['finalReviewedRunnerSha256']
tree = ast.parse(source)
start = next(i for i, node in enumerate(tree.body) if isinstance(node, ast.Assign)
             and any(isinstance(target, ast.Name) and target.id == 'schedule' for target in node.targets))
stop = next(i for i, node in enumerate(tree.body[start + 1:], start + 1)
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name) and node.value.func.id == 'write_json')
body = ast.Module(body=tree.body[start:stop], type_ignores=[])
schedules = {}
for order in ['AB', 'BA']:
    namespace = {'args': SimpleNamespace(initial_order=order, pairs=12)}
    exec(compile(body, str(path), 'exec'), namespace)
    schedule = namespace['schedule']
    assert len(schedule) == len({row['id'] for row in schedule}) == 36
    assert collections.Counter(row['kind'] for row in schedule) == {'warmup': 4, 'candidate': 24, 'control': 8}
    for kind, expected in [('candidate', {'AB': 6, 'BA': 6}), ('control', {'AC': 2, 'CA': 2})]:
        pairs = {}
        for row in schedule:
            if row['kind'] == kind:
                pairs.setdefault(row['pair'], []).append(row['arm'])
        assert collections.Counter(''.join(value) for value in pairs.values()) == expected
    schedules[order] = schedule
for before, after in zip(schedules['AB'], schedules['BA']):
    assert before['kind'] == after['kind'] and before['pair'] == after['pair'] and before['arm'] != after['arm']

function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'paired_summary')
namespace = {'random': random, 'statistics': statistics}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), namespace)
namespace['observations'] = [
    {**row, 'totalImportMs': 999999 if row['kind'] == 'warmup' else 90 if row['arm'] == 'B' else 100}
    for row in schedules['AB']
]
candidate = namespace['paired_summary']('candidate', 'A', 'B')
control = namespace['paired_summary']('control', 'A', 'C')
assert candidate == receipt['candidateSyntheticSummary']
assert control == receipt['controlSyntheticSummary']
assert namespace['paired_summary']('candidate', 'A', 'B') == candidate
namespace['observations'] = [row for row in namespace['observations']
                             if not (row['kind'] == 'candidate' and row['pair'] == 1 and row['arm'] == 'B')]
try:
    namespace['paired_summary']('candidate', 'A', 'B')
except RuntimeError:
    pass
else:
    raise AssertionError('Incomplete pair accepted')
print(json.dumps({'runnerSha256': receipt['finalReviewedRunnerSha256'], 'checks': receipt['checks'],
                  'candidateSyntheticSummary': candidate, 'controlSyntheticSummary': control}, indent=2))
