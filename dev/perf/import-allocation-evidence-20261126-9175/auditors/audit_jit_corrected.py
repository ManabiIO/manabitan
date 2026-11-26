#!/usr/bin/env python3
"""Audit the separately registered final-parser/Jitendex cohort and overlay."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile
import audit

ROOT = Path(__file__).resolve().parent
FINAL = '01d0eb7164385828c97efae1b319ccc1c4fe92f9'
FIX = '439a1c9b6d40452061cda094b0727005553c1d1d'
OVERLAY_HASH = 'eacc5eeee1aaeb13ea44867f0d2ff168f5e723392652ebfee6dfc717ba3865d0'

def audit_corrected(artifact):
    audit.HEADS = {'scratch': FINAL}
    audit.SCRIPT = ROOT / 'jit-corrected-screen.py'
    result = audit.audit(artifact)
    assert result['dictionary'] == 'jitendex'
    with zipfile.ZipFile(artifact) as archive:
        prefix = next(name for name in archive.namelist() if name.endswith('schedule.json'))[:-len('schedule.json')]
        def read(name):
            return archive.read(prefix + name)
        def data(name):
            return json.loads(read(name))
        assert data('schedule.json')['harnessOverlayRef'] == FIX
        metadata = data('harness-overlay.json')
        original = read('original-benchmark-support.js')
        corrected = read('corrected-benchmark-support.js')
        assert original == audit.source('dev/perf/benchmark-support.js')
        assert corrected == (ROOT / 'benchmark-support-950.js.txt').read_bytes()
        assert hashlib.sha256(corrected).hexdigest() == OVERLAY_HASH
        assert metadata['ref'] == FIX and metadata['path'] == 'dev/perf/benchmark-support.js'
        assert metadata['originalSha256'] == hashlib.sha256(original).hexdigest()
        assert metadata['overlaySha256'] == OVERLAY_HASH
        for label in ('A', 'B'):
            lines = read(f'{label}-status-with-harness-overlay.txt').decode().splitlines()
            tracked = [line for line in lines if not line.startswith('?? ')]
            assert tracked == [' M dev/perf/benchmark-support.js'], lines
        for observation in ('A1', 'B1', 'B2', 'A2'):
            source = data(f'{observation}/summary.json')['source']
            assert source['dirty'] is True
            assert source['sha256']['dev/perf/benchmark-support.js'] == OVERLAY_HASH
        result['harnessOverlay'] = metadata
        result['supersedesDiagnosticOnly'] = '45862232094/scratch-jitendex/A1'
        return result

if __name__ == '__main__':
    artifact = Path(sys.argv[1]).resolve()
    result = audit_corrected(artifact)
    artifact.with_suffix('.audit.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
