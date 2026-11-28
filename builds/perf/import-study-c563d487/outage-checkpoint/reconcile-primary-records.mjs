// Read-only reconciliation of previously acquired primary records. No benchmark execution.
function reconcileNumericCell(records) {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
    const median = (values) => { const x = [...values].sort((a, b) => a - b); return (x[Math.floor((x.length - 1) / 2)] + x[Math.floor(x.length / 2)]) / 2; };
    const one = (kind) => { const x = records.filter((record) => record.kind === kind); assert(x.length === 1, kind + " must be unique"); return x[0].value; };
    const result = (path) => { const x = records.filter((record) => record.kind === "result-file" && record.value.path === path); assert(x.length === 1, path + " must be unique"); return x[0].value.value; };
    assert(records.length === 55, "55 tagged records required");
    const cohort = one("cohort");
    assert(cohort.runId === "46113243549", "run identity");
    assert(cohort.baseline === "9e10d3b3fcf66d344ab31bc42c9b522fa5215da2", "baseline identity");
    assert(cohort.candidate === "399feae29fea358560af27af68f03dfb6d8b6f58", "candidate identity");
    assert(cohort.workflowCommit === "ee9450923d14e95b7958feeffffde4998cf8c5d9", "tooling identity");
    assert(cohort.observerSha256 === "cad1b3fb25766cbd22a1c4260718a0b92353e87276751217ca18dc9eea29c6ef", "observer identity");
    const extraction = one("extraction-complete");
    assert(extraction.rawReportCount === 42 && extraction.attemptedObservationCount === 42 && extraction.plannedObservationCount === 42 && extraction.unattemptedPlannedIds.length === 0, "complete acquisition");
    const observations = records.filter((record) => record.kind === "observation").map((record) => record.value);
    assert(observations.length === 42 && new Set(observations.map((x) => x.id)).size === 42, "42 unique observations");
    const sourceRecords = records.filter((record) => record.kind === "source-identity").map((record) => record.value);
    assert(sourceRecords.length === 2, "two product source records");
    const sources = Object.fromEntries(sourceRecords.map((record) => [record.arm, record]));
    assert(sources.A.sha === cohort.baseline && sources.B.sha === cohort.candidate, "product source heads");
    assert(sources.A.packageEntryCount === 554 && sources.B.packageEntryCount === 554, "package entry counts");
    const packageDiff = one("package-diff");
    assert(JSON.stringify(packageDiff.changedPackageEntries) === JSON.stringify(["js/dictionary/wasm/term-bank-parser.c", "lib/term-bank-parser.wasm"]), "declared package delta");
    const roleCounts = {};
    const common = new Set();
    const storageBytes = new Set();
    const lookupDigests = new Set();
    for (const observation of observations) {
        roleCounts[observation.role.kind] = (roleCounts[observation.role.kind] || 0) + 1;
        assert(observation.runCount === 1 && observation.run.index === 1, "one run per observation");
        assert(observation.report.status === "success" && !observation.report.skippedVerification && observation.report.failureReason === "", "successful report");
        const source = observation.role.arm === "B" ? sources.B : sources.A;
        assert(observation.report.packageSha256 === source.packageSha256 && observation.run.packageSha256 === source.packageSha256, "source-bound package");
        assert(observation.benchmark.productionImportDefaults === true && observation.benchmark.traceEnabled === false, "production defaults and no trace");
        const phases = observation.rawPhases.filter((phase) => phase.browserTiming !== null);
        assert(phases.length === 1, "one browser timing phase");
        const timing = phases[0].browserTiming;
        assert(timing.trigger === "file-input-change" && timing.errorCount === 0, "browser timing boundary");
        assert(near(observation.run.totalImportMs, timing.completedAtMs - timing.startedAtMs), "raw browser clock agreement");
        assert(near(observation.summary.timing.medianMs, observation.run.totalImportMs), "summary clock agreement");
        assert(observation.validation.contentReadable === true && observation.validation.lookup.allExactHeadwordMatches === true, "content/lookup checks");
        assert(observation.validation.termRows === cohort.fixture.termRows && observation.validation.restart.termRows === cohort.fixture.termRows, "row and restart counts");
        common.add(observation.canonicalCommonSha256);
        storageBytes.add(observation.validation.storage.bytes);
        lookupDigests.add(observation.validation.lookup.semanticSha256);
    }
    for (const [kind, count] of Object.entries({candidate:24,control:8,warmup:4,"exhaustive-media":2,memory:4})) assert(roleCounts[kind] === count, "role count " + kind);
    assert(common.size === 1 && storageBytes.size === 1 && lookupDigests.size === 1, "common semantics/storage");
    const indexed = new Map(observations.map((x) => [x.id, x]));
    const timings = result("observations.json");
    assert(timings.length === 36, "36 latency/warmup entries");
    for (const timing of timings) {
        const observation = indexed.get(timing.id);
        assert(observation && observation.role.kind === timing.kind && observation.role.arm === timing.arm && observation.role.pair === timing.pair && near(observation.run.totalImportMs, timing.totalImportMs), "retained paired timing");
    }
    const analysis = result("analysis.json");
    const comparisons = {};
    for (const [kind, count, secondArm, emittedKey] of [["candidate",12,"B","candidateVsBaseline"],["control",4,"C","identicalCodeControl"]]) {
        const pairs = [];
        for (let pair = 1; pair <= count; pair++) {
            const members = timings.filter((x) => x.kind === kind && x.pair === pair);
            assert(members.length === 2, "two members per pair");
            const a = members.find((x) => x.arm === "A"), b = members.find((x) => x.arm === secondArm);
            assert(a && b, "pair arms");
            pairs.push({pair,baselineId:a.id,comparisonId:b.id,baselineMs:a.totalImportMs,comparisonMs:b.totalImportMs,ratio:b.totalImportMs/a.totalImportMs});
        }
        const ratios = pairs.map((x) => x.ratio);
        const emitted = analysis[emittedKey];
        assert(emitted.count === count && emitted.ratios.length === count && ratios.every((ratio, index) => near(ratio, emitted.ratios[index])), "ratio reconstruction");
        const change = (median(ratios) - 1) * 100;
        assert(near(change, emitted.medianPairedChangePercent) && ratios.filter((ratio) => ratio < 1).length === emitted.fasterPairs, "median and wins reconstruction");
        comparisons[kind] = {...emitted, pairs, largestAbsolutePairedChangePercent: Math.max(...ratios.map((ratio) => Math.abs((ratio - 1) * 100)))};
    }
    const memory = result("memory/observations.json");
    const memoryAudit = result("memory/memory-audit.json");
    assert(memory.length === 4 && memoryAudit.observations === 4, "four separate memory observations");
    assert(memory.reduce((sum, x) => sum + x.allObservedSampleCount, 0) === memoryAudit.rawScanCount, "reported scan count");
    for (const observation of memory) {
        assert(observation.authoritativeTiming === false, "memory excluded from authoritative latency");
        if (!observation.qualifiedForWholeTreePss) assert(observation.maxSampledPssKiB === null && observation.maxSampledPrivateKiB === null, "unqualified memory maxima remain null");
    }
    return {
        dictionary:cohort.dictionary, order:cohort.order, runId:46113243549,
        cohort, taggedRecordCount:55, rawReportCount:42, roleCounts,
        allPrimaryReconciliationChecksPass:true,
        sourceRecords, packageDiff, comparisons,
        storageBytes:[...storageBytes][0], lookupSemanticSha256:[...lookupDigests][0],
        memory:{emittedGatePassed:analysis.memoryPassed,rawScanCount:memoryAudit.rawScanCount,
            coverage:memory.map((x) => ({name:x.name,arm:x.arm,qualified:x.qualifiedForWholeTreePss,maximumCoveredSampleGapMs:x.maximumCoveredSampleGapMs,failures:x.qualificationFailures,allObservedSampleCount:x.allObservedSampleCount})),
            qualifiedObservations:memory.filter((x) => x.qualifiedForWholeTreePss).length},
        limits:"Read-only reconciliation of emitted primary records. Confidence intervals are preserved from the already audited emitted analysis; bootstrap and raw process-scan replay are not repeated here. The unavailable local artifact audits/selected archives are separately identified."
    };
}

function parseTaggedNumericRecords(text) {
    return text.split(/\r?\n/).filter((line) => line.length !== 0).map((line) => {
        const prefix = 'MANABITAN_QUALIFICATION_JSON ';
        if (!line.startsWith(prefix)) throw new Error('Unexpected primary record tag');
        return JSON.parse(line.slice(prefix.length));
    });
}

export {reconcileNumericCell, parseTaggedNumericRecords};
