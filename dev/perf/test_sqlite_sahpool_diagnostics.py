# SPDX-License-Identifier: GPL-3.0-or-later
"""Witness the diagnostic's anchors and fail-closed worker observations."""

import copy
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('sahpool_diagnostics', Path(__file__).with_name('sqlite-sahpool-worker-diagnostics.py'))
DIAGNOSTICS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAGNOSTICS)


def receipt(candidate):
    workers = [{'id': '1', 'type': 'worker', 'url': 'chrome-extension://test/js/background/offscreen-dictionary-worker.js' + ('?opfs-disable' if candidate else '')}]
    if not candidate:
        workers.append({'id': '2', 'type': 'worker', 'url': 'chrome-extension://test/lib/sqlite/sqlite3-opfs-async-proxy.js'})
    return {'authoritativeTiming': False, 'contexts': [{'readyMs': 20, 'workers': workers}] * 2,
            'firstLookup': {'pass': 0, 'hasExactHeadwordMatch': True, 'term': '辞典', 'originalTextLength': 2,
                            'results': 3, 'sha256': 'a' * 64, 'elapsedMs': 1}}


class DiagnosticWitness(unittest.TestCase):
    def test_discovers_existing_and_later_nested_workers(self):
        probe = DIAGNOSTICS.HELPER + r'''
const assert = (await import('node:assert/strict')).default
const handlers = new Map()
const requests = []
const session = {
    on: (name, callback) => handlers.set(name, callback),
    send: async (name, params) => {
        requests.push({name, params})
        if (name === 'Target.getTargets') {
            return {targetInfos: [
                {targetId: 'primary', type: 'worker', url: 'chrome-extension://test/js/background/offscreen-dictionary-worker.js'},
                {targetId: 'proxy', type: 'worker', url: 'chrome-extension://test/lib/sqlite3-opfs-async-proxy.js'},
            ]}
        }
    },
}
await observeSahpoolWorkers({browser: () => ({newBrowserCDPSession: async () => session})}, 1)
assert.deepEqual(requests, [
    {name: 'Target.setDiscoverTargets', params: {discover: true, filter: [{}]}},
    {name: 'Target.getTargets', params: {filter: [{}]}},
])
assert.equal(sahpoolDiagnostic.contexts[0].workers.length, 2)
handlers.get('Target.targetCreated')({targetInfo: {targetId: 'later', type: 'worker', url: ''}})
handlers.get('Target.targetInfoChanged')({targetInfo: {targetId: 'later', type: 'worker', url: 'chrome-extension://test/later.js'}})
assert.equal(sahpoolDiagnostic.contexts[0].workers.length, 3)
assert.equal(sahpoolDiagnostic.contexts[0].workers[2].url, 'chrome-extension://test/later.js')
'''
        subprocess.run(['node', '--input-type=module', '-e', probe], check=True, capture_output=True)

    def test_overlay_preserves_existing_verification_and_parses(self):
        original = (ROOT / 'test/chromium/extension-two-dictionary-import.e2e.js').read_text()
        modified = DIAGNOSTICS.overlay(original)
        self.assertIn('authoritativeTiming: false, // Separate worker diagnostic', modified)
        self.assertIn('Persisted content probe digest changed across restart', modified)
        self.assertIn("expression === 'sahpoolFirstLookup' ? 1 : 6", modified)
        with tempfile.NamedTemporaryFile(suffix='.mjs', mode='w') as file:
            file.write(modified)
            file.flush()
            subprocess.run(['node', '--check', file.name], check=True, capture_output=True)
        with self.assertRaises(ValueError):
            DIAGNOSTICS.overlay(modified)

    def test_rejects_absent_observers_and_any_candidate_proxy(self):
        self.assertEqual(DIAGNOSTICS.verify_workers(receipt(False), False)[0]['sqliteProxyWorkers'], 1)
        self.assertEqual(DIAGNOSTICS.verify_workers(receipt(True), True)[0]['sqliteProxyWorkers'], 0)
        for candidate, broken in [(False, receipt(True)), (True, receipt(False))]:
            with self.assertRaises(ValueError):
                DIAGNOSTICS.verify_workers(broken, candidate)
        for field, value in [('contexts', []), ('firstLookup', None), ('authoritativeTiming', True)]:
            broken = copy.deepcopy(receipt(True))
            broken[field] = value
            with self.assertRaises(ValueError):
                DIAGNOSTICS.verify_workers(broken, True)
        broken = copy.deepcopy(receipt(True))
        broken['contexts'][0]['workers'] = []
        with self.assertRaises(ValueError):
            DIAGNOSTICS.verify_workers(broken, True)
        for suffix in ['?opfs-disabled', '#?opfs-disable', '?other=opfs-disable']:
            broken = copy.deepcopy(receipt(True))
            broken['contexts'][0]['workers'][0]['url'] = 'chrome-extension://test/js/background/offscreen-dictionary-worker.js' + suffix
            with self.assertRaises(ValueError):
                DIAGNOSTICS.verify_workers(broken, True)
        valid = copy.deepcopy(receipt(True))
        valid['contexts'][0]['workers'][0]['url'] += '&other=1'
        self.assertEqual(DIAGNOSTICS.verify_workers(valid, True)[0]['sqliteProxyWorkers'], 0)
        for field, value in [('results', 0), ('sha256', ''), ('originalTextLength', 1), ('elapsedMs', float('nan'))]:
            broken = copy.deepcopy(receipt(True))
            broken['firstLookup'][field] = value
            with self.assertRaises(ValueError):
                DIAGNOSTICS.verify_workers(broken, True)


if __name__ == '__main__':
    unittest.main()
