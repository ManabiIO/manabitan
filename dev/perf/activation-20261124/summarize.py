#!/usr/bin/env python3
"""Summarize diagnostic-only activation. Never interpret these times as performance evidence."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--report', type=Path, required=True)
parser.add_argument('--mode', choices=['prefix', 'cache'], required=True)
parser.add_argument('--dictionary', choices=['jmdict', 'jitendex', 'vndb'], required=True)
parser.add_argument('--source', required=True)
parser.add_argument('--tree', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
report_bytes = args.report.read_bytes()
report = json.loads(report_bytes)
diagnostics = []
for phase in report.get('phases', []):
    data = phase.get('data')
    if not isinstance(data, dict) or data.get('kind') != 'dictionary-import':
        continue
    for entry in data.get('importDebug', {}).get('importerPhaseTimings', []):
        if entry.get('phase') == 'activation-diagnostic':
            diagnostics.append(entry.get('details', {}))
events = diagnostics[0].get('events', []) if len(diagnostics) == 1 else []
counts = Counter(event.get('event') for event in events)
checks = {
    'completeImportSucceeded': report.get('status') == 'success',
    'oneDiagnosticPhase': len(diagnostics) == 1,
    'diagnosticOnly': len(diagnostics) == 1 and diagnostics[0].get('instrumentationOnly') is True,
    'productionOffscreenOwner': len(diagnostics) == 1 and diagnostics[0].get('owner') == 'offscreen',
    'eventsObserved': len(events) > 0,
}
details = {}
if args.mode == 'prefix':
    attempts = [event for event in events if event.get('event') == 'attempt']
    begins = [event for event in events if event.get('event') == 'begin']
    private = [event for event in begins if event.get('privateSource') is True]
    shared = [event for event in begins if event.get('privateSource') is False]
    eligible = [event for event in attempts if event.get('compressionDictName') == 'jmdict' and event.get('sourceKind') == 'private' and event.get('ownsContent') is True and event.get('force') is True and event.get('uncompressedBytes', 0) > 0]
    first_private = [event for event in attempts if event.get('sourceKind') == 'private' and event.get('force') is False]
    prefixes = [event for event in events if event.get('event') == 'private-prefix']
    suffixes = [event for event in events if event.get('event') == 'private-suffix']
    checks.update({
        'attemptsObserved': len(attempts) > 0,
        'privateAdmissionMatchesOwnedForcedInputs': len(private) == len(eligible),
        'everyPrivateAdmissionHasOnePlacement': len(private) == len(prefixes) + len(suffixes),
        'firstPrivateSelectionUnchanged': all(event.get('initialSelection') is False for event in private),
        'boundedPrefixCursor': all(event['primaryStartOffset'] + event['primaryBytesUpperBound'] <= event['maximumEndOffset'] == 0xfffffffe for event in prefixes),
    })
    if args.dictionary == 'jitendex':
        checks['privatePrefixActivated'] = len(prefixes) > 0
        checks['firstPrivateBatchObserved'] = len(first_private) > 0
    else:
        checks['negativeControlHasNoPrivateAdmission'] = len(private) == 0
        if args.dictionary == 'jmdict':
            checks['existingSharedRouteActivated'] = len(shared) > 0
    details = {
        'attempts': len(attempts),
        'privateAdmissions': len(private),
        'privatePrefixReservations': len(prefixes),
        'privateSuffixFallbacks': len(suffixes),
        'existingSharedAdmissions': len(shared),
        'firstPrivateAttempts': len(first_private),
        'privateAdmittedContentBytes': sum(event['uncompressedBytes'] for event in private),
        'privateAdmittedUniqueCount': sum(event['uniqueCount'] for event in private),
        'eligibleOwnedSourceBytes': sum(event['sourceBytes'] for event in eligible),
    }
else:
    publishers = [event for event in events if event.get('event') == 'cache-publisher']
    receivers = [event for event in events if event.get('event') == 'cache-receiver']
    pairs = []
    previous_publisher = None
    for event in events:
        if event.get('event') == 'cache-publisher':
            previous_publisher = event
        elif event.get('event') == 'cache-receiver':
            pairs.append((previous_publisher, event))
            previous_publisher = None
    reused = [event for event in receivers if event.get('reusePublishedRange') is True]
    checks.update({
        'publishersObserved': len(publishers) > 0,
        'cacheReceiverObserved': len(receivers) > 0,
        'synchronousProofActivated': len(reused) > 0,
        'receiverMatchesImmediatePublisher': all(publisher is not None and all(publisher.get(key) == receiver.get(key) for key in ['publishedContiguous', 'count', 'sourceBytes']) for publisher, receiver in pairs),
        'reuseRequiresPublicationProof': all(event.get('publishedContiguous') is True for event in reused),
    })
    details = {
        'publisherCalls': len(publishers),
        'publisherProofTrueCalls': sum(event.get('publishedContiguous') is True for event in publishers),
        'receiverCalls': len(receivers),
        'receiverReusedProofCalls': len(reused),
        'receiverReusedProofRows': sum(event['count'] for event in reused),
        'receiverReusedSourceBytes': sum(event['sourceBytes'] for event in reused),
    }
result = {
    'schemaVersion': 1,
    'timingsAuthoritative': False,
    'source': args.source,
    'tree': args.tree,
    'dictionary': args.dictionary,
    'mode': args.mode,
    'packageSha256': report.get('packageSha256'),
    'browserVersion': report.get('browserVersion'),
    'reportSha256': hashlib.sha256(report_bytes).hexdigest(),
    'activationOwner': diagnostics[0].get('owner') if len(diagnostics) == 1 else None,
    'eventCounts': dict(counts),
    'activation': details,
    'checks': checks,
    'allChecksPass': all(checks.values()),
    'events': events,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: value for key, value in result.items() if key != 'events'}, indent=2))
raise SystemExit(0 if result['allChecksPass'] else 1)
