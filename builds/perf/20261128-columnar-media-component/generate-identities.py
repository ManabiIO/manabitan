#!/usr/bin/env python3
"""Reproduce the source manifest without timestamps or machine-specific paths."""
import argparse
import json
from pathlib import Path
import runpy

code = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reference', type=Path, required=True)
parser.add_argument('--candidate', type=Path, default=code.parents[2])
parser.add_argument('--write', action='store_true')
args = parser.parse_args()
module = runpy.run_path(str(code / 'screen-controller.py'))
value = {'schemaVersion': 1, 'provenance': {
    'existingPullRequest': 'https://github.com/ManabiIO/manabitan/pull/907',
    'originalImplementation': '2a0b9243540bf54932165fd9ab4da17709e3b390',
    'originalHead': 'e5fbc6af88c8c69bfa7471da287ef9ceef953c90',
    'originalAuthor': 'Alex Ehlke',
    'referenceCommit': 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16',
    'localPortCommit': '4e003dda038b8eb8cf6abbc45a6f959afd802aac',
    'remoteProductCommit': '66ae01d41e3abdb546873f62f8db9ff35bd4ebbb',
    'productTree': 'ecfffcd1443c36fc064debe148cfc2b4a482151e',
    'runtimeChanges': module['RUNTIME_CHANGES'],
}, 'reference': module['source_identity'](args.reference),
   'candidate': module['source_identity'](args.candidate)}
assert value['reference']['runtimeTree'] == 'e795dde6ffacbe551c466e91615502fe72743327'
assert value['candidate']['runtimeTree'] == 'e0afc2e275dd1ab83f3e6ad931b468e19e9a5fab'
text = json.dumps(value, indent=2, ensure_ascii=True) + '\n'
destination = code / 'source-identities.json'
if args.write:
    destination.write_text(text)
else:
    assert destination.read_text() == text, 'Source manifest does not reproduce exactly'
print(json.dumps({'sourceManifestSha256': module['sha'](destination), 'matches': True}))
