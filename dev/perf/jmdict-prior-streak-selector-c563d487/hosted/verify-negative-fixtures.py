#!/usr/bin/env python3
"""Verify deterministic pre-acquisition fixtures against the frozen excluded model run."""
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
expected = {'manifest.json': '7291d348f059862bbb51df976902d0cd21cb2115757e49d0020e59ae4483be54', 'state-model-result.json': 'fbd0863047d88d3f358b7ee54de924c4caf18e201e52f196918df3c8a12f10dd', 'preparation-receipt.json': '20b77f4351b8530e97de097153eb4dc6a39a50df1051c491277140c455c44822'}
actual = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in expected}
assert actual == expected, {'expected': expected, 'actual': actual}
print('PRIOR_STREAK_NEGATIVE_FIXTURE_IDENTITY ' + json.dumps(actual, sort_keys=True), flush=True)
