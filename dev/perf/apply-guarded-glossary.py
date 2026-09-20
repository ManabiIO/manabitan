#!/usr/bin/env python3
"""Reconstruct the exact locally checked candidate; never publish from this script."""
from pathlib import Path
import hashlib, subprocess
root=Path(__file__).resolve().parents[2]
patch=(root/'dev/perf/guarded-glossary-20260919.patch').read_text()
# Repair a transcription typo in an unchanged context line, not runtime/tests.
bad='        expect(snapshotTermBankExperiments({[name]: true}).toBe(true))'
good='        expect(snapshotTermBankExperiments({[name]: true})[name]).toBe(true)'
assert patch.count(bad)==1
patch=patch.replace(bad,good)
subprocess.run(['git','apply','--check','-'],input=patch.encode(),cwd=root,check=True)
subprocess.run(['git','apply','-'],input=patch.encode(),cwd=root,check=True)
expected={
 'ext/js/dictionary/wasm/term-bank-parser.c':'442df842c7d1b6ddd523e86a3fe0dbaf596ce7636f74ae70663608b0d9bbcc9a',
 'ext/js/dictionary/term-bank-experiments.js':'e8e425ca2db3f6ea5419fcc2857d6985d4a189108539bcd4f8a2ac9a5704a477',
 'test/term-bank-experiments.test.js':'dbe6400467ecefe5dcae18944eb59540268d32a200d8b79dba57e261762728c0',
 'test/lookup-construction-experiments.test.js':'df356a6b2eb148db84397181e253ed29308da47ac796f26c151e0f2e21cd6061',
 'types/ext/dictionary-importer.d.ts':'b012af5be59591af95e5c0ba55d1501f8ca063d5d3f41da03209662a3960adf7',
}
for filename,digest in expected.items():
    actual=hashlib.sha256((root/filename).read_bytes()).hexdigest()
    assert actual==digest,(filename,actual,digest)
    print(actual,filename)
