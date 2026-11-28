#!/usr/bin/env python3
"""Independent, read-only byte/scope audit of the sealed phase-one archive."""
import hashlib
import io
import json
import re
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACK = ROOT / 'profiling/checkpoint-phase1'
ARCHIVE = PACK / 'checkpoint-phase1.tar.gz'
EXPECTED_SHA = '050a01b9994034c0e070d66e17d1f879b20d724772e8c187af354a879936d161'
BASE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
FINGER = '178ee43328141693e88b90b4b518d483c87b2fac'
MINSIZE = '2907ba1bad0958c22fe363f88d7cceb4d4bc604e'
checks = {}
notes = []

def sha(data):
    return hashlib.sha256(data).hexdigest()

def check(name, value):
    checks[name] = bool(value)

def git_bytes(*args):
    return subprocess.check_output(['git', '-C', str(ROOT/'manabitan'), *args])

raw = ARCHIVE.read_bytes()
check('sealed_archive_sha256', sha(raw) == EXPECTED_SHA)
check('sealed_archive_size', len(raw) == 5737812)
check('gzip_header_no_filename_zero_mtime', raw[:3] == b'\x1f\x8b\x08' and raw[3] == 0 and raw[4:8] == b'\0'*4)
files = {}
names = []
with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
    for m in archive:
        check('member_regular_unique_safe:'+m.name, m.isfile() and m.name not in files and not m.name.startswith('/') and '..' not in Path(m.name).parts)
        check('member_metadata:'+m.name, (m.mtime,m.uid,m.gid,m.mode,m.uname,m.gname)==(0,0,0,0o644,'',''))
        files[m.name] = archive.extractfile(m).read()
        names.append(m.name)
check('members_sorted', names == sorted(names))
check('sealed_member_count', len(files) == 279)
check('sealed_raw_bytes', sum(map(len,files.values())) == 55658475)
inventory = json.loads(files['INVENTORY.json'])
entries = {e['path']:e for e in inventory['files']}
check('inventory_unique', len(entries) == len(inventory['files']))
check('inventory_complete', set(files) == set(entries)|{'INVENTORY.json'})
check('inventory_external_identical', files['INVENTORY.json'] == (PACK/'INVENTORY.json').read_bytes())
origin_checks = []
for path,e in entries.items():
    check('manifest_hash_and_size:'+path, len(files[path]) == e['bytes'] and sha(files[path]) == e['sha256'])
    origin = e['origin']
    match = re.fullmatch(r'ManabiIO/manabitan@([0-9a-f]{40}):(.*)', origin)
    if match:
        expected = git_bytes('show', match[1]+':'+match[2])
        check('git_origin:'+path, files[path] == expected)
        origin_checks.append(path)
    elif origin.startswith('git diff --binary '):
        _,_,_,base,head = origin.split()
        check('git_diff_origin:'+path, files[path] == git_bytes('diff','--binary',base,head))
        origin_checks.append(path)
    elif origin.startswith('/') and Path(origin).is_file():
        check('file_origin:'+path, files[path] == Path(origin).read_bytes())
        origin_checks.append(path)
    elif origin.startswith('/') and ': git diff HEAD plus explicit new source files' not in origin:
        notes.append('Origin unavailable for independent filesystem comparison: '+path+' <- '+origin)

for line in (PACK/'SHA256SUMS').read_text().splitlines():
    expected,name=line.split(None,1)
    name=name.lstrip('* ')
    check('external_sha256sum:'+name, (PACK/name).is_file() and sha((PACK/name).read_bytes())==expected)
for name in ['README.md','STATUS.json','verify-phase1-checkpoint.py']:
    check('external_copy_matches_archive:'+name, files[name] == (PACK/name).read_bytes())
packaging=json.loads((PACK/'PACKAGING.json').read_text())
check('packaging_bound_to_archive', packaging['archiveSha256']==EXPECTED_SHA and packaging['repackedSha256']==EXPECTED_SHA and packaging['byteIdenticalRepack'] and packaging['verifiedMembers']==279)
check('packaging_size_honest', packaging['archiveBytes']==len(raw) and packaging['compressedUnder5MiB']==(len(raw)<5*1024*1024))

required = [
 'profiling/exploratory-observation-status.json', 'profiling/local-validation-status.json',
 'profiling/pipeline-jmdict.json', 'profiling/pipeline-jmdict-verified.log',
 'profiling/encoder-vndb-baseline.log', 'profiling/encoder-vndb-baseline-r2.log',
 'profiling/encoder-jmdict-baseline.json', 'profiling/encoder-jitendex-baseline.json',
 'profiling/fingerprint-full-unit.log', 'profiling/fingerprint-build-check.log',
 'profiling/fingerprint-build-check-owned-libs.log', 'profiling/fingerprint-types-results.json',
 'profiling/fingerprint-types-640-results.json', 'profiling/fingerprint-types-test.log',
 'profiling/fingerprint-types-640-test.log', 'profiling/fingerprint-hosted-qa.log',
 'profiling/fingerprint-hosted-qa.json', 'profiling/composite-minsize-final-source-binding.json',
 'profiling/parser-slot-probes/compile-attempt-1.json', 'profiling/parser-slot-probes/compile-attempt-1.log',
 'profiling/parser-slot-probes/compile-attempt-2.json', 'profiling/parser-slot-probes/compile-attempt-2.log',
 'profiling/record-field-proof-review.json', 'profiling/hosted-plans/fingerprint-qualification-superseded.yml',
 'profiling/hosted-plans/fingerprint-package-plan-correction.json',
]
for path in required:
    check('required_failure_or_identity:'+path,path in files)
for directory in ['jmdict-fingerprint-screen-1','cross-dictionary-fingerprint-screen-1','composite-minsize-screen-1','composite-minsize-vndb-parity-1','parser-slot-probes','fingerprint-probe-work']:
    expected = {'profiling/'+directory+'/'+p.name for p in (ROOT/'profiling'/directory).iterdir() if p.is_file()}
    archived = {p for p in files if p.startswith('profiling/'+directory+'/')}
    check('complete_diagnostic_directory:'+directory,expected == archived)
check('empty_failed_minsize_log_preserved',files['profiling/composite-minsize-screen-1/jitendex-pair-2-B.log']==b'')
check('missing_minsize_result_not_fabricated','profiling/composite-minsize-screen-1/jitendex-pair-2-B.json' not in files)
cohort=json.loads(files['profiling/composite-minsize-screen-1/cohort-status.json'])
check('stopped_cohort_status',cohort['complete'] is False and cohort['observedReturnCode']==-9 and cohort['retried'] is False and cohort['completedObservations']==12 and cohort['remainingSlotsNotAttempted']==11)
vndb=json.loads(files['profiling/composite-minsize-vndb-parity-1/status.json'])
check('vndb_separate_untimed_parity',vndb['complete'] and vndb['parity'] and vndb['authoritativeTiming'] is False)
for dictionary,digest in [('jmdict','3316003073c9c537e6a86fcbc8531aeed0df4d5a47d320816cc3fb13dbd05c6e'),('jitendex','bccdf7188947c790c99042dfc30269d0d89504b1adaee1a079d1f508fec34de0')]:
    for arm in ['A','B']:
        report=json.loads(files[f'profiling/composite-minsize-screen-1/{dictionary}-verify-{arm}.json'])
        check('complete_parser_digest:'+dictionary+'-'+arm,report['complete'] and report['observations'][0]['digest']==digest)
check('complete_vndb_parser_digests',all(x['digest']=='cc0f0a5fb3f5bff0da39f7ad64a9339e9063b02a29acec33bb48379f7127f02f' for x in vndb['receipts']))

status=json.loads(files['STATUS.json'])
readme=files['README.md'].decode()
bindings=json.loads(files['frozen/bindings.json'])
check('status_source_pins',status['baselineCommit']==BASE and status['fingerprint']['source']==FINGER and status['minsize']['source']==MINSIZE)
check('status_authoritative_run_ids',status['fingerprint']['qualificationRun']==46104243724 and status['minsize']['qualificationRun']==46104898097 and status['fingerprint']['sourceQaRun']==46102827974)
check('status_superseded_run',status['supersededQualification']['run']==46102936165)
check('status_no_acceptance_or_pr_claim',status['fullBrowserQualification'].startswith('PENDING') and status['pullRequestsCreatedByThisTask']==0 and status['publicationAuthorizedByThisCheckpoint'] is False)
check('status_fixed_snapshot',status['asOfUtc']=='2026-11-28T04:22:00Z')
check('readme_distinguishes_runtime_versions','22.22.0' in readme and '24.20.0' in readme)
check('readme_sampled_persisted_scope','stored-lookup checks sample persisted lookups' in readme and 'Complete component digests do not establish' in readme and 'exhaustive persisted-row equality' in readme)
check('readme_no_gain_acceptance','Full browser qualification is pending' in readme and 'not acceptance' in readme)
qa=json.loads(files['profiling/fingerprint-hosted-qa.json'])
check('source_qa_receipt',qa['runId']==46102827974 and qa['sourceSha']==FINGER and qa['conclusion']=='success' and qa['unit']=={'filesPassed':670,'testsPassed':15145,'skips':47})
qa_log=files['profiling/fingerprint-hosted-qa.log'].decode(errors='replace')
qa_plain=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',qa_log)
check('source_qa_log_matches_counts_and_source',FINGER in qa_plain and '670 passed' in qa_plain and '15145 passed' in qa_plain and '47 skipped' in qa_plain)
check('source_qa_log_native_check','build:dictionary-wasm -- --check' in qa_plain and '5f43d39ef013abf5cb1567d18c962b7c99194110d431732da7952aa7204bf01e' in qa_plain)
check('binding_authoritative_workflow_shas',all(x in json.dumps(bindings) for x in ['b64b3d0423d758252fce9333ceef6e98431de47b','0c2a8a75cd0322cc13348b977a7e915b555d5a88']))
correction=json.loads(files['profiling/hosted-plans/fingerprint-package-plan-correction.json'])
check('binding_superseded_workflow_sha',correction['supersededWorkflowCommit']=='df79e77b966f67073229f2fd462491e8aee96e50' and correction['supersededRun']==46102936165)
for name,wasm_hash in [('fingerprint','5f43d39ef013abf5cb1567d18c962b7c99194110d431732da7952aa7204bf01e'),('minsize','363136045b400ea9bab953cb7b52febaedd23b4d1e3b666cde3d4df859b72ff0')]:
    manifest=json.loads(files[f'frozen/candidates/{name}-wasm-manifest.json'])
    check('native_manifest:'+name,manifest['toolchain']=={'compilerVersion':'21.1.8','linkerVersion':'21.1.8'} and wasm_hash in [t['sha256'] for t in manifest['targets']])

excluded_tokens=['node_modules/','runtime/node/','ms-playwright/','e2e-dictionary-cache/','.json.groups/']
check('no_large_runtime_dependency_corpus_paths',not any(token in path for path in files for token in excluded_tokens))
check('no_nested_archives',not any(path.endswith(('.zip','.tar.gz','.tgz','.tar.xz')) for path in files))
check('no_executable_binary_distributions',not any(data.startswith(b'\x7fELF') or data.startswith(b'MZ') for data in files.values()))
wasms=[{'path':p,'bytes':len(v)} for p,v in files.items() if p.endswith('.wasm')]
check('only_small_diagnostic_wasms',all(e['bytes']<100000 for e in wasms))
check('archive_still_sealed',sha(ARCHIVE.read_bytes())==EXPECTED_SHA)

result={
 'scope':'Independent read-only archive/source/claim audit; no tests or imports rerun.',
 'auditorScriptSha256':sha(Path(__file__).read_bytes()),
 'auditDevelopmentNote':'Initial receipt is retained separately. Two initial predicates expected a literal sampled word instead of sample, and expected the superseded workflow SHA inside authoritative bindings instead of its prospective correction receipt. Manual evidence matched; only audit predicates changed, and the sealed archive was not edited.',
 'archiveSha256':EXPECTED_SHA,'archiveBytes':len(raw),'members':len(files),
 'rawBytes':sum(map(len,files.values())),'checks':checks,'checkCount':len(checks),
 'passed':all(checks.values()),'failedChecks':[k for k,v in checks.items() if not v],
 'independentlyMatchedOrigins':len(origin_checks),'notes':notes,
 'nativeDiagnosticAssets':wasms,
 'sourcePins':{'baseline':BASE,'fingerprint':FINGER,'minsize':MINSIZE},
 'remoteRunBindingsIndependentlyReadViaConnector':[
  {'run':46104243724,'head':'b64b3d0423d758252fce9333ceef6e98431de47b','role':'authoritative fingerprint qualification; no completed acceptance outcome'},
  {'run':46104898097,'head':'0c2a8a75cd0322cc13348b977a7e915b555d5a88','role':'authoritative minsize qualification; no completed acceptance outcome'},
  {'run':46102936165,'head':'df79e77b966f67073229f2fd462491e8aee96e50','role':'superseded before timing; subsequently failed its package gate'},
  {'run':46102827974,'head':FINGER,'role':'source QA completed success'},
 ],
 'claimReview':{
  'performance':'Component screens and untimed work reductions only; no production/full-import gain claimed.',
  'correctness':'Complete logical worker/component digests are separate from sampled persisted browser lookups and prescribed media verification.',
  'failures':'All required available failed/partial observation files and complete stopped-cohort directories are retained verbatim; missing result files are not fabricated.',
  'size':'Archive exceeds the soft 5 MiB target; packaging states this explicitly and root elected to retain all evidence.',
  'snapshot':'STATUS is explicitly as of 04:22 UTC, with later record-field review labeled separately; newer hosted outcomes require another checkpoint.',
 },
}
out=ROOT/'profiling/checkpoint-phase1-independent-audit.json'
out.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['checks','nativeDiagnosticAssets']}))
