#!/usr/bin/env python3
"""Audit the final Jitendex corpus artifact with the unchanged reviewed checker."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

CHECKER_SHA256 = '8245f5e0ff2bc2d2ff058b6b0d519337a4b8bbef0cece5d672e7ca343d37b25d'
IDENTITY = {
    'id': 15249819961,
    'bytes': 75419,
    'sha256': 'aee1e091b0746d95d116d32fa9033d7fe9942f96163e2553f4383af5b041a1b3',
    'reportSha256': '987f973ac981f75ca9fdbf6af3b6d3d45310afac58b027788a356839cea9bb29',
}

def main():
    if not __debug__:
        raise ValueError('Refusing Python -O: evidence checks must remain enabled')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    checker = Path(__file__).with_name('import-corpus-artifacts-5a86.py')
    if hashlib.sha256(checker.read_bytes()).hexdigest() != CHECKER_SHA256:
        raise ValueError('The previously reviewed checker changed')
    spec = importlib.util.spec_from_file_location('frozen_corpus_artifact_audit', checker)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ARTIFACTS['jitendex'] = IDENTITY
    if module.git(args.repo, 'rev-parse', module.STUDY + '^{tree}').decode().strip() != module.STUDY_TREE:
        raise ValueError('Frozen study tree changed')
    result = module.audit(args.repo, args.archive, 'jitendex')
    output = {
        'schema': 1,
        'scope': 'Original Jitendex artifact review only; no import acquisition or timing claim',
        'studyCommit': module.STUDY,
        'studyTree': module.STUDY_TREE,
        'checkerSha256': CHECKER_SHA256,
        'wrapperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'corpus': result,
    }
    args.out.write_text(json.dumps(output, indent=2, sort_keys=True) + '\n')
    print(json.dumps({
        'status': 'PASS',
        'reportSha256': hashlib.sha256(args.out.read_bytes()).hexdigest(),
        'dictionary': result['dictionary'],
        'artifact': result['artifact'],
        'counterAudit': result['counterAudit'],
        'negativeGuardsRejected': result['negativeGuardsRejected'],
    }, sort_keys=True))

if __name__ == '__main__':
    main()
