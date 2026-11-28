#!/usr/bin/env python3
"""Source/coverage receipts for one ordinary-default browser trace, not a benchmark."""
import collections
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys


def sha_file(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        while data := stream.read(1024 * 1024):
            digest.update(data)
    return digest.hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


def inventory_trace(trace):
    profiles = {}
    names = {(e['pid'], e['tid']): e.get('args', {}).get('name')
             for e in trace['traceEvents'] if e.get('name') == 'thread_name'}
    for event in trace['traceEvents']:
        if event.get('name') != 'Profile':
            continue
        key = (event['pid'], event['id'])
        if key in profiles:
            raise ValueError(f'Duplicate profile identity: {key}')
        profiles[key] = {'nodes': {}, 'samples': [], 'rawDeltas': [],
                         'tid': event['tid'], 'startTimeUs': event['args']['data']['startTime'],
                         'endTimeUs': None}
    for event in trace['traceEvents']:
        if event.get('name') != 'ProfileChunk':
            continue
        key = (event['pid'], event['id'])
        profile = profiles[key]
        data = event['args']['data']
        cpu = data.get('cpuProfile', {})
        for node in cpu.get('nodes', []):
            old = profile['nodes'].get(node['id'])
            if old is not None and old != node:
                raise ValueError(f'Changed profile node: {key}/{node["id"]}')
            profile['nodes'][node['id']] = node
        samples, deltas = cpu.get('samples', []), data.get('timeDeltas', [])
        if len(samples) != len(deltas):
            raise ValueError(f'Sample/delta mismatch: {key}')
        profile['samples'].extend(samples)
        profile['rawDeltas'].extend(deltas)
        if 'endTime' in data:
            if profile['endTimeUs'] is not None:
                raise ValueError(f'Duplicate profile end: {key}')
            profile['endTimeUs'] = data['endTime']
    result = []
    for (pid, profile_id), profile in profiles.items():
        nodes = profile['nodes']
        for node in nodes.values():
            if 'parent' in node and node['parent'] not in nodes:
                raise ValueError('Missing profile parent')
        counts = collections.Counter(profile['samples'])
        if any(node_id not in nodes for node_id in counts):
            raise ValueError('Missing sampled node')
        urls = {node.get('callFrame', {}).get('url', '') for node in nodes.values()}
        parser = any(url.endswith('/term-bank-wasm-parser-worker.js') for url in urls)
        compression = any(url.endswith('/zstd-term-content-compression-worker.js') for url in urls)
        importer = any(url.endswith('/dictionary-database.js') for url in urls)
        if sum([parser, compression, importer]) > 1:
            raise ValueError('Ambiguous worker profile')
        role = 'parser' if parser else 'compression' if compression else 'import' if importer else 'other'
        leaves = collections.Counter()
        for node_id, count in counts.items():
            frame = nodes[node_id].get('callFrame', {})
            leaves[(frame.get('functionName', ''), frame.get('url', ''), frame.get('lineNumber', -1))] += count
        result.append({'pid': pid, 'profileId': profile_id, 'tid': profile['tid'],
                       'threadName': names.get((pid, profile['tid'])), 'role': role,
                       'sampleCount': len(profile['samples']), 'nodeCount': len(nodes),
                       'negativeRawDeltaCount': sum(x < 0 for x in profile['rawDeltas']),
                       'startTimeUs': profile['startTimeUs'], 'endTimeUs': profile['endTimeUs'],
                       'topLeafCounts': [{'function': k[0], 'url': k[1], 'line': k[2] + 1, 'samples': n}
                                         for k, n in leaves.most_common(30)]})
    return result


def main(stage):
    root = pathlib.Path.cwd()
    own = pathlib.Path(__file__).resolve()
    research = own.parents[3]
    plan_path = own.with_name('plan.json')
    plan = json.loads(plan_path.read_text())
    output = root / os.environ['PROFILE_OUTPUT']
    output.mkdir(parents=True, exist_ok=True)
    source = plan['productSource']
    workflow_path = research / plan['workflowPath']
    receipt = {'schemaVersion': 1, 'stage': stage, 'complete': False,
               'scope': plan['scope'], 'productSource': source,
               'researchHead': git(research, 'rev-parse', 'HEAD'),
               'githubSha': os.environ.get('GITHUB_SHA'),
               'githubRunId': os.environ.get('GITHUB_RUN_ID'),
               'githubRunAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
               'workflowSha256': sha_file(workflow_path), 'planSha256': sha_file(plan_path),
               'receiptScriptSha256': sha_file(own)}
    destination = output / f'{stage}-receipt.json'
    try:
        if receipt['researchHead'] != receipt['githubSha']:
            raise ValueError('Research checkout does not match invoking GITHUB_SHA')
        controls = {}
        for control in [own, plan_path, workflow_path]:
            name = control.relative_to(research).as_posix()
            committed = subprocess.check_output(['git', 'show', f'{receipt["githubSha"]}:{name}'], cwd=research)
            if control.read_bytes() != committed:
                raise ValueError(f'Diagnostic control differs from its invoking Git commit: {name}')
            controls[name] = hashlib.sha256(committed).hexdigest()
        receipt['controlSha256'] = controls
        if receipt['workflowSha256'] != plan['workflowSha256'] or receipt['receiptScriptSha256'] != plan['receiptScriptSha256']:
            raise ValueError('Prospective workflow/receipt source binding changed')
        if git(root, 'rev-parse', 'HEAD') != source:
            raise ValueError('Product checkout does not match the frozen source')
        subprocess.run(['git', 'diff', '--no-ext-diff', '--exit-code', source, '--', '.'], cwd=root, check=True)
        subprocess.run(['git', 'diff', '--no-ext-diff', '--cached', '--exit-code'], cwd=root, check=True)
        unexpected = git(root, 'ls-files', '--others', '--exclude-standard', '--', 'ext', 'dev', 'test')
        if unexpected:
            raise ValueError(f'Unexpected source files: {unexpected}')
        for name, expected in plan['sourceSha256'].items():
            if sha_file(root / name) != expected:
                raise ValueError(f'Pinned source hash mismatch: {name}')
        # build:libs installs the exact source-bound prebuilt native module.
        if sha_file(root / 'ext/lib/term-bank-parser.wasm') != plan['sourceSha256']['dev/data/dictionary-wasm/term-bank-parser.wasm']:
            raise ValueError('Installed parser WASM differs from the frozen source-bound artifact')
        tracked_names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
        tracked = {name: sha_file(root / name) for name in tracked_names if name}
        runtime = {str(path.relative_to(root)): sha_file(path) for path in sorted((root / 'ext').rglob('*')) if path.is_file()}
        receipt.update({'productTree': git(root, 'rev-parse', 'HEAD^{tree}'), 'tracked': tracked, 'runtime': runtime,
                        'packageSha256': sha_file(root / 'builds/manabitan-chrome.zip'),
                        'node': subprocess.check_output(['node', '--version'], cwd=root, text=True).strip()})
        if receipt['productTree'] != plan['productTree']:
            raise ValueError('Product tree differs from the prospective plan')
        if receipt['node'] != plan['nodeVersion']:
            raise ValueError('Unexpected Node version')
        for label, values in [('tracked', tracked), ('runtime', runtime)]:
            receipt[label + 'ManifestSha256'] = hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if stage == 'before':
            fixture = plan['fixture']
            archive = root / 'builds/e2e-dictionary-cache' / fixture['cacheFile']
            if archive.stat().st_size != fixture['sizeBytes'] or sha_file(archive) != fixture['sha256']:
                raise ValueError('Pinned full JMdict archive mismatch')
            locked = json.loads((root / 'test/perf/dictionaries.lock.json').read_text())['dictionaries']['jmdict']
            if locked != fixture:
                raise ValueError('Fixture differs from frozen lockfile')
            for path in [own, plan_path, workflow_path]:
                shutil.copyfile(path, output / ('control-' + path.name))
        elif stage == 'after':
            before = json.loads((output / 'before-receipt.json').read_text())
            for key in ['tracked', 'runtime', 'packageSha256', 'node', 'productTree', 'controlSha256', 'workflowSha256', 'planSha256', 'receiptScriptSha256']:
                if receipt[key] != before[key]:
                    raise ValueError(f'Source/runtime changed during trace: {key}')
        elif stage == 'coverage':
            summary_path, report_path, trace_path = [output / name for name in ['summary.json', 'run-1.json', 'run-1.trace.json']]
            summary, report = json.loads(summary_path.read_text()), json.loads(report_path.read_text())
            if not (summary['traceEnabled'] is True and summary['authoritativeTiming'] is False and
                    summary['importFlags'] is None and summary['mediaCheck'] == 'all' and
                    summary['dictionary'] == 'jmdict' and summary['gitSha'] == source and
                    summary['source']['dirty'] is False and summary['fixture'] == plan['fixture'] and len(summary['runs']) == 1):
                raise ValueError('Trace summary does not match the frozen ordinary-default request')
            benchmark = report['benchmark']
            validation = benchmark['validation']
            if not (report['status'] == 'success' and report['buildTarget'] == 'chrome' and
                    report['skippedVerification'] is False and report['browserFlavor'] == 'chromium' and report['launchMode'] == 'headless' and
                    report['packageSha256'] == receipt['packageSha256'] and
                    benchmark['pinnedDictionaries'] is True and benchmark['dictionary'] == 'jmdict' and
                    benchmark['productionImportDefaults'] is True and benchmark['importFlags'] is None and
                    benchmark['traceEnabled'] is True and benchmark['authoritativeTiming'] is False and
                    benchmark['phaseProfiling'] is False and benchmark['processSampling'] is False and
                    benchmark['phaseScreenshots'] is False and benchmark['mediaCheck'] == 'all' and
                    validation['termRows'] == plan['fixture']['termRows'] and validation['contentReadable'] is True and
                    validation['probeCount'] >= 12 and validation['media']['mode'] == 'all'):
                raise ValueError('Full import/lookup/storage correctness receipt is incomplete')
            run = summary['runs'][0]
            if run['validation'] != validation or run['packageSha256'] != receipt['packageSha256']:
                raise ValueError('Summary/raw validation or package binding mismatch')
            if any(value['browserVersion'] != report['browserVersion'] for value in [summary, run]):
                raise ValueError('Summary/raw browser binding mismatch')
            if any(value['hostEnvironment']['nodeVersion'] != plan['nodeVersion'] for value in [summary, report]):
                raise ValueError('Summary/raw host Node version mismatch')
            debug = run['importDebug']
            for key, expected in [('hasResult', True), ('resultTitle', plan['fixture']['expectedTitle']), ('errorCount', 0), ('addSettingsErrorCount', 0), ('usesFallbackStorage', False)]:
                if type(debug.get(key)) is not type(expected) or debug[key] != expected:
                    raise ValueError(f'Unexpected import completion field: {key}')
            phases = [phase for phase in report['phases'] if phase.get('name') == f'{plan["fixture"]["label"]}: total import']
            if len(phases) != 1 or phases[0]['data']['importDebug'] != debug or phases[0]['data']['browserTiming']['errorCount'] != 0:
                raise ValueError('Raw import completion/errors are not bound to the summary')
            helper_path = root / 'dev/perf/import-memory-20261125-a7f7/qualification_receipts.py'
            spec = importlib.util.spec_from_file_location('frozen_qualification_receipts', helper_path)
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            canonical = helper.canonicalize_validation(validation, dictionary='jmdict', fixture=plan['fixture'], media_check='all')
            trace = json.loads(trace_path.read_text())
            profiles = inventory_trace(trace)
            role_counts = collections.Counter(profile['role'] for profile in profiles)
            if any(role_counts[role] != count for role, count in plan['expectedProfileRoles'].items()):
                raise ValueError(f'Incomplete expected worker profile coverage: {dict(role_counts)}')
            if any(profile['sampleCount'] <= 0 for profile in profiles if profile['role'] in plan['expectedProfileRoles']):
                raise ValueError('A required worker profile has no samples')
            receipt.update({'traceSha256': sha_file(trace_path), 'traceBytes': trace_path.stat().st_size,
                            'reportSha256': sha_file(report_path), 'summarySha256': sha_file(summary_path),
                            'profileRoleCounts': dict(role_counts), 'profiles': profiles,
                            'validation': validation, 'browserVersion': report['browserVersion'],
                            'canonicalValidationSha256': hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                            'hostEnvironment': report['hostEnvironment'],
                            'interpretation': 'Leaf counts only. Profile start/end timestamps and all elapsed values are diagnostic; no comparative speed or CPU-utilization claim. Negative raw deltas are retained in raw trace, not clamped. Missing terminal endTime is normal when capture stops while a persistent worker remains alive.'})
        else:
            raise ValueError('Unknown receipt stage')
        receipt['complete'] = True
    except Exception as error:
        receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        destination.write_text(json.dumps(receipt, indent=2) + '\n')
        compact = {key: value for key, value in receipt.items() if key not in ['tracked', 'runtime', 'validation']}
        print('CURRENT_JMDICT_TRACE_RECEIPT ' + json.dumps(compact, separators=(',', ':')))


if __name__ == '__main__':
    main(sys.argv[1])
