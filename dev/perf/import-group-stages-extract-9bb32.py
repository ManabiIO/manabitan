#!/usr/bin/env python3
"""Read-only coordinator event audit. This never starts an import or a browser."""
import argparse
import hashlib
import json
import math
from pathlib import Path

EVENTS = {
    'pipelineStart': 1, 'groupReady': 2, 'sinkEnter': 3, 'sinkRelease': 4,
    'dbBegin': 5, 'dedupBegin': 6, 'dedupEnd': 7, 'contentDispatch': 8,
    'contentBegin': 9, 'compressionStart': 10, 'storageReady': 11,
    'metadataPublished': 12, 'recordBegin': 13, 'recordDone': 14,
    'joinBegin': 15, 'compressionDone': 16, 'contentDone': 17,
    'contentObserved': 18, 'joinSettled': 19, 'dbDone': 20,
    'pipelineEnd': 21, 'operationFailed': 22, 'unsupportedRoute': 23,
}
REQUIRED = {
    1: ['dbBegin', 'dedupBegin', 'dedupEnd', 'contentDispatch', 'storageReady',
        'metadataPublished', 'joinBegin', 'contentObserved', 'joinSettled', 'dbDone'],
    2: ['contentBegin', 'compressionStart', 'compressionDone', 'contentDone'],
    3: ['recordBegin', 'recordDone'],
}
PHASE = 'diagnostic-coordinator-groups-v1'


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Inconclusive(ValueError):
    pass


def audit(report, summary, plan):
    checks = []
    output = {
        'schemaVersion': 1,
        'scope': 'Coordinator-observed dependency order only; no CPU, worker-finish, or relative-speed claim.',
        'eligibleForDependencyAnalysis': False,
        'checks': checks,
        'rawCollectorPayload': None,
        'groups': [],
    }

    def check(name, actual, expected=True):
        try:
            ok = json.dumps(actual, sort_keys=True, allow_nan=False) == json.dumps(expected, sort_keys=True, allow_nan=False)
        except (TypeError, ValueError):
            ok = False
        checks.append({'name': name, 'passed': ok, 'actual': actual, 'expected': expected})
        return ok

    def need(name, condition):
        if not check(name, bool(condition)):
            raise Inconclusive(name)

    try:
        check('raw report succeeded', report.get('status'), 'success')
        check('raw report did not skip validation', report.get('skippedVerification'), False)
        check('build target', report.get('buildTarget'), 'chrome')
        check('dictionary', summary.get('dictionary'), 'jmdict')
        check('exact locked fixture', summary.get('fixture'), plan['fixture'])
        check('default flags, no overrides', summary.get('importFlags'), None)
        check('all-media verification mode', summary.get('mediaCheck'), 'all')
        check('unmodified harness trace setting', summary.get('traceEnabled'), False)
        # The unchanged harness calls its ordinary timestamps authoritative.
        # This overlay supersedes that label: none of them are performance evidence.
        pin = plan.get('overlaySourceCommit')
        need('source commit frozen before acquisition', isinstance(pin, str) and len(pin) == 40 and all(c in '0123456789abcdef' for c in pin))
        check('source revision', summary.get('gitSha'), pin)
        check('source provenance revision', summary.get('source', {}).get('gitSha'), pin)
        check('source checkout clean', summary.get('source', {}).get('dirty'), False)
        for name, digest in plan['unchangedHarnessSha256'].items():
            check('unchanged harness: ' + name, summary.get('source', {}).get('sha256', {}).get(name), digest)
        runs = summary.get('runs', [])
        need('one planned import in this slot', len(runs) == 1)
        run = runs[0]
        check('pre-import package audit passed', plan.get('packageAuditPassed'), True)
        check('actual audited package identity', report.get('packageSha256'), plan.get('expectedPackageSha256'))
        check('raw and summarized package identity', report.get('packageSha256'), run.get('packageSha256'))
        need('well-formed package hash', isinstance(report.get('packageSha256'), str) and len(report['packageSha256']) == 64)
        check('pinned installed browser version', report.get('browserVersion'), plan.get('expectedBrowserVersion'))
        check('raw and summarized browser identity', report.get('browserVersion'), run.get('browserVersion'))
        need('browser identity present', bool(report.get('browserVersion')))
        imports = [p for p in report.get('phases', []) if (p.get('data') or {}).get('kind') == 'dictionary-import']
        need('one raw import data phase', len(imports) == 1)
        raw_debug = imports[0]['data']['importDebug']
        diagnostics = [p for p in raw_debug.get('importerPhaseTimings', []) if p.get('phase') == PHASE]
        need('one untruncated diagnostic phase', len(diagnostics) == 1)
        text = diagnostics[0].get('details', {}).get('payload')
        need('scalar string payload within fixed export bound', isinstance(text, str) and len(text.encode()) <= 2 * 1024 * 1024)
        summarized = [p for p in run.get('importDebug', {}).get('importerPhaseTimings', []) if p.get('phase') == PHASE]
        need('one summarized diagnostic phase', len(summarized) == 1)
        check('raw payload preserved byte for byte', summarized[0].get('details', {}).get('payload'), text)
        data = json.loads(text)
        output['rawCollectorPayload'] = data
        output['rawCollectorPayloadSha256'] = sha(text.encode())
        # Avoid duplicating the large payload in the check list.
        checks[-1] = {'name': 'raw payload preserved byte for byte', 'passed': checks[-1]['passed'], 'sha256': sha(text.encode())}
        check('schema', data.get('schemaVersion'), 1)
        check('collector complete', data.get('complete'), True)
        check('no capture flags', data.get('flags'), 0)
        check('event vocabulary', data.get('eventNames'), EVENTS)
        check('operation vocabulary', data.get('operationKinds'), {'db': 1, 'content': 2, 'record': 3})
        check('one pipeline', data.get('pipelineCount'), 1)
        check('three observed workers', data.get('workerCount'), 3)
        check('twelve production groups', data.get('groupCount'), 12)
        check('bounds', data.get('limits'), {'events': 4096, 'groups': 64, 'operations': 1024})
        need('valid generation', type(data.get('generation')) is int and data['generation'] > 0)
        n, m, g = data['eventCount'], data['operationCount'], data['groupCount']
        need('bounded event count', type(n) is int and 0 < n <= 4096)
        need('bounded operation count', type(m) is int and 0 < m <= 1024)
        need('bounded group count', type(g) is int and 0 < g <= 64)
        event_columns, operation_columns = data['events'], data['operations']
        for key in ('code', 'group', 'operation', 'atMs', 'value'):
            need('event column ' + key, isinstance(event_columns.get(key), list) and len(event_columns[key]) == n)
        for key in ('kind', 'group', 'parent'):
            need('operation column ' + key, isinstance(operation_columns.get(key), list) and len(operation_columns[key]) == m)
        names = {v: k for k, v in EVENTS.items()}
        events = []
        for i in range(n):
            e = {k: event_columns[k][i] for k in ('code', 'group', 'operation', 'atMs', 'value')}
            need(f'event {i} vocabulary and scalars', type(e['code']) is int and e['code'] in names and type(e['group']) is int and type(e['operation']) is int and -1 <= e['group'] < g and 0 <= e['operation'] <= m and type(e['atMs']) in (int, float) and math.isfinite(e['atMs']) and e['atMs'] >= 0 and type(e['value']) in (int, float) and math.isfinite(e['value']))
            if i:
                check(f'event {i} monotonic coordinator clock', e['atMs'] >= events[-1]['atMs'])
            e['name'] = names[e['code']]
            e['sequence'] = i
            events.append(e)
        output['events'] = events
        operations = {}
        for i in range(m):
            kind, group, parent = (operation_columns[k][i] for k in ('kind', 'group', 'parent'))
            need(f'operation {i + 1} scalar identity', type(kind) is int and kind in REQUIRED and type(group) is int and 0 <= group < g and type(parent) is int and 0 <= parent < i + 1)
            op = {'id': i + 1, 'kind': kind, 'group': group, 'parent': parent, 'marks': {}}
            selected = [e for e in events if e['operation'] == i + 1]
            check(f'operation {i + 1} exact event multiset', sorted(e['name'] for e in selected), sorted(REQUIRED[kind]))
            for e in selected:
                check(f'operation {i + 1} event group {e["sequence"]}', e['group'], group)
                op['marks'][e['name']] = e
            need(f'operation {i + 1} required marks', all(k in op['marks'] for k in REQUIRED[kind]))
            operations[i + 1] = op
        output['operations'] = list(operations.values())

        def at(op, name):
            return op['marks'][name]['atMs']

        def ordered(label, values):
            check(label, all(a <= b for a, b in zip(values, values[1:])))

        for op in operations.values():
            oid, kind, marks = op['id'], op['kind'], op['marks']
            if kind == 1:
                check(f'db {oid} no parent', op['parent'], 0)
                ordered(f'db {oid} lifecycle', [at(op, k) for k in REQUIRED[1] if k != 'contentObserved'])
                ordered(f'db {oid} observed content before joined', [at(op, 'joinBegin'), at(op, 'contentObserved'), at(op, 'joinSettled')])
                check(f'db {oid} early shared route accepted', marks['contentDispatch']['value'], 1)
                check(f'db {oid} join succeeded', marks['joinSettled']['value'], 1)
                content = [c for c in operations.values() if c['kind'] == 2 and c['parent'] == oid]
                records = [c for c in operations.values() if c['kind'] == 3 and c['parent'] == oid]
                need(f'db {oid} explicit nonempty child sets', bool(content) and bool(records))
                check(f'db {oid} content cardinality', sum(c['marks']['contentBegin']['value'] for c in content), marks['dedupEnd']['value'])
                check(f'db {oid} record row cardinality', sum(c['marks']['recordBegin']['value'] for c in records), marks['dbBegin']['value'])
            else:
                parent = operations.get(op['parent'])
                need(f'operation {oid} DB parent', parent is not None and parent['kind'] == 1 and parent['group'] == op['group'])
                ordered(f'operation {oid} lifecycle', [at(op, k) for k in REQUIRED[kind]])
                if kind == 2:
                    # Dispatch completion is AFTER synchronous child creation.
                    ordered(f'content {oid} dispatch association', [at(parent, 'dedupEnd'), at(op, 'contentBegin'), at(op, 'compressionStart'), at(parent, 'contentDispatch')])
                    ordered(f'content {oid} joined observation', [at(op, 'contentDone'), at(parent, 'contentObserved'), at(parent, 'joinSettled')])
                else:
                    ordered(f'record {oid} joined observation', [at(parent, 'metadataPublished'), at(op, 'recordBegin'), at(parent, 'joinBegin'), at(op, 'recordDone'), at(parent, 'joinSettled')])
        global_events = [e for e in events if e['operation'] == 0 and e['group'] == -1]
        need('pipeline markers', [e['name'] for e in global_events] == ['pipelineStart', 'pipelineEnd'])
        check('pipeline start worker count', global_events[0]['value'], 3)
        check('pipeline end succeeded', global_events[1]['value'], 1)
        check('pipeline encloses all marks', events[0] == global_events[0] and events[-1] == global_events[1])
        group_marks = []
        db_counts = [0] * g
        content_counts, record_counts = [0] * m, [0] * m
        for op in operations.values():
            if op['kind'] == 1:
                db_counts[op['group']] += 1
            elif op['kind'] == 2:
                content_counts[op['parent'] - 1] += 1
            else:
                record_counts[op['parent'] - 1] += 1
        check('explicit DB counts', data.get('operationCounts', {}).get('dbByGroup'), db_counts)
        check('explicit content counts', data.get('operationCounts', {}).get('contentByOperation'), content_counts)
        check('explicit record counts', data.get('operationCounts', {}).get('recordByOperation'), record_counts)
        for group in range(g):
            selected = [e for e in events if e['operation'] == 0 and e['group'] == group]
            need(f'group {group} exact lifecycle', sorted(e['name'] for e in selected) == ['groupReady', 'sinkEnter', 'sinkRelease'])
            marks = {e['name']: e for e in selected}
            ordered(f'group {group} lifecycle order', [marks[k]['atMs'] for k in ('groupReady', 'sinkEnter', 'sinkRelease')])
            check(f'group {group} nonempty row count', marks['groupReady']['value'] > 0)
            check(f'group {group} transferred row count', marks['sinkEnter']['value'], marks['groupReady']['value'])
            dbs = [o for o in operations.values() if o['kind'] == 1 and o['group'] == group]
            need(f'group {group} has DB operations', bool(dbs))
            check(f'group {group} complete row accounting', sum(o['marks']['dbBegin']['value'] for o in dbs), marks['groupReady']['value'])
            dbs.sort(key=lambda o: at(o, 'dbBegin'))
            ordered(f'group {group} serial DB operations inside sink', [marks['sinkEnter']['atMs']] + [t for o in dbs for t in (at(o, 'dbBegin'), at(o, 'dbDone'))] + [marks['sinkRelease']['atMs']])
            if group:
                check(f'group {group} ordered sink advancement', group_marks[-1]['sinkRelease']['atMs'] <= marks['sinkEnter']['atMs'])
            group_marks.append(marks)
        check('full imported row cardinality', sum(m['groupReady']['value'] for m in group_marks), 528299)
        parser_phases = [p for p in raw_debug.get('importerPhaseTimings', []) if p.get('phase', '').startswith('term-file-fast-path:')]
        need('one production parser phase', len(parser_phases) == 1)
        for key, expected in plan['expectedNativeCounters'].items():
            check('native counter ' + key, parser_phases[0].get('details', {}).get(key), expected)
        check('observed DB operations match native calls', sum(o['kind'] == 1 for o in operations.values()), plan['expectedNativeCounters']['dedupNativeCallCount'])
        check('observed pending spans match native publication count', sum(o['marks']['dedupEnd']['value'] for o in operations.values() if o['kind'] == 1), plan['expectedNativeCounters']['dedupNativeBulkPendingRows'])
        validation = run.get('validation', {})
        for key, expected in plan['expectedPersistedValidation'].items():
            check('persisted validation ' + key, validation.get(key), expected)
        check('restart receipt', validation.get('restart'), plan['expectedRestartValidation'])
        check('exhaustive empty JMdict media receipt', validation.get('media'), plan['expectedMediaValidation'])
        observations = validation.get('lookup', {}).get('observations', [])
        check('72 sampled lookup observations', len(observations), 72)
        check('sampled semantic identity', [{k: o.get(k) for k in ('pass', 'term', 'results', 'originalTextLength', 'hasExactHeadwordMatch', 'sha256')} for o in observations], plan['expectedLookupObservations'])
        output['eligibleForDependencyAnalysis'] = all(c['passed'] for c in checks)
        if not output['eligibleForDependencyAnalysis']:
            return output
        for group, marks in enumerate(group_marks):
            dbs = [o for o in operations.values() if o['kind'] == 1 and o['group'] == group]
            contents = [o for o in operations.values() if o['kind'] == 2 and o['group'] == group]
            records = [o for o in operations.values() if o['kind'] == 3 and o['group'] == group]
            row = {'group': group, 'dbIds': [o['id'] for o in dbs], 'contentIds': [o['id'] for o in contents], 'recordIds': [o['id'] for o in records], 'marks': marks, 'segments': []}
            output['groups'].append(row)
            if group + 1 == g:
                row['classification'] = 'last group; no next-group opportunity'
                continue
            start = max(group_marks[group + 1]['groupReady']['atMs'], max(at(o, 'metadataPublished') for o in dbs), max(at(o, 'storageReady') for o in dbs), max(at(o, 'joinBegin') for o in dbs), max(at(o, 'recordDone') for o in records))
            end = max(at(o, 'joinSettled') for o in dbs)
            row.update({'nextGroupReadyObservedAtMs': group_marks[group + 1]['groupReady']['atMs'], 'allPrerequisitesObservedAtMs': start, 'allJoinsObservedAtMs': end, 'signedJoinRemainderMs': end - start, 'classification': 'observed dependency window' if end > start else 'no positive observed dependency window'})
            boundaries = {start, end}
            for o in contents:
                boundaries.update(at(o, k) for k in ('compressionDone', 'contentDone') if start < at(o, k) < end)
            for o in dbs:
                boundaries.update(at(o, k) for k in ('contentObserved', 'joinSettled') if start < at(o, k) < end)
            points = sorted(boundaries) if end > start else []
            for a, b in zip(points, points[1:]):
                pending_compression = [o['id'] for o in contents if at(o, 'compressionDone') > a]
                post_compression_content = [o['id'] for o in contents if at(o, 'compressionDone') <= a < at(o, 'contentDone')]
                continuation_only = [o['id'] for o in dbs if at(o, 'contentObserved') > a and all(at(c, 'contentDone') <= a for c in contents if c['parent'] == o['id'])]
                joined_continuation = [o['id'] for o in dbs if at(o, 'contentObserved') <= a < at(o, 'joinSettled')]
                row['segments'].append({'startMs': a, 'endMs': b, 'durationMs': b - a, 'pendingCompressionEnvelopeContentIds': pending_compression, 'postCompressionContentIds': post_compression_content, 'contentContinuationOnlyDbIds': continuation_only, 'joinContinuationOnlyDbIds': joined_continuation, 'allRemainingObservedContentObligationsPreCompression': bool(pending_compression) and not post_compression_content and not continuation_only and not joined_continuation})
    except (Inconclusive, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
        output['eligibleForDependencyAnalysis'] = False
        output['inconclusiveReason'] = f'{type(error).__name__}: {error}'
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--summary', type=Path, required=True)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    inputs = {}
    try:
        for name in ('report', 'summary', 'plan'):
            data = getattr(args, name).read_bytes()
            if len(data) > 32 * 1024 * 1024:
                raise Inconclusive(f'{name} exceeds bounded input size')
            inputs[name] = {'path': str(getattr(args, name)), 'sha256': sha(data), 'sizeBytes': len(data), 'value': json.loads(data)}
        result = audit(*(inputs[name]['value'] for name in ('report', 'summary', 'plan')))
    except Exception as error:
        result = {'schemaVersion': 1, 'eligibleForDependencyAnalysis': False, 'inconclusiveReason': f'{type(error).__name__}: {error}'}
    result['inputIdentities'] = {k: {x: v for x, v in item.items() if x != 'value'} for k, item in inputs.items()}
    result['extractorSha256'] = sha(Path(__file__).read_bytes())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return 0 if result['eligibleForDependencyAnalysis'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
