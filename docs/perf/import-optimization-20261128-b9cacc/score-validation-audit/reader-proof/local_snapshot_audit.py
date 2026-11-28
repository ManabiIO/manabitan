#!/usr/bin/env python3
"""Run unchanged c7a18 audit functions over authenticated connector snapshots."""
import argparse
import copy
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import time
from unittest import mock

READER_SHA = '02e55354804c9c44275c8aaacb95a9d3a5949865dd74e707caff54b9c0dec650'
CONFIG_SHA = '82ab57d37b683eed39e8ddc1dc3a09dd55298deed511f888f5c8aa824d1508cb'
BASELINE = '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2'
CANDIDATE = 'f21bda709a5b3374f4d5175f8234c94439936040'
REPOSITORY = 'ManabiIO/manabitan'
RUN_ID = 46103789342
API = 'https://api.github.com/repos/' + REPOSITORY
API_PATHS = {
    f'/actions/runs/{RUN_ID}',
    f'/actions/runs/{RUN_ID}/jobs?per_page=100',
    f'/actions/runs/{RUN_ID}/artifacts?per_page=100',
    '/git/commits/' + BASELINE,
    '/git/commits/' + CANDIDATE,
}
MEASURED_FILES = [
    'package-lock.json', 'test/perf/dictionaries.lock.json',
    'dev/perf/benchmark-support.js', 'dev/perf/dictionary-fixtures.js',
    'dev/perf/import-benchmark.js', 'test/chromium/import-flags-ab-benchmark.js',
    'test/chromium/extension-two-dictionary-import.e2e.js', 'test/e2e/import-timing.js',
    'ext/js/pages/settings/dictionary-import-controller.js',
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def owned_file(root, relative):
    require(isinstance(relative, str) and not pathlib.Path(relative).is_absolute(), 'Expected relative evidence file')
    path = (root / relative).resolve()
    require(path.is_relative_to(root.resolve()) and path.is_file(), 'Evidence file escapes input root or is absent')
    return path


class SnapshotTransport:
    def __init__(self, root, manifest):
        self.root = root
        self.manifest = manifest
        self.used_endpoints = []
        self.downloads = []
        require(set(manifest['snapshots']) == API_PATHS, 'Snapshot endpoint set differs from the exact allowlist')
        require(manifest['repository'] == REPOSITORY and manifest['runId'] == RUN_ID, 'Snapshot source identity')
        self.snapshots = {}
        for endpoint, item in manifest['snapshots'].items():
            require(item['sourceUrl'] == API + endpoint, 'Snapshot source URL differs from its allowlisted endpoint')
            path = owned_file(root, item['file'])
            require(path.stat().st_size <= 8 * 1024 * 1024, 'Oversized API snapshot')
            require(digest(path) == item['sha256'], 'API snapshot byte digest mismatch')
            self.snapshots[endpoint] = json.loads(path.read_text())
        listing = self.snapshots[f'/actions/runs/{RUN_ID}/artifacts?per_page=100']
        ids = [str(item['id']) for item in listing['artifacts']]
        require(len(ids) == len(set(ids)) and set(ids) == set(manifest['artifacts']), 'Artifact ID/file mapping differs from source listing')

    def api(self, endpoint):
        require(endpoint in API_PATHS, 'Unexpected API endpoint access')
        self.used_endpoints.append(endpoint)
        return copy.deepcopy(self.snapshots[endpoint])

    def download_with_original_verifier(self, reader, original_download, artifact, target):
        key = str(artifact['id'])
        require(key in self.manifest['artifacts'], 'Unexpected artifact ID access')
        item = self.manifest['artifacts'][key]
        path = owned_file(self.root, item['file'])
        expected_url = API + f'/actions/artifacts/{key}/zip'

        class LocalOpener:
            @staticmethod
            def open(request, timeout=60):
                require(request.full_url == expected_url and request.get_method() == 'GET', 'Unexpected artifact transport request')
                return path.open('rb')

        # Only transport is replaced. The original one-GiB limit, streamed SHA,
        # metadata byte-size checks, target rewind and proof construction run.
        with mock.patch.object(reader.urllib.request, 'build_opener', return_value=LocalOpener()):
            proof = original_download(artifact, target)
        require(proof['sha256'] == item['sha256'], 'Local archive differs from the ordinary-download receipt')
        self.downloads.append({'artifactId': artifact['id'], 'localFile': item['file'], **proof})
        return proof


def source_binding(reader, reader_path, baseline):
    require(digest(reader_path) == READER_SHA, 'Approved reader module changed')
    require(digest(reader.CONFIG_PATH) == CONFIG_SHA, 'Approved experiment configuration changed')
    actual = subprocess.check_output(['git', '-C', str(baseline), 'rev-parse', 'HEAD'], text=True).strip()
    require(actual == BASELINE, 'Local source checkout is not the exact baseline')
    paths = sorted(set(MEASURED_FILES) | set(reader.CONFIG['supportSha256']))
    subprocess.run(['git', '-C', str(baseline), 'diff', '--quiet', 'HEAD', '--', *paths], check=True)
    hashes = {}
    for relative in paths:
        hashes[relative] = digest(reader.ROOT / relative)
        require(hashes[relative] == digest(baseline / relative), 'Reader source differs from baseline: ' + relative)
    for relative, expected in reader.CONFIG['supportSha256'].items():
        reader.same(hashes[relative], expected, 'Frozen independent support ' + relative)
    return hashes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reader', required=True, type=pathlib.Path)
    parser.add_argument('--baseline', required=True, type=pathlib.Path)
    parser.add_argument('--inputs', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    require(not args.output.exists(), 'Never overwrite an audit acquisition')
    require(digest(args.reader) == READER_SHA, 'Approved reader module identity')
    manifest_path = args.inputs / 'transport-manifest.json'
    manifest_hash = digest(manifest_path)
    transport = SnapshotTransport(args.inputs, json.loads(manifest_path.read_text()))
    spec = importlib.util.spec_from_file_location('frozen_c7a18_reader', args.reader)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    source_hashes = source_binding(reader, args.reader, args.baseline)
    run = transport.snapshots[f'/actions/runs/{RUN_ID}']
    jobs = transport.snapshots[f'/actions/runs/{RUN_ID}/jobs?per_page=100']['jobs']
    expected_jobs = {'validate'} | {f'{d} ({o})' for d in ('jmdict', 'jitendex', 'vndb') for o in ('AB', 'BA')}
    require(run['status'] == 'completed', 'Source-run snapshot is not terminal; no audit acquisition starts')
    require({j['name'] for j in jobs} == expected_jobs and len(jobs) == 7, 'Source job set differs from registered workflow')
    require(all(j['status'] == 'completed' for j in jobs), 'Source jobs are not all terminal')
    reader.api = transport.api
    original_download = reader.download
    reader.download = lambda artifact, target: transport.download_with_original_verifier(reader, original_download, artifact, target)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {'schemaVersion': 1, 'readerCommit': 'c7a18f22ff374503bbe73596552bb9d9f628fc2b',
              'readerSha256': READER_SHA, 'configSha256': CONFIG_SHA,
              'adapterSha256': digest(pathlib.Path(__file__)), 'sourceHashes': source_hashes,
              'transportManifestSha256': manifest_hash, 'acquiredAtEpochSeconds': time.time(),
              'transportScope': 'Authenticated GitHub connector API snapshots and ordinary signed-URL artifact downloads; no token impersonation. Unchanged audit and download verification functions.',
              'nativeOrBrowserExecution': False, 'performancePromotionClaim': False}
    try:
        report['experiment'] = reader.inspect_experiment('score-validation', reader.CONFIG['experiments']['score-validation'])
        require(set(transport.used_endpoints) == API_PATHS, 'Frozen audit did not consume every required API snapshot')
        require(digest(manifest_path) == manifest_hash, 'Transport manifest changed during audit')
        require(source_binding(reader, args.reader, args.baseline) == source_hashes, 'Frozen reader/source bytes changed during audit')
        report['allSelectedFrozenCohortsAudited'] = report['experiment']['completeFrozenCohortAudited'] is True
    except Exception as error:
        report['allSelectedFrozenCohortsAudited'] = False
        report['auditError'] = type(error).__name__ + ': ' + str(error)
    report['transportDownloads'] = transport.downloads
    report['usedEndpoints'] = transport.used_endpoints
    (args.output / 'report.json').write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + '\n')
    print('BEGIN_MANABITAN_IMPORT_AUDIT_JSON')
    print(json.dumps(report, sort_keys=True, allow_nan=False))
    print('END_MANABITAN_IMPORT_AUDIT_JSON')
    return 0 if report['allSelectedFrozenCohortsAudited'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
