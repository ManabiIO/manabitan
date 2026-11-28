#!/usr/bin/env python3
"""Verify retained source validation only. Never run an import or benchmark."""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import io
import json
import re
import sys
import tarfile
import zipfile

BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = 'baca22e773e835f6729d4fc5198f2445afac4535'
TREE = 'abf507137e441b76acf8a746bd05b7583f676588'
ARTIFACT_SHA = '5b46168d1d6bc85c0b9f931a94cea85eb0c12a4f1f7d83e2f55ecb36f1dbe436'
JOB_LOG_SHA = '9836b45d530b6473a56eedd1e8e3018c29d86a2a7116a59ec08c28fc3922f8d2'
LOGS = {'build.log','lint.log','format.log','native-rebuild.log','observers.log','source.log','toolchain.log','types.log','unit.log'}
sha = lambda data: hashlib.sha256(data).hexdigest()


def require(value, message):
    if not value:
        raise ValueError(message)


def main():
    require(__debug__, 'Do not run with optimized Python (-O)')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    root = args.evidence
    manifest = json.loads((root/'manifest.json').read_bytes())
    require(manifest['candidate'] == CANDIDATE and manifest['baseline'] == BASELINE and manifest['validationOnly'] is True, 'Wrong source or scope')
    code = Path(__file__).read_bytes()
    require(manifest['verifier'] == {'file':'verify-validation.py','bytes':len(code),'sha256':sha(code)}, 'Verifier identity mismatch')
    blob = (root/'evidence.tar.xz').read_bytes()
    require(len(blob) == manifest['archive']['bytes'] and sha(blob) == manifest['archive']['sha256'], 'Archive identity mismatch')
    members = {}
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:xz') as archive:
        for item in archive.getmembers():
            name = PurePosixPath(item.name)
            require(not name.is_absolute() and '..' not in name.parts and item.isfile(), 'Unsafe member')
            require(item.name not in members and item.name in manifest['members'], 'Duplicate or unexpected member')
            require((item.mode,item.uid,item.gid,item.mtime,item.uname,item.gname)==(0o644,0,0,0,'',''), 'Noncanonical archive metadata')
            data = archive.extractfile(item).read(); expected = manifest['members'][item.name]
            require(len(data)==item.size==expected['bytes'] and sha(data)==expected['sha256'], 'Member identity mismatch')
            members[item.name] = data
    require(list(members)==sorted(manifest['members']) and len(members)==manifest['archive']['memberCount'], 'Archive coverage mismatch')
    require(sum(map(len,members.values()))==manifest['archive']['uncompressedBytes'], 'Archive size mismatch')
    required = {'original-artifact.zip','original-job.log','artifact-metadata.json','jobs-source-gate-complete.json','workflow.yml','checkpoint.json'} | {'logs/'+name for name in LOGS}
    require(set(members)==required, 'Unexpected checkpoint payloads')
    original = members['original-artifact.zip']
    require(len(original)==52685 and sha(original)==ARTIFACT_SHA, 'Original artifact identity mismatch')
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        require(set(archive.namelist())==LOGS and len(archive.namelist())==len(LOGS), 'Original log coverage changed')
        for name in LOGS:
            require(archive.read(name)==members['logs/'+name], 'Original log bytes changed')
    require(len(members['original-job.log'])==1065649 and sha(members['original-job.log'])==JOB_LOG_SHA, 'Decoded original job log changed')
    metadata = json.loads(members['artifact-metadata.json'])
    require(metadata['id']==15250862750 and metadata['size_in_bytes']==52685 and metadata['digest']=='sha256:'+ARTIFACT_SHA, 'Artifact metadata mismatch')
    require(metadata['workflow_run']['id']==46107975597 and metadata['workflow_run']['head_sha']==CANDIDATE, 'Artifact source/run mismatch')
    jobs = json.loads(members['jobs-source-gate-complete.json'])['jobs']
    gate = next(job for job in jobs if job['id']==140864895314)
    require(gate['status']=='completed' and gate['conclusion']=='success', 'Source gate did not pass')
    require(all(step['status']=='completed' and step['conclusion']=='success' for step in gate['steps']), 'A source-gate step did not pass')
    source = json.loads(members['logs/source.log'].decode().strip().removeprefix('SOURCE_IDENTITY '))
    require(source['baseline']==BASELINE and source['candidate']==CANDIDATE and source['candidateTree']==TREE, 'Source identity mismatch')
    require(source['packageEntries']==['js/dictionary/term-key-hash.js'], 'Package allowlist changed')
    require(source['hashModules']=={'A':{'bytes':5175,'sha256':'c2d4ed2a04f4c5dcd8a5f5865d49f7cbdade87fd95ab4fff92f3a9bb0181d208'},'B':{'bytes':5524,'sha256':'a2b92c62a893056bf16b563cde8f842136321e2954860c8828385b6d0788c6bb'}}, 'Hash module identity mismatch')
    native_text = members['logs/native-rebuild.log'].decode(); native = json.loads(native_text[native_text.index('{'):])
    require(native['mode']=='check' and native['toolchain']=={'compilerVersion':'21.1.8','linkerVersion':'21.1.8'}, 'Native check/toolchain mismatch')
    require({x['name']:x['sha256'] for x in native['targets']}=={'term-content-canonical-scan-v1.wasm':'40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af','term-bank-parser.wasm':'8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee'}, 'Native artifact identity mismatch')
    unit = re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',members['logs/unit.log'].decode())
    require('Test Files  669 passed (669)' in unit and 'Tests  15139 passed | 47 skipped (15186)' in unit, 'Unit counts changed')
    observers = members['logs/observers.log'].decode(); require('Ran 32 tests' in observers and observers.rstrip().endswith('OK'), 'Observer tests did not pass')
    types = members['logs/types.log'].decode()
    require(all('test:ts:'+kind in types for kind in ('main','dev','test','bench')), 'Incomplete TypeScript commands')
    builds = members['logs/build.log'].decode()
    targets = re.findall(r'^Building ([a-z-]+)\.\.\.$', builds, flags=re.MULTILINE)
    require(targets==['chrome','chrome-dev','chrome-playwright','firefox','firefox-dev','firefox-android','edge'], 'Build target coverage changed')
    checkpoint = json.loads(members['checkpoint.json'])
    require(checkpoint['validationOnly'] is True and checkpoint['browserPerformanceQualified'] is False and checkpoint['noNewAcquisition'] is True, 'Validation misrepresented as performance')
    require(checkpoint['candidate']==CANDIDATE and checkpoint['unitTestsPassed']==15139 and checkpoint['unitTestsSkipped']==47 and checkpoint['unitFilesPassed']==669, 'Checkpoint facts mismatch')
    print(json.dumps({'status':'PASS_VALIDATION_EVIDENCE_ONLY','noNewAcquisition':True,'candidate':CANDIDATE,'artifactSha256':ARTIFACT_SHA,'originalLogMembers':len(LOGS),'unitFilesPassed':669,'unitTestsPassed':15139,'unitTestsSkipped':47,'observerTestsPassed':32,'native':native,'buildTargets':targets,'browserPerformanceQualified':False,'scope':'Source validation passed. This checkpoint contains no browser-import timing or memory qualification and cannot justify a runtime PR.'},indent=2))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        print('FAIL: '+str(error),file=sys.stderr)
        raise SystemExit(1) from error
