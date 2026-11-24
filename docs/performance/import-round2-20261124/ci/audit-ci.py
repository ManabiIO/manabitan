import datetime
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPECTED = {
    862: ('ec4e81395a1eb0f6f5fbf4f6d4c591201887e8cf', 45352630251),
    863: ('ebb0777114578c5cee879877274e7d872bfea27e', 45352943424),
    864: ('d147a60fc4845e898d98d8924968d6094b417007', 45353056708),
}
BASE = 'd24b4e56ceb1fe14ad96ef3853f4d397efa6fa26'
EXPECTED_SKIPPED_JOBS = {
    'Full Extension E2E (Edge)': "github.event_name == 'workflow_dispatch'",
    'Firefox Android Installation Smoke (blocking)': "github.event_name == 'workflow_dispatch'",
    'Firefox Android Gecko RDP Capability Probe (manual)': "github.event_name == 'workflow_dispatch'",
    'Published release upgrade and reimport': "github.event_name == 'workflow_dispatch' && inputs.release_version != ''",
}
EXPECTED_SKIPPED_STEPS = {
    'Retain versioned release packages': "inputs.release_version != ''",
    'Retain tested Firefox release package': "inputs.release_version != ''",
    'Retain tested Chromium release package': "inputs.release_version != ''",
    'Upload Firefox extension E2E report': "failure() || github.event_name == 'workflow_dispatch'",
    'Upload Chromium extension E2E report': "failure() || github.event_name == 'workflow_dispatch'",
}


def payload(pr, kind, final=True):
    file = ROOT / f'pr-{pr}-{kind}.json'
    final_file = ROOT / f'pr-{pr}-{kind}-final.json'
    if final and final_file.exists():
        file = final_file
    return json.loads(file.read_text())['data']


def summarize_job(job):
    return {key: job.get(key) for key in ('id', 'name', 'head_sha', 'status', 'conclusion', 'started_at', 'completed_at', 'html_url')}


def successful_step(job, name):
    step = next(item for item in job['steps'] if item['name'] == name)
    assert step['status'] == 'completed' and step['conclusion'] == 'success', (job['name'], step)
    return {key: step.get(key) for key in ('name', 'status', 'conclusion', 'started_at', 'completed_at')}


summary = {
    'auditedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Independent GitHub frozen-head CI audit. API run/job/check receipts and build/restart logs are retained. Success is reported only for executed jobs and steps; job-gated and artifact-only skipped steps remain explicit. Browser benchmark qualification is separate. Browser/restart artifact payloads were not downloaded for this CI audit; their enforced workflow gates and execution receipts are audited here.',
    'frozenBase': BASE,
    'expectedSkippedJobs': EXPECTED_SKIPPED_JOBS,
    'expectedSkippedSteps': EXPECTED_SKIPPED_STEPS,
    'pullRequests': [],
    'failures': [],
    'pending': [],
}
workflow_source_hash = None

for pr, (head, main_id) in EXPECTED.items():
    pull = payload(pr, 'pull-request')
    run = payload(pr, 'main-run')
    jobs = payload(pr, 'main-jobs-full')
    workflows = payload(pr, 'head-workflows-full')
    checks = payload(pr, 'head-checks-initial')
    statuses = payload(pr, 'legacy-statuses')
    assert pull['number'] == pr and pull['head']['sha'] == head and pull['base']['sha'] == BASE
    assert run['id'] == main_id and run['head_sha'] == head and run['event'] == 'pull_request'
    assert run['status'] == 'completed' and run['conclusion'] == 'success'
    assert run['run_attempt'] == 1
    assert jobs['total_count'] == len(jobs['jobs']) == 19
    assert workflows['total_count'] == len(workflows['workflow_runs']) == 7
    assert checks['total_count'] == len(checks['check_runs']) == 28
    assert statuses['statuses'] == [], 'Legacy statuses do not substitute for GitHub check runs'
    assert all(job['head_sha'] == head for job in jobs['jobs'])
    assert all(check['head_sha'] == head for check in checks['check_runs'])
    by_name = {job['name']: job for job in jobs['jobs']}
    assert len(by_name) == 19
    actual_skipped = {job['name'] for job in jobs['jobs'] if job['conclusion'] == 'skipped'}
    assert actual_skipped == set(EXPECTED_SKIPPED_JOBS)
    assert sum(job['conclusion'] == 'success' for job in jobs['jobs']) == 15
    source = (ROOT / f'pr-{pr}-workflow-source.yml').read_text()
    source_hash = hashlib.sha256(source.encode()).hexdigest()
    if workflow_source_hash is None:
        workflow_source_hash = source_hash
    assert source_hash == workflow_source_hash
    for name, condition in EXPECTED_SKIPPED_JOBS.items():
        pattern = r'name: ' + re.escape(name) + r'\n(?:[^\n]*\n){0,3}?\s+if: ' + re.escape(condition)
        assert re.search(pattern, source), (name, condition)
    skipped_steps = []
    for job in jobs['jobs']:
        assert job['status'] == 'completed'
        for step in job.get('steps', []):
            assert step['status'] == 'completed'
            if step['conclusion'] == 'skipped':
                assert step['name'] in EXPECTED_SKIPPED_STEPS, (job['name'], step)
                condition = EXPECTED_SKIPPED_STEPS[step['name']]
                assert re.search(r'name: ' + re.escape(step['name']) + r'\n\s+if: ' + re.escape(condition), source)
                skipped_steps.append({'job': job['name'], 'step': step['name'], 'condition': condition})
            else:
                assert step['conclusion'] == 'success', (job['name'], step)
    assert len(skipped_steps) == 5
    native_step = successful_step(by_name['Test Build'], 'Verify pinned dictionary WASM rebuild')
    log = (ROOT / f'pr-{pr}-build-log.log').read_text()
    clean = re.sub(r'^\d{4}-\d\d-\d\dT\S+Z ', '', log, flags=re.MULTILINE)
    native = json.loads(re.search(r'^\{\n  "mode": "check",.*?^\}', clean, flags=re.MULTILINE | re.DOTALL).group())
    assert native['mode'] == 'check'
    assert native['toolchain'] == {'compilerVersion': '21.1.8', 'linkerVersion': '21.1.8'}
    assert len(native['targets']) == 2
    browser_gates = []
    for browser in ('Chromium', 'Firefox'):
        job = by_name[f'Full Extension E2E ({browser})']
        browser_gates.append({
            'job': summarize_job(job),
            'run': successful_step(job, f'Run {browser} extension E2E'),
            'enforce': successful_step(job, f'Enforce {browser} extension E2E success'),
            'jsonUpload': successful_step(job, f'Upload {browser} extension E2E JSON'),
        })
    ancillary = []
    restart_gates = None
    dependency_review = None
    for item in workflows['workflow_runs']:
        assert item['head_sha'] == head and item['event'] == 'pull_request'
        if item['id'] == main_id:
            continue
        detailed = payload(pr, f'run-{item["id"]}')
        detailed_jobs = payload(pr, f'jobs-{item["id"]}')
        assert detailed['head_sha'] == head and detailed['run_attempt'] == 1
        assert detailed_jobs['total_count'] == len(detailed_jobs['jobs']) == 1
        assert all(job['head_sha'] == head for job in detailed_jobs['jobs'])
        ancillary.append({
            'id': detailed['id'], 'name': detailed['name'], 'head_sha': detailed['head_sha'],
            'status': detailed['status'], 'conclusion': detailed['conclusion'], 'html_url': detailed['html_url'],
            'jobs': [summarize_job(job) for job in detailed_jobs['jobs']],
            'skippedSteps': [{'job': job['name'], 'step': step['name']} for job in detailed_jobs['jobs'] for step in job.get('steps', []) if step['conclusion'] == 'skipped'],
        })
        if detailed['status'] != 'completed':
            summary['pending'].append({'pr': pr, 'run': detailed['id'], 'name': detailed['name']})
        elif detailed['conclusion'] != 'success':
            summary['failures'].append({'pr': pr, 'run': detailed['id'], 'name': detailed['name'], 'conclusion': detailed['conclusion']})
        for job in detailed_jobs['jobs']:
            for step in job.get('steps', []):
                if step['conclusion'] not in (None, 'success', 'skipped'):
                    summary['failures'].append({'pr': pr, 'run': detailed['id'], 'job': job['name'], 'step': step['name'], 'conclusion': step['conclusion']})
        if detailed['name'] == 'Chromium Restart Interruption':
            job = detailed_jobs['jobs'][0]
            restart_gates = {
                'runId': detailed['id'], 'job': summarize_job(job),
                'processTreeTest': successful_step(job, 'Test owned process-tree selection'),
                'campaign': successful_step(job, 'Run witnessed interruption recovery campaign'),
                'enforce': successful_step(job, 'Enforce recovery report'),
                'evidenceUpload': successful_step(job, 'Upload restart interruption evidence'),
            }
        if detailed['name'] == 'Dependency Review':
            job = detailed_jobs['jobs'][0]
            successful_step(job, 'Check dependency graph availability')
            successful_step(job, 'Dependency review unavailable')
            actual_review = next(step for step in job['steps'] if step['name'] == 'Dependency Review')
            assert actual_review['conclusion'] == 'skipped'
            dependency_review = {
                'workflowConclusion': detailed['conclusion'],
                'dependencyGraphAvailable': False,
                'dependencyVulnerabilityScanExecuted': False,
                'reason': 'Availability probe selected the explicit dependency-review-unavailable branch; actual scan and checkout steps were skipped.',
            }
    assert restart_gates is not None
    assert dependency_review is not None
    for check in checks['check_runs']:
        if check['status'] == 'completed' and check['conclusion'] not in ('success', 'skipped'):
            summary['failures'].append({'pr': pr, 'check': check['name'], 'conclusion': check['conclusion']})
    summary['pullRequests'].append({
        'number': pr, 'url': pull['html_url'], 'head': head, 'base': pull['base']['sha'],
        'mergeRef': pull['merge_commit_sha'], 'stateAtReceipt': pull['state'], 'draftAtReceipt': pull['draft'],
        'mainRun': {'id': run['id'], 'status': run['status'], 'conclusion': run['conclusion'], 'url': run['html_url'], 'updatedAt': run['updated_at']},
        'successfulMainJobs': 15, 'skippedMainJobs': sorted(actual_skipped),
        'mainJobs': [summarize_job(job) for job in jobs['jobs']],
        'skippedMainSteps': skipped_steps,
        'workflowSourceSha256': source_hash,
        'nativeReproduction': {'step': native_step, 'receipt': native},
        'browserGates': browser_gates,
        'restartGates': restart_gates,
        'dependencyReviewCoverage': dependency_review,
        'ancillary': ancillary,
        'headChecks': {outcome: sum(check['conclusion'] == outcome for check in checks['check_runs']) for outcome in ('success', 'skipped', None)},
    })

summary['status'] = 'failed' if summary['failures'] else ('pending-ancillary' if summary['pending'] else 'passed')
(ROOT / 'audit-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({'status': summary['status'], 'pending': summary['pending'], 'failures': summary['failures'], 'prs': len(summary['pullRequests']), 'path': str(ROOT / 'audit-summary.json')}))
if summary['failures']:
    raise SystemExit(1)
