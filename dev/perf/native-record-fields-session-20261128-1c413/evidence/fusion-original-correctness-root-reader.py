from pathlib import Path, PurePosixPath
import hashlib, json, tarfile
root = Path('/tmp/fusion-original-audit-46149981540-attempt1-hm6zdivl')
archive = root / 'fusion-original-evidence-46149981540-attempt1.tar.gz'
def identity(raw):
    return {'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'gitBlob':hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()}
raw = archive.read_bytes()
archive_identity = identity(raw)
assert archive_identity == {'bytes':4760073,'sha256':'52cc6c09c352696ba526eddaa2898b372a985a54b18970a2fe4e832a16ffc96c','gitBlob':'777b53f1d1cad5eaeeb22965af7e327124d59524'}
ledger_raw = (root / 'git-blob-ledger.json').read_bytes()
assert identity(ledger_raw)['gitBlob'] == 'fb018d784e7e5722606f3cb42c3230de2792d550'
ledger = json.loads(ledger_raw)
assert ledger['entryCount'] == len(ledger['entries']) == 277
expected = {name:{k:record[k] for k in ('bytes','sha256','gitBlob')} for name,record in ledger['entries'].items()}
expected['git-blob-ledger.json'] = identity(ledger_raw)
clarification = (root / 'publication-clarification.json').read_bytes()
assert identity(clarification)['gitBlob'] == 'b986de5d38259d35656f29f4e81a6c68cabd2073'
expected['publication-clarification.json'] = identity(clarification)
verified = {}
with tarfile.open(archive,'r:gz') as tar:
    members = tar.getmembers()
    assert len(members) == len(expected) == 279
    assert len(set(m.name for m in members)) == 279
    assert [m.name for m in members] == sorted(expected)
    for member in members:
        path = PurePosixPath(member.name)
        assert not path.is_absolute() and '..' not in path.parts and member.isfile()
        assert member.uid == member.gid == member.mtime == 0
        assert member.mode == 0o644
        stream = tar.extractfile(member)
        assert stream is not None
        actual = identity(stream.read())
        assert actual == expected[member.name], member.name
        assert actual['bytes'] == member.size
        verified[member.name] = actual
digest = hashlib.sha256(''.join(name+'\0'+verified[name]['sha256']+'\n' for name in sorted(verified)).encode()).hexdigest()
result = {'schemaVersion':1,'kind':'root-independent-complete-fusion-correctness-archive-readback','passed':True,'run':46149981540,'attempt':1,'archive':archive_identity,'originalLedger':identity(ledger_raw),'originalPayloadsVerified':277,'allMembersVerified':279,'memberSha256Aggregate':digest,'everyMemberComparedToOriginalLedger':True,'allRegularNoLinks':True,'noExecutionOrNewObservations':True,'scope':'All original payload bytes preserved in the remotely published archive; individual ledger Git hashes are identities, not separate remote publication claims.'}
(root/'root-independent-archive-readback.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
