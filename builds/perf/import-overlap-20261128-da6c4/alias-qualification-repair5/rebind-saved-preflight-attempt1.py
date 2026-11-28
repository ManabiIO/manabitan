"""Derive corrected logical binding from unchanged attempt4 files; no acquisition."""
from pathlib import Path
import hashlib
import json

from browser_proof import bind_preflight

HERE = Path(__file__).resolve().parent
ARTIFACT = Path('/tmp/manabitan-da6c4-alias-preflight4')
ROOT = ARTIFACT / 'retained'
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load(path):
    return json.loads(Path(path).read_text())
members = load(HERE / 'attempt4-member-hashes.json')
for relative, expected in members.items():
    actual_path = ARTIFACT / relative if relative == 'pre-acquisition-binding.json' else ROOT / relative
    assert sha(actual_path) == expected, relative
pre_acquisition = load(ARTIFACT / 'pre-acquisition-binding.json')
sources = load(ARTIFACT / 'source-identities.json')
assert sources == pre_acquisition['sourceIdentities']
core = load(ROOT / 'natural-oracle/core.json')
assert core['candidate'] == '2c02336b135ee01661ca2a788395afec75e66712'
assert pre_acquisition['researchCommit'] == 'eaee9b0e408307410558adc69d7695e9ea506fbb'
arms = {}
for arm in ('A', 'B'):
    location = ROOT / ('browser-preflight-' + arm)
    arms[arm] = {'layoutPath': location / 'layout/layout.json', 'layout': load(location / 'layout/layout.json'),
                 'verificationPath': location / 'browser-verification.json', 'receipt': load(location / 'canonical-receipt.json')}
request = arms['A']['layout']['request']
common = {name: request[name] for name in ('baseline', 'candidate', 'protocolBlob', 'dictionary', 'fixtureSha256', 'exporterSha256')}
common.update(schemaVersion=1, receiptAdapterSha256=sha(HERE / 'receipt_adapter.py'),
              sources={arm: {key: value[key] for key in ('commit', 'tree', 'sourceManifestSha256', 'packageSha256')} for arm, value in sources.items()})
binding = bind_preflight(core=core, core_sha256=sha(ROOT / 'natural-oracle/core.json'),
                         comparison_path=ROOT / 'natural-oracle/comparison.json', arms=arms, common_binding=common)
assert binding['candidate'] == core['candidate']
assert binding['physicalProof']['candidateTestAmendment'] is None
proof = binding['physicalProof']['rawProbeRelocationProof']
assert proof['rowCount'] == 29 and proof['compactReferences'] == 132 and proof['changedPreviewRows'] == 20
result = {'schemaVersion': 1, 'complete': True,
    'scope': 'Retrospective corrected comparator replay on exact original attempt4 files. No browser imports, ordinary timings, memory observations or rewritten old evidence.',
    'originalWorkflowStillFailed': True, 'qualifiesNewCandidate': False, 'authoritativeTiming': False,
    'runId': 46134500034, 'preflightJobId': 140946673357, 'originalResearchCommit': pre_acquisition['researchCommit'],
    'originalCandidate': core['candidate'], 'artifactId': 15259058617,
    'artifactSha256': '17c87059b7cbaedb250aee7a97a3f139f62a5c9a01e4ab19b7d72dc3dddb5d60',
    'originalMemberSha256': members,
    'controlsUsedForThisDerivation': {name: sha(HERE / name) for name in ('browser_proof.py', 'receipt_adapter.py', 'probe_projection.py', 'rebind-saved-preflight.py')},
    'binding': binding,
    'interpretation': 'The failed equality was a physical compact-pointer preview comparison. The corrected binding proves each original preview against actual file ranges and the original normal-span relocation, preserves exact within-arm previews and all stable logical fields, and accepts these two historical complete-file proofs. Fresh exact-source prerequisite gates remain required for cce635.'}
out = HERE / 'attempt4-corrected-binding.json'
assert not out.exists()
out.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'complete': True, 'rows': proof['rowCount'], 'compactReferences': proof['compactReferences'],
                  'changedPreviews': proof['changedPreviewRows'], 'originalWorkflowStillFailed': True,
                  'qualifiesNewCandidate': False, 'reportSha256': sha(out)}))
