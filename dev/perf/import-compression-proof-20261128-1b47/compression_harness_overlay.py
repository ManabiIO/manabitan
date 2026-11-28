# SPDX-License-Identifier: GPL-3.0-or-later
"""Deterministic, symmetric proof-only overlay for the corrected compression study.

The frozen original harness stays tracked and unmodified. The study driver may
apply this overlay to that exact source, recording both hashes, and must use the
same result in every arm. No product source, import timer, old validation field,
original physical digest, or original lookup observation is changed.
"""

import hashlib


ORIGINAL_HARNESS_SHA256 = 'd0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf'
PROOF_DOMAIN = 'manabitan-compression-proof-v1'


PRE_RESTART_LOOKUP_BRANCH = r"""        if (expression === 'benchmarkCompressionProofLookups') {
            const observations = [];
            for (const term of arg.terms) {
                const result = await send('termsFind', {
                    text: term,
                    details: {primaryReading: '', matchType: 'exact', deinflect: false},
                    optionsContext: {index: 0},
                });
                const entries = result?.dictionaryEntries;
                const hasExactHeadwordMatch = Array.isArray(entries) && entries.some((entry) => (
                    entry.definitions?.some((definition) => definition.dictionary === arg.title) &&
                    entry.headwords?.some((headword) => headword.term === term || headword.reading === term)
                ));
                if (result?.originalTextLength !== term.length || !hasExactHeadwordMatch) {
                    throw new Error(`Compression proof lookup returned no complete exact dictionary result: ${term}`);
                }
                const resultJson = JSON.stringify(result);
                const bytes = new TextEncoder().encode(resultJson);
                const digest = await crypto.subtle.digest('SHA-256', bytes);
                const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
                observations.push({term, resultJson, utf8Bytes: bytes.byteLength, sha256, results: entries.length, originalTextLength: result.originalTextLength, hasExactHeadwordMatch});
            }
            return observations;
        }
"""


PROOF_INITIALIZATION = r"""                if (quickImportBenchmarkDictionaryId !== 'jmdict' && quickImportBenchmarkDictionaryId !== 'jitendex') {
                    fail('Compression proof study supports only its two registered dictionaries');
                }
                const compressionProof = {
                    schemaVersion: 1,
                    domain: 'manabitan-compression-proof-v1',
                    dictionary: {title: fixture.expectedTitle, revision: fixture.revision, probeTerms: [...probeTerms]},
                    physical: {preRestart: null, postRestart: null},
                    references: {preRestart: null, postRestart: null},
                    decoded: {preRestart: null, postRestart: null},
                };
                // Preserve partial proof on a later failure; the policy requires a complete proof.
                report.benchmark.compressionProof = compressionProof;
"""


PHYSICAL_CAPTURE = r"""                    const json = JSON.stringify(canonical);
                    const sha256 = createHash('sha256').update(json).digest('hex');
                    const phase = compressionProof.physical.preRestart === null ? 'preRestart' : 'postRestart';
                    if (compressionProof.physical[phase] !== null) {
                        fail('Compression physical proof was captured more than twice');
                    }
                    compressionProof.physical[phase] = {json, utf8Bytes: Buffer.byteLength(json, 'utf8'), sha256};
                    compressionProof.references[phase] = results.map(({term, probes}) => ({
                        term,
                        probes: probes.map((probe) => {
                            const diagnostics = probe.diagnostics;
                            const stateView = diagnostics?.offscreenState ?? diagnostics?.localState ?? diagnostics;
                            const rows = Array.isArray(stateView?.rowSample) ? stateView.rowSample : [];
                            return {
                                term: probe.term,
                                rows: rows.map((row) => ({
                                    id: row.id ?? null,
                                    dictionary: row.dictionary ?? null,
                                    matchSource: row.matchSource ?? null,
                                    expression: row.expression ?? null,
                                    reading: row.reading ?? null,
                                    rawEntryContentOffset: row.rawEntryContentOffset ?? null,
                                    rawEntryContentLength: row.rawEntryContentLength ?? null,
                                    rawEntryContentDictName: row.rawEntryContentDictName ?? null,
                                    glossaryLength: row.glossaryLength ?? null,
                                    decodedContentLength: row.decodedContentDebug?.length ?? null,
                                    readErrorDetails: row.readErrorDetails ?? null,
                                })),
                            };
                        }),
                    }));
                    return sha256;"""


def _replace_once(source, old, new):
    count = source.count(old)
    if count != 1:
        raise ValueError(f'Compression proof overlay anchor must occur exactly once (observed {count})')
    return source.replace(old, new, 1)


def apply_overlay(source):
    """Return the only supported overlay; reject any non-frozen input source."""
    if not isinstance(source, str):
        raise TypeError('Compression proof harness source must be text')
    if hashlib.sha256(source.encode('utf-8')).hexdigest() != ORIGINAL_HARNESS_SHA256:
        raise ValueError('Compression proof overlay requires the exact original frozen harness')

    source = _replace_once(
        source,
        "        if (expression === 'benchmarkLookups') {\n            const observations = [];",
        "        if (expression === 'benchmarkLookups') {\n            const observations = [];\n            const compressionProofResults = [];",
    )
    source = _replace_once(
        source,
        '                    const bytes = new TextEncoder().encode(JSON.stringify(result));',
        '                    const resultJson = JSON.stringify(result);\n                    const bytes = new TextEncoder().encode(resultJson);',
    )
    source = _replace_once(
        source,
        '                    observations.push({pass, term, elapsedMs, results: entries.length, originalTextLength: result.originalTextLength, hasExactHeadwordMatch, sha256});',
        "                    if (arg.captureCompressionProof === true && pass === 0) {\n"
        '                        compressionProofResults.push({term, resultJson, utf8Bytes: bytes.byteLength, sha256, results: entries.length, originalTextLength: result.originalTextLength, hasExactHeadwordMatch});\n'
        '                    }\n'
        '                    observations.push({pass, term, elapsedMs, results: entries.length, originalTextLength: result.originalTextLength, hasExactHeadwordMatch, sha256});',
    )
    source = _replace_once(
        source,
        "            return {timingBoundary: 'settings-page termsFind RPC; first pass after restart, then five warm passes; excludes result hashing', observations};",
        "            return {timingBoundary: 'settings-page termsFind RPC; first pass after restart, then five warm passes; excludes result hashing', observations, ...(arg.captureCompressionProof === true ? {compressionProofResults} : {})};",
    )
    source = _replace_once(
        source,
        "        if (expression === 'benchmarkLookups') {",
        PRE_RESTART_LOOKUP_BRANCH + "        if (expression === 'benchmarkLookups') {",
    )
    source = _replace_once(
        source,
        "                if (probeTerms.length !== 12) { fail('Insufficient benchmark content probes'); }\n                const probeResults = [];",
        "                if (probeTerms.length !== 12) { fail('Insufficient benchmark content probes'); }\n" + PROOF_INITIALIZATION + '                const probeResults = [];',
    )
    source = _replace_once(
        source,
        "                    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');",
        PHYSICAL_CAPTURE,
    )
    source = _replace_once(
        source,
        '                const preRestartOutputDigest = probeDigest(probeResults);\n                await relaunchPersistentContext();',
        "                const preRestartOutputDigest = probeDigest(probeResults);\n"
        "                compressionProof.decoded.preRestart = await evalSendMessage(page, 'benchmarkCompressionProofLookups', {title: fixture.expectedTitle, terms: probeTerms});\n"
        '                await relaunchPersistentContext();',
    )
    source = _replace_once(
        source,
        "                const lookup = await evalSendMessage(page, 'benchmarkLookups', {title: fixture.expectedTitle, terms: probeTerms});",
        "                const lookupWithCompressionProof = await evalSendMessage(page, 'benchmarkLookups', {title: fixture.expectedTitle, terms: probeTerms, captureCompressionProof: true});\n"
        '                const {compressionProofResults, ...lookup} = lookupWithCompressionProof;\n'
        '                compressionProof.decoded.postRestart = compressionProofResults;\n'
        '                if (JSON.stringify(compressionProof.decoded.preRestart) !== JSON.stringify(compressionProof.decoded.postRestart)) {\n'
        "                    fail('Decoded compression proof changed across restart');\n"
        '                }',
    )
    return source
