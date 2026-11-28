#!/usr/bin/env python3
"""Verify the saved failed screen and optionally restore its content-addressed evidence."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path, PurePosixPath
import statistics
import zipfile

parser=argparse.ArgumentParser()
parser.add_argument('--extract',type=Path)
args=parser.parse_args()
root=Path(__file__).resolve().parent
index=json.loads((root/'index.json').read_text())
parts=[]
for entry in index['parts']:
    raw=(root/entry['name']).read_bytes()
    assert len(raw)==entry['bytes']
    assert hashlib.sha256(raw).hexdigest()==entry['sha256']
    parts.append(raw)
raw=b''.join(parts)
assert len(raw)==index['archiveBytes']
assert hashlib.sha256(raw).hexdigest()==index['archiveSha256']
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    manifest=json.loads(archive.read('manifest.json'))
    assert manifest['fileCount']==len(manifest['files'])==index['fileCount']
    verified={}
    for name,entry in manifest['files'].items():
        path=PurePosixPath(name)
        assert not path.is_absolute() and '..' not in path.parts
        digest=entry['sha256']
        if digest not in verified:
            value=archive.read('blobs/'+digest)
            assert hashlib.sha256(value).hexdigest()==digest
            verified[digest]=value
        assert len(verified[digest])==entry['bytes']
    def read(name):
        return verified[manifest['files'][name]['sha256']]
    result=json.loads(read('component-1m-screen.json'))
    observations=result['observations']
    schedule=['PABC','ABCP','BCPA','CPAB','CBAP','PCBA','APCB','BAPC']
    assert result['status']=='completed' and result['failures']==[] and len(observations)==32
    for i,row in enumerate(observations):
        block,position=divmod(i,4)
        assert (row['block'],row['position'],row['arm'])==(block,position,schedule[block][position])
        assert 'error' not in row and row['compressedBytes']==12324804
        assert all(math.isfinite(row[key]) and row[key]>0 for key in ['cpuMs','wallMs'])
    computed={}
    for name in ['B/P','B/A','B/C','C/A','A/P']:
        numerator,denominator=name.split('/')
        computed[name]={}
        for metric in ['cpuMs','wallMs']:
            pairs=[]
            for block in range(8):
                a=next(r[metric] for r in observations if r['block']==block and r['arm']==denominator)
                b=next(r[metric] for r in observations if r['block']==block and r['arm']==numerator)
                pairs.append((a,b))
            values={'medianPercent':statistics.median(100*(b/a-1) for a,b in pairs),
                'medianSavingMs':statistics.median(a-b for a,b in pairs),
                'faster':sum(b<a for a,b in pairs),
                'equalWorkPercent':100*(sum(b for a,b in pairs)/sum(a for a,b in pairs)-1)}
            for key,value in values.items():
                assert math.isclose(value,result['comparisons'][name][metric][key],rel_tol=0,abs_tol=1e-9),(name,metric,key)
            computed[name][metric]=values
    gain=all(all(computed[p][m]['medianPercent']<=-5 and computed[p][m]['faster']>=7 and computed[p][m]['equalWorkPercent']<0 for m in ['cpuMs','wallMs']) and computed[p]['cpuMs']['medianSavingMs']>=10 for p in ['B/P','B/A','B/C'])
    controls=all(abs(computed['C/A'][m]['medianPercent'])<=5 for m in ['cpuMs','wallMs'])
    production_control=all(abs(computed['A/P'][m]['medianPercent'])<=5 for m in ['cpuMs','wallMs'])
    assert result['preOracle']==result['postOracle'] and result['postIdentity']=='passed'
    gates={'complete':True,'exactOraclesAndIdentity':True,'gain':gain,'controls':controls,'productionControl':production_control,'advance':gain and controls and production_control}
    assert gates==result['gates'] and not gates['advance']
    if args.extract:
        args.extract.mkdir(parents=True,exist_ok=False)
        for name,entry in manifest['files'].items():
            target=args.extract/name
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(verified[entry['sha256']])
print(json.dumps({'integrity':'passed','files':manifest['fileCount'],'independentArithmetic':'passed','observations':32,'gates':gates,'extracted':str(args.extract) if args.extract else None},indent=2))
