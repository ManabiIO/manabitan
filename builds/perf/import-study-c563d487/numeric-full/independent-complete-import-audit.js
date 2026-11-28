// Read-only independent audit of frozen a7f7 JSONL receipts. No acquisition or product code.

class PythonRandom897 {
  constructor() {
    this.mt = new Uint32Array(624);
    this.mt[0] = 19650218;
    for (let i = 1; i < 624; i++) this.mt[i] = (Math.imul(1812433253, this.mt[i - 1] ^ (this.mt[i - 1] >>> 30)) + i) >>> 0;
    let i = 1;
    for (let k = 0; k < 624; k++) {
      this.mt[i] = ((this.mt[i] ^ Math.imul(this.mt[i - 1] ^ (this.mt[i - 1] >>> 30), 1664525)) + 897) >>> 0;
      if (++i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
    }
    for (let k = 0; k < 623; k++) {
      this.mt[i] = ((this.mt[i] ^ Math.imul(this.mt[i - 1] ^ (this.mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      if (++i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
    }
    this.mt[0] = 0x80000000;
    this.index = 624;
  }
  integer() {
    if (this.index >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = (this.mt[i] & 0x80000000) | (this.mt[(i + 1) % 624] & 0x7fffffff);
        this.mt[i] = (this.mt[(i + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0)) >>> 0;
      }
      this.index = 0;
    }
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  random() {
    return ((this.integer() >>> 5) * 67108864 + (this.integer() >>> 6)) / 9007199254740992;
  }
}
function receiptMedian(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function receiptPairedStatistics(pairs) {
  if (!pairs.length) return null;
  const ratios = pairs.map(({left, right}) => right / left);
  const changesMs = pairs.map(({left, right}) => right - left);
  const rng = new PythonRandom897();
  const bootstrap = [];
  for (let iteration = 0; iteration < 10000; iteration++) {
    const sample = [];
    for (let index = 0; index < ratios.length; index++) sample.push(ratios[Math.floor(rng.random() * ratios.length)]);
    bootstrap.push(receiptMedian(sample));
  }
  bootstrap.sort((a, b) => a - b);
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  return {
    count: pairs.length,
    ratios,
    baselineMs: pairs.map(({left}) => left),
    candidateMs: pairs.map(({right}) => right),
    baselineMedianMs: receiptMedian(pairs.map(({left}) => left)),
    candidateMedianMs: receiptMedian(pairs.map(({right}) => right)),
    medianPairedChangeMs: receiptMedian(changesMs),
    medianPairedChangePercent: (receiptMedian(ratios) - 1) * 100,
    equalWorkChangePercent: (sum(pairs.map(({right}) => right)) / sum(pairs.map(({left}) => left)) - 1) * 100,
    worstPairChangePercent: (Math.max(...ratios) - 1) * 100,
    fasterPairs: ratios.filter((value) => value < 1).length,
    descriptiveBootstrap95Percent: [249, 9749].map((index) => (bootstrap[index] - 1) * 100),
  };
}


function parseCompleteImportLog(log) {
  const records = [];
  const parseErrors = [];
  const metadata = {criteriaSha256: [], provenance: []};
  const marker = "MANABITAN_QUALIFICATION_JSON ";
  for (const [index, line] of String(log).split("\n").entries()) {
    const output = line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "");
    if (output.startsWith(marker)) {
      try {
        const record = JSON.parse(output.slice(marker.length));
        if (!record || typeof record.kind !== "string" || !("value" in record)) throw new Error("Malformed record shape");
        records.push(record);
      } catch (error) { parseErrors.push({line: index + 1, message: String(error), text: line}); }
    }
    const criteria = line.match(/(?:^|\s)MANABITAN_PROSPECTIVE_CRITERIA_SHA256 ([a-f0-9]{64})\s*$/);
    if (criteria) metadata.criteriaSha256.push(criteria[1]);
    const provenance = line.match(/(?:^|\s)MANABITAN_PROSPECTIVE_PROVENANCE (\S+) ([a-f0-9]{64})\s*$/);
    if (provenance) metadata.provenance.push({name: provenance[1], sha256: provenance[2]});
  }
  return {records, parseErrors, metadata};
}


function auditCompleteImportCohort(parsed, expected) {
  const sourceRecords = Array.isArray(parsed) ? parsed : parsed.records;
  const records = sourceRecords.filter((row) => row && typeof row.kind === "string" && row.value !== null && typeof row.value === "object" && !Array.isArray(row.value));
  const errors = [];
  const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const closeNumber = (left, right, tolerance = 1e-9) => finiteNumber(left) && finiteNumber(right) && Math.abs(left - right) <= tolerance;
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(records.length === sourceRecords.length, "Malformed or null top-level receipt values");
  const one = (kind) => {
    const matches = records.filter((row) => row.kind === kind);
    check(matches.length === 1, kind + ": expected exactly one record");
    return matches[0]?.value ?? {};
  };
  const normalize = (value) => Array.isArray(value) ? value.map(normalize) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
  const equal = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  check(!records.some((row) => row.kind === "read-error"), "Original evidence extraction reported a JSON read error");
  const cohort = one("cohort");
  const plan = one("registered-plan");
  const browser = one("browser-identity");
  const packageDiff = one("package-diff");
  const extraction = one("extraction-complete");
  const baseline = expected.baseline;
  const candidate = expected.candidate;
  check(Array.isArray(parsed) || parsed.parseErrors.length === 0, "Malformed tagged JSON in original job log");
  check(cohort.baseline === baseline && plan.baseline === baseline, "Unexpected baseline SHA");
  check(cohort.candidate === candidate && plan.candidate === candidate, "Unexpected candidate SHA");
  check(cohort.workflowCommit === expected.workflowCommit, "Unexpected workflow SHA");
  check(cohort.workflowSha256 === expected.workflowSha256, "Unexpected workflow content hash");
  check(String(cohort.runId) === String(expected.runId) && cohort.attempt === "1", "Unexpected run or replay attempt");
  check(cohort.observerSha256 === expected.observerSha256, "Unexpected observer source hash");
  check(browser.version === expected.browser.version && browser.sha256 === expected.browser.sha256, "Pinned Chromium differs");
  check(equal(cohort.fixture, expected.fixtures[cohort.dictionary]), "Locked corpus identity differs");
  check(cohort.logExtractionPolicy === "Read-only after acquisition; every raw report discovered, no timing or semantic replacements", "Log extraction policy differs");
  if (expected.requireProvenance) {
    const metadata = parsed.metadata || {};
    check(equal(metadata.criteriaSha256, [expected.criteriaSha256]), "Prospective criteria receipt differs or is absent");
    for (const [name, sha256] of Object.entries(expected.provenanceHashes || {})) {
      check(equal((metadata.provenance || []).filter((item) => item.name === name).map((item) => item.sha256), [sha256]), "Prospective provenance receipt differs: " + name);
    }
  }
  check(cohort.expectedObservationCount === 42, "Expected observation count was not frozen at 42");
  check(cohort.fixtureLockSha256 === expected.fixtureLockSha256, "Unexpected fixture lock");
  check(equal(packageDiff.changedPackageEntries, expected.packageEntries) && equal(plan.expectedPackageEntries, expected.packageEntries), "Unexpected packaged differences or package gate");
  check(plan.expectedWorkers === null && plan.sourceBoundary === "Each revision built independently before timing; no product or harness overlays", "Production source or worker policy differs");
  check(plan.pairs === 12 && equal(plan.flags, {}), "Unexpected pair count or requested flags");
  check(["AB", "BA"].includes(cohort.order) && plan.initialOrder === cohort.order, "Unexpected initial order");
  check(plan.dictionary === cohort.dictionary, "Dictionary differs in plan");
  if (cohort.dictionary === "vndb") check(equal(plan.vndbSahAllocationPolicy?.rangeUnits, [37, 37]), "VNDB allocation gate changed");
  const identities = Object.fromEntries(records.filter((row) => row.kind === "source-identity").map((row) => [row.value.arm, row.value]));
  check(identities.A?.sha === baseline && identities.B?.sha === candidate, "Unexpected package source identities");
  check(records.filter((row) => row.kind === "source-identity").length === 2, "Expected exactly two source identity records");
  for (const arm of ["A", "B"]) {
    const identity = identities[arm] || {};
    check(identity.tree === expected.sourceTrees[arm], arm + ": source tree differs");
    check(identity.lockSha256 === expected.lockSha256 && identity.fixtureLockSha256 === expected.fixtureLockSha256, arm + ": dependency or fixture lock differs");
    check(identity.packageEntryCount === expected.packageEntryCount, arm + ": package entry count differs");
    check(equal(identity.changedPackageEntryHashes, expected.packageHashes[arm]), arm + ": source-bound packaged native bytes differ");
    for (const [path, hash] of Object.entries(expected.sourceHashes || {})) check(identity.sourceHashes?.[path] === hash, arm + ": frozen harness identity differs: " + path);
    check(identity.sourceHashes?.["builds/manabitan-chrome.zip"] === identity.packageSha256 && identity.sourceHashes?.["builds/manabitan-chrome-dev.zip"] === null, arm + ": release package source receipt differs");
  }
  const expectedSchedule = [];
  const first = cohort.order || "AB";
  const reverse = [...first].reverse().join("");
  for (const [index, order] of [first, reverse].entries()) {
    for (const arm of order) expectedSchedule.push({id: "warmup-" + (index + 1) + "-" + arm, kind: "warmup", pair: index + 1, arm});
  }
  for (let pair = 1; pair <= 12; pair++) {
    for (const arm of pair % 2 ? first : reverse) expectedSchedule.push({id: "pair-" + String(pair).padStart(2, "0") + "-" + arm, kind: "candidate", pair, arm});
    if (pair % 3 === 0) {
      const control = pair / 3;
      for (const arm of (control + (first === "BA")) % 2 ? "AC" : "CA") expectedSchedule.push({id: "control-" + String(control).padStart(2, "0") + "-" + arm, kind: "control", pair: control, arm});
    }
  }
  check(equal(plan.schedule, expectedSchedule), "Registered timing schedule differs from independent reconstruction");
  const expectedRoles = {};
  expectedSchedule.forEach((row, index) => { expectedRoles[row.id] = {...row, position: index + 1, authoritativeCohort: row.kind === "candidate"}; });
  [...first].forEach((arm, index) => { expectedRoles["exhaustive-media-" + arm] = {kind: "exhaustive-media", arm, position: index + 1, authoritativeCohort: false}; });
  const counts = {A: 0, B: 0};
  const expectedMemory = [...(first === "AB" ? "ABBA" : "BAAB")].map((arm, index) => ({index: index + 1, arm, name: arm + (++counts[arm]), pair: Math.floor(index / 2) + 1}));
  check(equal(plan.memorySchedule, expectedMemory), "Memory schedule differs");
  for (const row of expectedMemory) expectedRoles["memory/" + row.name] = {...row, kind: "memory", authoritativeCohort: false};
  const observations = records.filter((row) => row.kind === "observation").map((row) => row.value);
  const ids = observations.map((row) => row.id);
  check(observations.length === 42 && new Set(ids).size === 42, "Expected 42 unique raw observations");
  check(equal([...ids].sort(), Object.keys(expectedRoles).sort()), "Observed IDs differ from the frozen full schedule");
  check(extraction.rawReportCount === 42 && extraction.attemptedObservationCount === 42 && extraction.plannedObservationCount === 42, "Extraction counts differ");
  check(extraction.analysisPresent === true && equal(extraction.unattemptedPlannedIds, []), "Cohort did not complete every planned observation");
  let referenceCommon = null;
  let referenceLookup = null;
  let referenceFixture = null;
  let referenceStorageBytes = null;
  let memoryHarnessHash = null;
  const mediaByMode = {};
  const rawTimes = [];
  for (const row of observations) {
    const label = row.id;
    const role = expectedRoles[label];
    check(!!role, label + ": unknown observation");
    if (!role) continue;
    check(equal(row.role, role), label + ": logged role differs");
    const sourceArm = role.arm === "B" ? "B" : "A";
    const identity = identities[sourceArm] || {};
    const report = row.report || {};
    const summary = row.summary || {};
    const run = row.run || {};
    const benchmark = row.benchmark || {};
    check(report.status === "success" && report.skippedVerification === false, label + ": raw report not a verified success");
    check(report.browserFlavor === "chromium" && report.launchMode === "headless" && report.buildTarget === "chrome", label + ": wrong runtime or package target");
    check(report.browserVersion === browser.version && summary.browserVersion === browser.version && run.browserVersion === browser.version, label + ": browser identity mismatch");
    check(report.packageSha256 === identity.packageSha256 && run.packageSha256 === identity.packageSha256, label + ": package identity mismatch");
    check(summary.gitSha === identity.sha && summary.source?.gitSha === identity.sha, label + ": source revision mismatch");
    check(summary.source?.dirty === (role.kind === "memory"), label + ": unexpected source dirty state");
    for (const [path, expectedSourceHash] of Object.entries(identity.sourceHashes || {})) {
      const actual = summary.source?.sha256?.[path];
      if (role.kind === "memory" && path === "test/chromium/extension-two-dictionary-import.e2e.js") {
        if (memoryHarnessHash === null) memoryHarnessHash = actual;
        check(typeof actual === "string" && actual === memoryHarnessHash && actual === expected.memoryHarnessSha256, label + ": memory harness hashes differ");
      } else check(actual === expectedSourceHash, label + ": source hash differs for " + path);
    }
    check(row.host?.nodeVersion === expected.nodeVersion && row.rawHost?.nodeVersion === expected.nodeVersion, label + ": Node runtime mismatch");
    check(["run-1.json", "summary.json", "canonical-receipt.json"].every((name) => /^[a-f0-9]{64}$/.test(row.fileSha256?.[name] || "")), label + ": original file hash missing");
    check(benchmark.dictionary === cohort.dictionary && benchmark.pinnedDictionaries === true && benchmark.productionImportDefaults === true, label + ": production fixture/default policy differs");
    check(benchmark.traceEnabled === false && benchmark.authoritativeTiming === true && benchmark.phaseProfiling === false && benchmark.phaseScreenshots === false && benchmark.processSampling === false, label + ": timed harness instrumentation differs");
    check(benchmark.importFlags === null && summary.importFlags === null && equal(row.requestedFlags, {}), label + ": import flags differ");
    const mediaMode = role.kind === "exhaustive-media" ? "all" : "sample";
    check(benchmark.mediaCheck === mediaMode && summary.mediaCheck === mediaMode, label + ": media coverage differs");
    check(summary.schemaVersion === 3 && summary.authoritativeTiming === true && summary.traceEnabled === false && summary.dictionary === cohort.dictionary && summary.buildTarget === "chrome" && row.runCount === 1 && run.index === 1 && run.tracePath === null, label + ": summary/run shape differs");
    check(summary.timingBoundary === "page file-input change event to post-UI import-complete event; browser monotonic clock", label + ": timing boundary differs");
    check(row.rawValidationSha256 === row.summaryValidationSha256 && /^[a-f0-9]{64}$/.test(row.rawValidationSha256 || ""), label + ": raw and summary validations differ");
    check(/^[a-f0-9]{64}$/.test(row.canonicalCommonSha256 || ""), label + ": canonical receipt missing");
    if (referenceCommon === null) referenceCommon = row.canonicalCommonSha256;
    check(row.canonicalCommonSha256 === referenceCommon, label + ": canonical semantics differ");
    if (referenceFixture === null) referenceFixture = row.fixtureSha256;
    check(row.fixtureSha256 === referenceFixture && row.fixtureSha256 === expected.summaryFixtureHashes[cohort.dictionary], label + ": fixture identity differs");
    const validation = row.validation || {};
    check(validation.termRows === cohort.fixture?.termRows && validation.title === cohort.fixture?.expectedTitle && validation.revision === cohort.fixture?.revision && validation.contentReadable === true && validation.probeCount === 12 && validation.probeTerms?.length === 12, label + ": persisted content coverage differs");
    check(validation.restart?.title === cohort.fixture?.expectedTitle && validation.restart?.revision === cohort.fixture?.revision && validation.restart?.termRows === cohort.fixture?.termRows && validation.restart?.contentReadable === true && validation.restart?.probeCount === 12 && validation.restart?.mediaFiles === cohort.fixture?.mediaFiles, label + ": restart coverage differs");
    check(validation.lookup?.observationCount === 72 && validation.lookup?.distinctPassTerms === 72 && validation.lookup?.allExactHeadwordMatches === true, label + ": lookup coverage differs");
    check(Array.isArray(validation.probeTerms) && validation.probeTerms.length === 12 && new Set(validation.probeTerms).size === 12 && validation.probeTerms.every((term) => typeof term === "string" && term.length > 0), label + ": persisted probe terms are invalid or duplicated");
    check(Array.isArray(validation.lookup?.passes) && validation.lookup.passes.length === 6 && validation.lookup.passes.every((pass, index) => pass.pass === index && pass.count === 12 && pass.elapsedCount === 12 && [pass.totalMs, pass.medianMs, pass.maxMs].every((value) => finiteNumber(value) && value >= 0)), label + ": lookup pass inventory differs");
    if (referenceLookup === null) referenceLookup = validation.lookup?.semanticSha256;
    check(validation.lookup?.semanticSha256 === referenceLookup && /^[a-f0-9]{64}$/.test(referenceLookup || ""), label + ": lookup semantics differ");
    const files = validation.storage?.files || [];
    check(files.every((file) => Number.isSafeInteger(file.bytes) && file.bytes >= 0), label + ": invalid OPFS sizes");
    const bytes = files.reduce((total, file) => total + file.bytes, 0);
    check(bytes === validation.storage?.bytes, label + ": OPFS total differs from file inventory");
    if (referenceStorageBytes === null) referenceStorageBytes = bytes;
    check(bytes === referenceStorageBytes && bytes === expected.storageBytes[cohort.dictionary], label + ": total persistent storage differs");
    check(new Set(files.map((file) => file.path)).size === files.length && files.every((file) => typeof file.path === "string" && file.path.length > 0), label + ": duplicate or invalid OPFS paths");
    const sah = files.filter((file) => file.path.startsWith("manabitan/sqlite-sahpool-v1/.opaque/"));
    check(sah.length === 8 && sah.filter((file) => file.bytes === 4096).length === 7, label + ": SAH pool layout differs");
    if (cohort.dictionary === "vndb") check(sah.filter((file) => file.bytes !== 4096).every((file) => file.bytes === 37 * 4096), label + ": VNDB active SAH allocation differs");
    const expectedMediaCount = mediaMode === "all" ? cohort.fixture?.mediaFiles : Math.min(64, cohort.fixture?.mediaFiles);
    check(validation.media?.mode === mediaMode && validation.media?.totalFiles === cohort.fixture?.mediaFiles && validation.media?.files === expectedMediaCount && validation.media?.totalBytes === cohort.fixture?.mediaBytes, label + ": media counts differ");
    check(equal(row.canonicalMedia, validation.media), label + ": complete media receipt differs");
    check(Number.isSafeInteger(validation.media?.bytes) && validation.media.bytes >= 0 && validation.media.bytes <= cohort.fixture?.mediaBytes && /^[a-f0-9]{64}$/.test(validation.media?.sha256 || ""), label + ": invalid checked media bytes or digest");
    if (mediaMode === "all") check(validation.media?.bytes === cohort.fixture?.mediaBytes, label + ": exhaustive media bytes differ");
    if (!(mediaMode in mediaByMode)) mediaByMode[mediaMode] = row.canonicalMedia;
    check(equal(row.canonicalMedia, mediaByMode[mediaMode]), label + ": media semantics differ across observations");
    const phase = (row.rawPhases || []).filter((item) => item.name === cohort.fixture?.label + ": total import");
    const trigger = (row.rawPhases || []).filter((item) => item.name === "Import " + cohort.fixture?.label + " via file input");
    check(phase.length === 1 && trigger.length === 1, label + ": raw import/trigger phases missing or repeated");
    if (phase.length !== 1 || trigger.length !== 1) continue;
    const timing = phase[0].browserTiming || {};
    check([timing.startedAtMs, timing.completedAtMs, run.totalImportMs, run.automationObservedImportMs, phase[0].startMs, phase[0].endMs, phase[0].durationMs, trigger[0].startMs, trigger[0].endMs, trigger[0].durationMs].every(finiteNumber), label + ": browser or automation timing is not numeric and finite");
    check([timing.startedAtMs, timing.completedAtMs, phase[0].startMs, phase[0].endMs, trigger[0].startMs, trigger[0].endMs].every((value) => finiteNumber(value) && value >= 0), label + ": negative or invalid timestamp");
    const actual = timing.completedAtMs - timing.startedAtMs;
    check(summary.timing?.count === 1 && ["minMs", "maxMs", "medianMs", "p95Ms"].every((name) => closeNumber(summary.timing?.[name], actual, 0.001)), label + ": single-run timing summary differs");
    check(Number.isFinite(actual) && actual > 0 && Math.abs(actual - run.totalImportMs) <= 0.001, label + ": raw monotonic duration differs from summary");
    check(timing.trigger === "file-input-change" && timing.errorCount === 0 && Number.isSafeInteger(timing.sequence) && Number.isSafeInteger(timing.sequenceBefore) && timing.sequenceBefore >= 0 && timing.sequence > timing.sequenceBefore, label + ": stale or failed browser completion");
    check(trigger[0].endMs >= trigger[0].startMs && phase[0].endMs >= phase[0].startMs && closeNumber(trigger[0].durationMs, trigger[0].endMs - trigger[0].startMs, 0.001), label + ": reversed or inconsistent automation phase");
    check(phase[0].startMs === trigger[0].startMs && trigger[0].endMs <= phase[0].endMs && Math.abs(phase[0].durationMs - (phase[0].endMs - phase[0].startMs)) <= 0.001 && phase[0].durationMs === run.automationObservedImportMs, label + ": automation boundary differs");
    check(phase[0].importDebug?.hasResult === true && phase[0].importDebug?.resultTitle === cohort.fixture?.expectedTitle && phase[0].importDebug?.errorCount === 0 && phase[0].importDebug?.addSettingsErrorCount === 0 && phase[0].importDebug?.usesFallbackStorage === false, label + ": import completion/fallback differs");
    rawTimes.push({id: label, ...role, rawMonotonicImportMs: actual, reportedImportMs: run.totalImportMs});
  }
  const pairsFor = (kind, left, right) => {
    const groups = new Map();
    for (const row of rawTimes.filter((value) => value.kind === kind)) {
      if (!groups.has(row.pair)) groups.set(row.pair, {});
      groups.get(row.pair)[row.arm] = row.rawMonotonicImportMs;
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).filter(([, values]) => Number.isFinite(values[left]) && Number.isFinite(values[right])).map(([pair, values]) => ({pair, left: values[left], right: values[right]}));
  };
  const candidatePairs = pairsFor("candidate", "A", "B");
  const controlPairs = pairsFor("control", "A", "C");
  check(candidatePairs.length === 12 && controlPairs.length === 4, "Incomplete candidate/control timing pairs");
  const candidateStats = candidatePairs.length === 12 ? receiptPairedStatistics(candidatePairs) : null;
  const controlStats = controlPairs.length === 4 ? receiptPairedStatistics(controlPairs) : null;
  const resultRecords = records.filter((row) => row.kind === "result-file");
  check(new Set(resultRecords.map((row) => row.value.path)).size === resultRecords.length, "Duplicate result-file records");
  check(resultRecords.every((row) => /^[a-f0-9]{64}$/.test(row.value.sha256 || "")), "Original result-file hash missing");
  const resultFiles = Object.fromEntries(resultRecords.map((row) => [row.value.path, row.value.value]));
  const requiredResults = ["observations.json", "analysis.json", "memory/observations.json", "memory/memory-comparison.json", "memory/memory-audit.json", "memory/semantic-failures.json"];
  for (const path of requiredResults) check(Object.prototype.hasOwnProperty.call(resultFiles, path), "Missing original result-file: " + path);
  check(!("memory/memory-audit-failure.json" in resultFiles), "Original raw-scan memory audit failed");
  const timingObservations = resultFiles["observations.json"];
  check(Array.isArray(timingObservations) && timingObservations.length === 36, "Original timing observation list is incomplete");
  if (Array.isArray(timingObservations)) {
    const rawById = new Map(rawTimes.map((row) => [row.id, row]));
    for (const [index, row] of timingObservations.entries()) {
      const expectedRole = expectedSchedule[index];
      check(!!expectedRole && equal({arm: row.arm, id: row.id, kind: row.kind, pair: row.pair}, expectedRole), "Original timing observation order/role differs at " + index);
      check(closeNumber(row.totalImportMs, rawById.get(row.id)?.rawMonotonicImportMs, 0.001), "Original timing list differs from raw endpoints: " + row.id);
    }
  }
  const analysis = resultFiles["analysis.json"];
  check(analysis?.status === "correctness-memory-passed" && analysis?.memoryPassed === true, "Original correctness/memory gate did not pass");
  for (const [recomputed, original, label] of [[candidateStats, analysis?.candidateVsBaseline, "candidate"], [controlStats, analysis?.identicalCodeControl, "control"]]) {
    check(!!original && typeof original === "object", label + ": missing original paired statistics");
    if (!recomputed || !original) continue;
    check(Array.isArray(original.ratios) && original.ratios.length === recomputed.ratios.length && original.ratios.every((value, index) => closeNumber(value, recomputed.ratios[index])), label + ": original pair ratios differ");
    for (const key of ["count", "fasterPairs", "medianPairedChangePercent", "equalWorkChangePercent", "worstPairChangePercent"]) check(closeNumber(recomputed[key], original[key]), label + ": recomputed " + key + " differs");
    check(Array.isArray(original.descriptiveBootstrap95Percent) && original.descriptiveBootstrap95Percent.length === 2 && recomputed.descriptiveBootstrap95Percent.every((value, index) => closeNumber(value, original.descriptiveBootstrap95Percent[index])), label + ": recomputed bootstrap differs");
  }
  const memory = resultFiles["memory/memory-comparison.json"];
  const audit = resultFiles["memory/memory-audit.json"];
  check(memory?.everyObservationQualified === true && memory?.passesProspectiveMemoryScreen === true && audit?.everyObservationQualified === true && audit?.passesProspectiveMemoryScreen === true, "Separate memory observations/audit did not qualify");
  check(equal(resultFiles["memory/semantic-failures.json"], []), "Memory semantic checks failed or absent");
  const memoryObservations = resultFiles["memory/observations.json"];
  check(Array.isArray(memoryObservations) && memoryObservations.length === 4, "Four separate memory observation summaries are required");
  let recomputedMemoryMetrics = null;
  let recomputedMemoryPass = false;
  if (Array.isArray(memoryObservations) && memoryObservations.length === 4) {
    check(equal(memory?.observations, memoryObservations), "Memory comparison observation inventory differs");
    check(memory?.dictionary === cohort.dictionary && memory?.replication === (first === "AB" ? 1 : 2) && memory?.authoritativeTiming === false && memory?.schemaVersion === 1, "Memory comparison source/scope differs");
    for (const [index, row] of memoryObservations.entries()) {
      check(equal({index: row.index, arm: row.arm, name: row.name, pair: row.pair}, expectedMemory[index]), "Separate memory observation role/order differs");
      check(row.schemaVersion === 3 && row.authoritativeTiming === false && row.benchmarkExitCode === 0 && row.observerRule === "import-window-stable-single-thread-zombie-esrch-v1", row.name + ": memory observer identity/status differs");
      check(row.qualifiedForWholeTreePss === true && equal(row.qualificationFailures, []), row.name + ": memory coverage did not qualify");
      check(row.stableFullyReadImportSampleCount >= 5 && ["preImportBracketGapMs", "postImportBracketGapMs", "maximumCoveredSampleGapMs"].every((name) => finiteNumber(row[name]) && row[name] >= 0 && row[name] <= 250), row.name + ": emitted prospective memory coverage is insufficient");
      const markers = row.windowMarkers;
      const validMarkers = Array.isArray(markers) && markers.length === 2 && markers[0].event === "start" && markers[1].event === "end" && markers.every((item) => typeof item.monotonicNs === "string" && /^[0-9]+$/.test(item.monotonicNs));
      check(validMarkers, row.name + ": memory window markers invalid");
      if (validMarkers) {
        const duration = Number(BigInt(markers[1].monotonicNs) - BigInt(markers[0].monotonicNs)) / 1e6;
        check(duration > 0 && closeNumber(duration, row.windowDurationMs), row.name + ": memory window duration differs");
      }
    }
    const allQualified = memoryObservations.every((row) => row.qualifiedForWholeTreePss === true);
    const memoryPairs = [];
    for (const pair of [1, 2]) {
      const rows = memoryObservations.filter((row) => row.pair === pair);
      const A = rows.find((row) => row.arm === "A"), B = rows.find((row) => row.arm === "B");
      if (!A || !B || rows.length !== 2) { check(false, "Separate memory pair is incomplete"); continue; }
      const qualified = A.qualifiedForWholeTreePss === true && B.qualifiedForWholeTreePss === true;
      const value = {pair, qualified};
      for (const name of ["maxSampledPssKiB", "maxSampledPrivateKiB"]) {
        check(!qualified || (finiteNumber(A[name]) && A[name] > 0 && finiteNumber(B[name]) && B[name] >= 0), "Invalid qualified memory maxima: " + name);
        value[name] = {baseline: A[name], candidate: B[name], changePercent: qualified ? 100 * (B[name] / A[name] - 1) : null};
      }
      memoryPairs.push(value);
    }
    check(equal(memory?.pairs, memoryPairs), "Memory pair arithmetic differs from the four observation summaries");
    recomputedMemoryMetrics = {};
    for (const name of ["maxSampledPssKiB", "maxSampledPrivateKiB"]) {
      const changes = memoryPairs.map((row) => row[name].changePercent);
      recomputedMemoryMetrics[name] = {medianPairedChangePercent: allQualified && changes.length === 2 ? receiptMedian(changes) : null, maximumPairedChangePercent: allQualified && changes.length === 2 ? Math.max(...changes) : null};
    }
    recomputedMemoryPass = allQualified && memoryPairs.length === 2 && Object.values(recomputedMemoryMetrics).every((row) => finiteNumber(row.medianPairedChangePercent) && row.medianPairedChangePercent <= 5 && finiteNumber(row.maximumPairedChangePercent) && row.maximumPairedChangePercent <= 10);
    check(equal(memory?.metrics, recomputedMemoryMetrics) && equal(audit?.metrics, recomputedMemoryMetrics), "Memory comparison/audit metric summaries differ");
    check(memory?.everyObservationQualified === allQualified && audit?.everyObservationQualified === allQualified && memory?.passesProspectiveMemoryScreen === recomputedMemoryPass && audit?.passesProspectiveMemoryScreen === recomputedMemoryPass, "Memory summary gate booleans differ from observation arithmetic");
    check(audit?.observations === 4 && audit?.rawScanCount === memoryObservations.reduce((sum, row) => sum + row.allObservedSampleCount, 0), "Memory raw-scan audit inventory differs");
  }
  return {
    dictionary: cohort.dictionary, order: cohort.order, errors, allChecksPass: errors.length === 0,
    cohort, browser, sourceIdentities: identities,
    originalCorrectnessMemoryStatus: {status: analysis?.status, memoryPassed: analysis?.memoryPassed},
    observations: observations.length, rawTimes, candidateVsBaseline: candidateStats, identicalCodeControl: controlStats,
    storageBytes: referenceStorageBytes, lookupSemanticSha256: referenceLookup,
    memoryMetrics: memory?.metrics, memoryAudit: audit, recomputedMemoryMetrics, recomputedMemoryPass,
    memoryAuditScope: "Four emitted observation summaries, coverage bounds and paired metric arithmetic independently checked. Per-process raw scan reconstruction remains the unchanged CI audit; originals retained in Actions artifacts.",
    mechanicalTargetThresholdPass: cohort.dictionary === expected.targetDictionary && candidateStats !== null && candidateStats.medianPairedChangePercent <= -expected.targetMinimumReductionPercent && candidateStats.fasterPairs >= expected.minimumFasterPairs && candidateStats.descriptiveBootstrap95Percent[1] < 0,
    mechanicalNonTargetHoldSignal: cohort.dictionary !== expected.targetDictionary && candidateStats !== null && candidateStats.medianPairedChangePercent >= expected.nonTargetMinimumSlowdownPercent && candidateStats.ratios.filter((ratio) => ratio > 1).length >= expected.minimumSlowerPairs && candidateStats.descriptiveBootstrap95Percent[0] > 0,
    identicalCodeChangePercentRange: controlStats ? [Math.min(...controlStats.ratios), Math.max(...controlStats.ratios)].map((ratio) => 100 * (ratio - 1)) : null,
    promotionDecision: "No per-host automatic promotion; requires both independent hosts, controls review, all gates, and non-target review under frozen prospective criteria.",
    controlInterpretation: "Materially smaller identical-code variation requires explicit review; no control subtraction or host pooling.",
  };
}
