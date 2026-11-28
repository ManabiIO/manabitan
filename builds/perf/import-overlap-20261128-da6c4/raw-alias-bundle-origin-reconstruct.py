#!/usr/bin/env python3
"""Read-only exact-byte reconstruction, not a build/import or source repair."""
import difflib
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = Path('/workspace/scratch/da6c4dbd0097/baseline')
OLD = b'../manabitan/node_modules/'
NATURAL = b'../../../../workspace/scratch/da6c4dbd0097/manabitan/node_modules/'
HOSTED = b'node_modules/'
ATTEMPT = json.loads((HERE/'attempt3.json').read_text())
sha = lambda data: hashlib.sha256(data).hexdigest()

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()

report = {'schemaVersion': 1, 'complete': False, 'scope': 'Byte reconstruction from surviving original generated bundles; no corpus or timing',
          'attemptReceiptBlob': '933320b54c93c583e60395c86d30884ae237aad3',
          'attemptReceiptSha256': sha((HERE/'attempt3.json').read_bytes()),
          'naturalConfigurationBlob': '1dde9ce887b0de4fa8a8c9714a95967ed61ed92a',
          'root': str(ROOT), 'head': git('rev-parse','HEAD'), 'tree': git('rev-parse','HEAD^{tree}'),
          'porcelainBefore': git('status','--porcelain'), 'replacements': {'from': OLD.decode(), 'natural': NATURAL.decode(), 'hosted': HOSTED.decode()},
          'pathClaim': 'The replacement prefix is independently validated by all retained hashes. No historical readlink value is asserted.',
          'files': [], 'failures': []}
try:
    for arm in ['surviving', 'natural', 'hosted', 'diffs']:
        (HERE/arm).mkdir(exist_ok=False)
    for expected in ATTEMPT['fullObservedGeneratedMismatchSet']:
        name = Path(expected['path']).name
        source = ROOT/expected['path']
        original = source.read_bytes()
        natural = original.replace(OLD, NATURAL)
        hosted = original.replace(OLD, HOSTED)
        assert sha(natural) == expected['expectedNaturalSha256'], name
        assert sha(hosted) == expected['hostedSha256'], name
        for arm, value in [('surviving',original),('natural',natural),('hosted',hosted)]:
            (HERE/arm/name).write_bytes(value)
        spans = []
        cursor = 0
        while True:
            start = original.find(OLD, cursor)
            if start < 0: break
            spans.append({'start': start, 'end': start+len(OLD), 'line': original.count(b'\n',0,start)+1,
                          'beforeUtf8': original[max(0,start-48):start].decode('utf-8'),
                          'afterUtf8': original[start+len(OLD):start+len(OLD)+100].decode('utf-8')})
            cursor = start+len(OLD)
        if name.endswith('.map'):
            a,b=json.loads(natural),json.loads(hosted)
            a_sources,b_sources=a.pop('sources'),b.pop('sources')
            assert a == b, 'Map differs outside source paths: '+name
            assert [x.replace(NATURAL.decode(),HOSTED.decode()) for x in a_sources] == b_sources
            map_receipt={'onlySourcesPathsDiffer':True,'sources':len(a_sources),'changedSources':sum(x!=y for x,y in zip(a_sources,b_sources)),
                         'sourcesContentSha256':sha(json.dumps(a.get('sourcesContent'),ensure_ascii=False,separators=(',',':')).encode()),
                         'allOtherMapFieldsIdentical':True}
        else: map_receipt=None
        patch=''.join(difflib.unified_diff(natural.decode().splitlines(True),hosted.decode().splitlines(True),fromfile='natural/'+name,tofile='hosted/'+name))
        (HERE/'diffs'/(name+'.diff')).write_text(patch)
        report['files'].append({'path':expected['path'],'source':{'bytes':len(original),'sha256':sha(original)},
            'natural':{'bytes':len(natural),'sha256':sha(natural)},'hosted':{'bytes':len(hosted),'sha256':sha(hosted)},
            'replacedSpans':spans,'map':map_receipt,'diff':{'bytes':len(patch.encode()),'sha256':sha(patch.encode())}})
        assert source.read_bytes()==original, 'Source changed during census'
    report['porcelainAfter']=git('status','--porcelain')
    assert report['porcelainAfter']==report['porcelainBefore']
    report['complete']=True
except Exception as error:
    report['failures'].append({'type':type(error).__name__,'message':str(error)})
    raise
finally:
    (HERE/'reconstruction.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'complete':report['complete'],'files':len(report['files']),'spans':sum(len(x['replacedSpans']) for x in report['files']),'failures':report['failures']},sort_keys=True))
