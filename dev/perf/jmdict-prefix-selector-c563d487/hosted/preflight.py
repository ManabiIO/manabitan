#!/usr/bin/env python3
"""Run all six production-path smoke modes before any timing acquisition."""
import argparse
import json
import pathlib
from cohort_tools import child, sha

parser = argparse.ArgumentParser()
for name in ['baseline', 'candidate', 'output']:
    parser.add_argument(name, type=pathlib.Path)
args = parser.parse_args()
here = pathlib.Path(__file__).resolve().parent
args.output.mkdir(parents=True, exist_ok=True)
arms = [
    ('baseline', args.baseline, ['--baseline']),
    ('candidate', args.candidate, []),
    ('diagnostic', args.candidate, [str(args.output / 'diagnostic.wasm')]),
    ('disabled-baseline', args.baseline, ['--baseline', '--disabled-reuse']),
    ('disabled-candidate', args.candidate, ['--disabled-reuse']),
    ('disabled-diagnostic', args.candidate, [str(args.output / 'diagnostic.wasm'), '--disabled-reuse']),
]
report = {'scope': 'Six untimed production-path smoke modes; failures preserve every completed child',
    'preflightSha256': sha(pathlib.Path(__file__)), 'smokeSha256': sha(here / 'smoke.mjs'),
    'arms': [], 'complete': False}
def save():
    (args.output / 'smoke-report.json').write_text(json.dumps(report, indent=2) + '\n')
save()
try:
    for name, source, options in arms:
        data = child(['node', '--max-old-space-size=512', str(here / 'smoke.mjs'), str(source), *options], args.output / f'smoke-{name}')
        assert data['complete'] and data['validCases'] == 50 and data['malformedCases'] == 16 and data['fallbackCases'] == 3
        assert data['harnessHash'] == report['smokeSha256']
        if report['arms']:
            assert data['results'] == report['arms'][0]['result']['results'], name
        if name == 'diagnostic':
            assert data['nativeDiagnostics']['hits'] > 0 and data['nativeDiagnostics']['originalGlossaryReuses'] > 0
        if name == 'disabled-diagnostic':
            for key in ['keyIdentityRows', 'admissions', 'selected', 'hits', 'originalGlossaryReuses', 'totalGlossaryReuses', 'priorStreakRows', 'budgetPositiveRows', 'budgetRefreshByRecentStreak']:
                assert data['nativeDiagnostics'][key] == 0, key
        report['arms'].append({'name': name, 'result': data})
        save()
    report['complete'] = True
    save()
    print('PREFIX_SELECTOR_SMOKE ' + json.dumps({'complete': True, 'validCases': 50, 'malformedCases': 16,
        'fallbackCases': 3, 'equalSixModes': True, 'diagnostic': report['arms'][2]['result']['nativeDiagnostics'],
        'disabledDiagnostic': report['arms'][5]['result']['nativeDiagnostics']}, separators=(',', ':')), flush=True)
except Exception as error:
    report['error'] = str(error)
    save()
    raise
