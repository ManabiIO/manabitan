"""Publish only verified or explicitly partial evidence to one new branch."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import urllib.request

REPOSITORY = 'ManabiIO/manabitan'
BASE = 'a300da36d00df8e353c5679b1528b50a1299b75f'
BASE_TREE = '5fe9ee5a3e2c27ce4e099cb3d6a598077027eac4'
BRANCH = 'perf/import-experiment-evidence-20261128-4d9f'
PREFIX = 'builds/perf/20261128-4d9f-hosted-evidence'
MANIFEST_SHA256 = '4e8ad7613257e5a4c698d119614ea9d7235c721b621c9a7352d3c8ed5e84b267'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise RuntimeError('Unexpected redirect from the fixed GitHub publication API')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.output.resolve()
    index_path = root / 'preservation-index.json'
    if not index_path.is_file():
        raise SystemExit('No preservation index was produced; no branch will be created')
    index = json.loads(index_path.read_text())
    assert index['manifestSha256'] == MANIFEST_SHA256
    assert 0 < index['processedArtifacts'] <= index['requestedArtifacts'] == 34
    receipt = json.loads((root / 'source-receipt.json').read_text())
    assert receipt['manifestSha256'] == MANIFEST_SHA256
    assert receipt['auditHelperSha256'] == '83f6c2eabcd31232dade45596c5df833fe87879e095267cda250aa44780347ee'
    assert receipt['validatorCommit'] == 'f28c2801fcfd9416f220b46b9cbafeee901c1cb2'
    assert receipt['newAcquisitions'] is False
    files = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlink in publication output')
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if '..' in relative.parts or '.git' in relative.parts or path.stat().st_size >= 95000000:
            raise ValueError('Unexpected publication path or size')
        data = path.read_bytes()
        files.append({'path': relative.as_posix(), 'bytes': len(data),
                      'sha256': hashlib.sha256(data).hexdigest()})
    assert files
    publication = {'schemaVersion': 1, 'base': BASE, 'branch': BRANCH, 'prefix': PREFIX,
                   'preservationComplete': index['complete'],
                   'qualificationGateFailures': index.get('qualificationGateFailures', []),
                   'scope': 'Copies all produced evidence, including explicit failures. This is not a new measurement or a performance qualification.',
                   'files': files, 'selfIndexExcludedFromFiles': True}
    publication_path = root / 'publication-manifest.json'
    publication_path.write_text(json.dumps(publication, indent=2) + '\n')
    token = os.environ['GITHUB_TOKEN']
    opener = urllib.request.build_opener(NoRedirect())
    def api(path, payload):
        request = urllib.request.Request('https://api.github.com/repos/' + REPOSITORY + path,
            data=json.dumps(payload).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                     'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'})
        with opener.open(request, timeout=120) as response:
            return json.load(response)
    entries = []
    for relative in [item['path'] for item in files] + ['publication-manifest.json']:
        data = (root / relative).read_bytes()
        expected = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        blob = api('/git/blobs', {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
        assert blob['sha'] == expected
        entries.append({'path': PREFIX + '/' + relative, 'mode': '100644', 'type': 'blob', 'sha': expected})
    tree = api('/git/trees', {'base_tree': BASE_TREE, 'tree': entries})['sha']
    commit = api('/git/commits', {'message': 'test: preserve exact import observations and qualification failures',
                                 'tree': tree, 'parents': [BASE]})['sha']
    # Creating an absent ref is atomic and cannot overwrite an existing branch.
    ref = api('/git/refs', {'ref': 'refs/heads/' + BRANCH, 'sha': commit})
    assert ref['object']['sha'] == commit
    print(json.dumps({'branch': BRANCH, 'commit': commit, 'tree': tree, 'files': len(entries),
                      'preservationComplete': index['complete'],
                      'qualificationGateFailures': index.get('qualificationGateFailures', []),
                      'url': 'https://github.com/' + REPOSITORY + '/tree/' + commit + '/' + PREFIX}))


if __name__ == '__main__':
    if not __debug__:
        raise SystemExit('Optimized Python disables publication assertions')
    main()
