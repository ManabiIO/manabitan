# SPDX-License-Identifier: GPL-3.0-or-later
"""Bind real browser files to the complete current-source natural proof."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from receipt_adapter import AliasReceiptComparator, file_vector, route_receipt, same
from probe_projection import probe_views, prove_probe_relocations


def file_sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    return json.loads(Path(path).read_text())


def bind_preflight(*, core, core_sha256, comparison_path, arms, common_binding):
    same(sorted(arms), ['A', 'B'], 'Both complete browser exports are required')
    same(core['complete'], True, 'Natural proof is incomplete')
    same(core['rows'], 6648310, 'Wrong natural row count')
    same(core['canonicalEntries'], 157150, 'Wrong canonical count')
    same(core['normalContentSpansVerified'], 170, 'Incomplete normal content proof')
    same(core['aliasGroups'], [1, 87, 91, 92, 105, 123, 126, 139], 'Wrong alias geometry')
    same(core['aliasRows'], 175, 'Wrong affected row count')
    same(core['aliasCount'], 8, 'Wrong alias count')
    same(core['aliasInputBytes'], 2983, 'Wrong alias input size')
    same(file_sha(comparison_path), core['comparisonSha256'], 'Natural comparison bytes changed')
    comparison = load(comparison_path)
    same(comparison['complete'], True, 'Natural comparison is incomplete')
    same(comparison['logicalSha256'], core['logicalSha256'], 'Natural logical digest differs')
    same(comparison['canonicalRows'], core['canonicalEntries'], 'Canonical comparison is incomplete')
    same(len(comparison['normalSpanProofs']), 170, 'Normal content span proof is incomplete')
    same(comparison['addedContentBytes'], 2260, 'Alias storage geometry changed')
    binding = deepcopy(common_binding)
    same(core['baseline'], binding['baseline'], 'Natural/browser baseline differs')
    if core['candidate'] == binding['candidate']:
        same(binding.get('candidateTestAmendment'), None, 'Unexpected source amendment for original candidate')
    else:
        amendment = load(Path(__file__).with_name('candidate-test-amendment.json'))
        same(binding['candidateTestAmendment'], amendment, 'Unknown candidate source amendment')
        same(binding['naturalCandidate'], core['candidate'], 'Historical natural candidate was replaced')
        same(amendment['naturalCandidate'], core['candidate'], 'Wrong original candidate')
        same(amendment['naturalCandidateTree'], core['arms']['B']['localTreeIncludingWorkingChanges'], 'Wrong original candidate tree')
        same(amendment['candidate'], binding['candidate'], 'Wrong amended candidate')
        same(amendment['candidate'], binding['sources']['B']['commit'], 'Wrong amended source commit')
        same(amendment['candidateTree'], binding['sources']['B']['tree'], 'Wrong amended source tree')
    same(binding['dictionary'], 'vndb', 'The alternate physical proof is VNDB-only')
    witnesses, verification_hashes = {}, {}
    loaded = {}
    for arm in ('A', 'B'):
        item, oracle, identity = arms[arm], core['arms'][arm], binding['sources'][arm]
        layout, verification = load(item['layoutPath']), load(item['verificationPath'])
        same(layout, item['layout'], 'Preflight layout changed after its own observation')
        same(verification['schemaVersion'], 1, 'Unknown browser verifier schema')
        same(verification['complete'], True, 'Full browser verification failed')
        same(verification['browserNaturalTermFileEqualityEstablished'], True, 'Browser/natural bytes were not proved equal')
        same(verification['failures'], [], 'Browser verifier retained a failure')
        if binding.get('candidateTestAmendment') is not None:
            same(verification['candidateTestAmendment'], binding['candidateTestAmendment'],
                 'Full verifier did not prove the test-only source amendment')
        for key, expected in (
            ('arm', arm), ('protocolBlob', binding['protocolBlob']),
            ('sourceCommit', identity['commit']), ('sourceTree', identity['tree']),
            ('packageSha256', identity['packageSha256']),
            ('sourceManifestSha256', identity['sourceManifestSha256']),
            ('naturalCoreSha256', core_sha256),
            ('pipelineSha256', oracle['pipelineSha256']),
            ('naturalPipelineReportSha256', oracle['pipelineSha256']),
            ('naturalVerificationReportSha256', oracle['verificationSha256']),
            ('naturalComparisonReportSha256', core['comparisonSha256']),
            ('browserLayoutReportSha256', file_sha(item['layoutPath'])),
            ('inputLogicalSha256', core['logicalSha256']),
            ('verifiedRows', core['rows']),
            ('nativePreparedGroups', oracle['nativePreparedGroups']),
            ('coldLookupProbes', oracle['coldLookupProbes']),
            ('coldRecordProbes', oracle['coldRecordProbes']),
        ):
            same(verification[key], expected, 'Browser full proof binding differs: ' + key)
        same(len(verification['groups']), 170, 'Browser verifier missed groups')
        same(len(verification['aliasProofs']), 8 if arm == 'B' else 0, 'Browser alias proof count changed')
        same(verification['fileInventoryAfterReads'], verification['fileInventory'], 'Cold reader changed stored bytes')
        expected_inventory = [{'file': entry['path'], 'bytes': entry['bytes'], 'sha256': entry['sha256'],
                               'normalizedSha256': entry['normalizedSha256']} for entry in layout['files']]
        same(verification['fileInventory'], expected_inventory, 'Full decoder did not read the exact browser export inventory')
        quiet = verification['quiescenceAfterRead']
        same(quiet['parentOpenResources'], 0, 'Cold reader retained an open resource')
        same(quiet['lockEntries'], [], 'Cold reader retained a writer lock')
        same(quiet['stagingEntries'], [], 'Cold reader retained a staging file')
        same(layout['request']['mode'], 'export', 'Preflight did not retain actual browser bytes')
        same(layout['validation']['media']['mode'], 'all', 'Preflight skipped exhaustive media')
        same(len(layout['exclusiveTermHandles']), 5, 'Incomplete exclusive term-handle closure proof')
        same([entry['exclusiveHandleClosed'] for entry in layout['exclusiveTermHandles']], [True] * 5,
             'A browser term writer survived finalization')
        files = file_vector(layout, 'vndb', core['rows'])
        expected_files = [{key: value for key, value in entry.items() if key != 'rawSha256'}
                          for entry in oracle['files']]
        same(files, expected_files, 'Browser full files differ from the frozen natural arm')
        route, aliases = route_receipt(layout['importDebug'])
        same(aliases, {'count': 8, 'inputBytes': 2983} if arm == 'B' else {'count': 0, 'inputBytes': 0},
             'Actual browser alias activation changed')
        witnesses[arm] = {
            'preflightLayoutSha256': file_sha(item['layoutPath']),
            'physicalOutputDigestSha256': layout['probes']['physicalOutputDigestSha256'],
            'semanticProbeDigestSha256': layout['probes']['semanticProbeDigestSha256'],
            'files': files, 'route': route,
        }
        witnesses[arm].update(probe_views(layout['probes']))
        verification_hashes[arm] = file_sha(item['verificationPath'])
        loaded[arm] = (item['receipt'], layout)
    binding['witnesses'] = witnesses
    binding['physicalProof'] = {
        'complete': True, 'baseline': binding['baseline'], 'candidate': binding['candidate'],
        'naturalCoreSha256': core_sha256,
        'naturalReplayComparisonSha256': core['comparisonSha256'],
        'browserVerificationASha256': verification_hashes['A'],
        'browserVerificationBSha256': verification_hashes['B'],
        'canonicalEntries': core['canonicalEntries'], 'normalContentSpansVerified': 170,
        'aliasRows': core['aliasRows'], 'aliasGroups': core['aliasGroups'],
        'logicalSha256': core['logicalSha256'],
        'naturalCandidate': core['candidate'],
        'candidateTestAmendment': binding.get('candidateTestAmendment'),
        'proofMethod': 'Each complete exported browser term-file set equals its fully decoded natural arm after only linked16-byte generation normalization. The exact natural canonical-relocation and ordinary-content-span proof therefore transfers through this equality. Transient browser canonical metadata was not exported or fabricated.',
    }
    binding['physicalProof']['rawProbeRelocationProof'] = prove_probe_relocations(
        arms, comparison, core['comparisonSha256'])
    comparator = AliasReceiptComparator(binding)
    for arm, (receipt, layout) in loaded.items():
        comparator.check(receipt, layout, arm)
    comparator.compare(loaded['A'][0], loaded['B'][0], 'A', 'B', compare_media=True)
    return binding

