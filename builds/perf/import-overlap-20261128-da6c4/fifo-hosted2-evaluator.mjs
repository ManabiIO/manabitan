// Pure evaluator for the prospectively fixed hosted FIFO advance gate.
// A pass only advances to separate production/browser qualification.
export function evaluateFifoCohort(report, setup, expectedPlanSha256) {
    const require = (condition, message) => { if (!condition) { throw new Error(message); } };
    const plan = report.plan;
    const gate = plan.advanceGate;
    require(report.complete === true && setup.complete === true, 'Incomplete cohort or setup');
    require(report.failures.length === 0 && setup.failure === null, 'Cohort contains a failure');
    require(report.planSha256 === expectedPlanSha256 && setup.planSha256 === expectedPlanSha256, 'Plan identity differs');
    require(plan.runtimeCommit === '5048ba3e8a65fc41b9ae898c47b54d5731cd759e', 'Runtime differs');
    require(setup.runtimeCommit === plan.runtimeCommit, 'Setup runtime differs');
    require(report.scriptSha256 === 'd807572f19125d79121be2bb4d355e5fe108cc6fbc2048b533d9ab8445ef1407', 'Timed component differs');
    require(report.node === 'v22.22.0' && setup.node === report.node, 'Node environment differs');
    require(report.compressionWorkersFinalState?.workerCount === 4 &&
        report.compressionWorkersFinalState.allTerminated === true &&
        report.compressionWorkersFinalState.failure === null, 'Terminal worker proof differs');
    require(report.warmups.length === 3 && report.observations.length === 36, 'Observation count differs');
    require(report.sourceOwnershipChecks.length === 3 && report.exhaustiveDecodeVerification.length === 42, 'Semantic check count differs');
    require(gate.minimumPairedMedianSavingMs === 5 && gate.minimumPairedMedianSavingPercent === 5, 'Saving gate differs');
    require(gate.minimumFasterPairsPerComparison === 9 && gate.pairsPerComparison === 12, 'Pair gate differs');
    require(gate.bootstrap.samples === 20000 && gate.bootstrap.initialSeedHex === '0x000da6c4', 'Bootstrap plan differs');
    const records = [...report.warmups, ...report.observations, ...report.sourceOwnershipChecks];
    const decoded = new Map(report.exhaustiveDecodeVerification.map((value) => [value.file, value]));
    require(decoded.size === 42, 'Duplicate decode receipt');
    require(new Set(records.map((value) => value.file)).size === 42, 'Duplicate output receipt');
    for (const record of records) {
        const proof = decoded.get(record.file);
        require(proof && proof.mode === record.mode && proof.label === record.label, 'Missing decode receipt');
        require(proof.blocks === record.hashedBlocks && proof.decodedBytes === record.expectedDecodedBytes &&
            proof.outputSha256 === record.outputSha256, 'Decode receipt differs');
        require(record.pending === 0 && record.queued === 0, 'Undrained compression owner');
    }
    for (const record of [...report.warmups, ...report.observations]) {
        require(record.hashedBlocks === 103 && record.expectedDecodedBytes === 100300626, 'Incomplete full output');
        require(record.outputBytes === 12326040 &&
            record.outputSha256 === 'f9bcbead26736ae31ae3776fb65618b457e8488e6e097b32451103d237e03747', 'Output oracle differs');
        require(record.jobs.length === 103 && record.maxPendingGroups === 2, 'Work/concurrency differs');
        if (record.mode === 'B-first-free-fifo') {
            require(JSON.stringify(record.maxPostedByPhysicalWorker) === '[1,1,1,1]', 'FIFO physical concurrency differs');
        }
    }
    for (const record of report.sourceOwnershipChecks) {
        require(record.callerColumnsPoisonedBeforeSourceConsumed === true &&
            record.sourcePoisonedAfterSourceConsumedBeforeCompletionDelivery === true &&
            record.heldBeforePoison > 0, 'Ownership witness differs');
    }
    const rows = plan.orders.map((order, round) => {
        const records = report.observations.filter((value) => value.round === round);
        require(records.length === 3, 'Round cardinality differs');
        require(JSON.stringify(records.map((value) => value.mode)) === JSON.stringify(order), 'Round order differs');
        require(records.every((value) => JSON.stringify(value.order) === JSON.stringify(order)), 'Recorded order differs');
        const row = Object.fromEntries(records.map((value) => [value.mode, value.elapsedMs]));
        require(plan.modes.every((mode) => Number.isFinite(row[mode]) && row[mode] > 0), 'Invalid duration');
        return {round, order, A: row['A-rotation'], B: row['B-first-free-fifo'], C: row['C-rotation-control']};
    });
    require(rows.length === 12, 'Round count differs');
    return {
        schemaVersion: 1, planSha256: expectedPlanSha256, runtimeCommit: plan.runtimeCommit,
        componentSourceSha256: report.scriptSha256, ...evaluateFifoRows(rows),
    };
}

export function evaluateFifoRows(rows) {
    if (rows.length !== 12 || rows.some((row) => !['A', 'B', 'C'].every((key) => Number.isFinite(row[key]) && row[key] > 0))) {
        throw new Error('Exactly twelve finite positive paired rows are required');
    }
    const median = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const percentile = (sorted, probability) => {
        const index = (sorted.length - 1) * probability;
        const lower = Math.floor(index);
        const fraction = index - lower;
        return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]);
    };
    const metrics = {};
    for (const control of ['A', 'C']) {
        metrics[control] = {
            differencesMs: rows.map((row) => row.B - row[control]),
            differencesPercent: rows.map((row) => 100 * (row.B / row[control] - 1)),
            bootstrapMs: [], bootstrapPercent: [],
        };
    }
    let state = 0x000da6c4;
    for (let sample = 0; sample < 20000; ++sample) {
        const indexes = [];
        for (let draw = 0; draw < 12; ++draw) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            state >>>= 0;
            indexes.push(Math.floor(state / 4294967296 * 12));
        }
        for (const metric of Object.values(metrics)) {
            metric.bootstrapMs.push(median(indexes.map((index) => metric.differencesMs[index])));
            metric.bootstrapPercent.push(median(indexes.map((index) => metric.differencesPercent[index])));
        }
    }
    const comparisons = {};
    for (const control of ['A', 'C']) {
        const metric = metrics[control];
        const candidateTotalMs = rows.reduce((sum, row) => sum + row.B, 0);
        const controlTotalMs = rows.reduce((sum, row) => sum + row[control], 0);
        const interval = (values) => {
            values.sort((a, b) => a - b);
            return [percentile(values, 0.025), percentile(values, 0.975)];
        };
        const savingMs = -median(metric.differencesMs);
        const savingPercent = -median(metric.differencesPercent);
        const ms95 = interval(metric.bootstrapMs);
        const percent95 = interval(metric.bootstrapPercent);
        const fasterPairs = rows.filter((row) => row.B < row[control]).length;
        const checks = {
            medianSavingMs: savingMs >= 5,
            medianSavingPercent: savingPercent >= 5,
            fasterPairs: fasterPairs >= 9,
            equalWork: candidateTotalMs < controlTotalMs,
            millisecondInterval: ms95[1] < 0,
            percentageInterval: percent95[1] < 0,
        };
        comparisons['B/' + control] = {
            differencesMs: metric.differencesMs,
            differencesPercent: metric.differencesPercent,
            pairedMedianSavingMs: savingMs, pairedMedianSavingPercent: savingPercent,
            fasterPairs, candidateTotalMs, controlTotalMs,
            equalWorkChangePercent: 100 * (candidateTotalMs / controlTotalMs - 1),
            pairedMedianDifferenceMs95: ms95, pairedMedianDifferencePercent95: percent95,
            checks, pass: Object.values(checks).every(Boolean),
        };
    }
    const controlDifferencesPercent = rows.map((row) => 100 * (row.C / row.A - 1));
    const controlMedianPercent = median(controlDifferencesPercent);
    const maximumControlDriftPercent = 0.5 * Math.min(
        Math.abs(comparisons['B/A'].pairedMedianSavingPercent), Math.abs(comparisons['B/C'].pairedMedianSavingPercent),
    );
    const controlDriftPass = Math.abs(controlMedianPercent) < maximumControlDriftPercent;
    const advance = comparisons['B/A'].pass && comparisons['B/C'].pass && controlDriftPass;
    return {
        advance,
        outcome: advance ? 'advance-to-separate-production-and-browser-qualification' : 'inconclusive-or-reject',
        scope: 'Scheduling component only; no whole-import or browser-memory claim.',
        rows, comparisons,
        control: {differencesPercent: controlDifferencesPercent, pairedMedianPercent: controlMedianPercent,
            maximumAbsolutePercentExclusive: maximumControlDriftPercent, pass: controlDriftPass},
        bootstrap: {samples: 20000, seedHex: '0x000da6c4', finalState: state,
            resamplingUnit: 'Twelve paired rounds with one shared index stream for all four metrics',
            interval: '95% percentile, type7'},
    };
}
