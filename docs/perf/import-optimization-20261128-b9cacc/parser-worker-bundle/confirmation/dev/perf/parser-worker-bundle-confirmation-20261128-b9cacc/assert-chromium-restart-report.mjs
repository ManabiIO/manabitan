import fs from 'node:fs';
const path = `${process.env.MANABITAN_RESTART_EVIDENCE_DIR}/restart-interruption-campaign.json`;
if (!fs.existsSync(path)) {
  console.error('Restart interruption report was not written.');
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const phases = new Map((report.phases || []).map((phase) => [phase.name, phase]));
const boundary = phases.get('controlled authoritative term-container payload interruption boundary');
const kill = phases.get('SIGKILL active Chromium process tree after successful authoritative term-container payload write before publication (test-only gate)');
const oracle = phases.get('restart recovery all-or-nothing generation oracle');
const largeUpdate = phases.get('completed full large update publication oracle');
const processCapture = phases.get('captured owned Chromium process tree before SIGKILL');
const required = [
  phases.get('completed import baseline')?.status === 'passed',
  phases.get('captured owned Chromium process tree before SIGKILL')?.status === 'observed',
  boundary?.status === 'observed',
  kill?.status === 'passed',
  oracle?.status === 'passed',
  largeUpdate?.status === 'passed',
];
const write = boundary?.observedWrite;
const sessionId = boundary?.journal?.sessionId;
const fixtureTitle = 'Restart Campaign Fixture';
const stagedTitle = typeof write?.dictionaryName === 'string' &&
  write.dictionaryName.startsWith(`${fixtureTitle} [update-staging `) && write.dictionaryName.endsWith(']');
const boundaryWitness = boundary?.journal?.recordCheckpoint?.shards &&
  typeof sessionId === 'string' && sessionId.length > 0 && write?.held === true &&
  write.sessionId === sessionId && typeof write.fileName === 'string' && write.fileName.endsWith('.mbtr.mbti') &&
  typeof write.descriptorFileName === 'string' && write.descriptorFileName === write.fileName.slice(0, -'.mbti'.length) && write.descriptorFileName.endsWith('.mbtr') &&
  (write.dictionaryName === fixtureTitle || stagedTitle) && Number.isSafeInteger(write.bytes) && Number.isSafeInteger(write.recordCount) && write.recordCount > 0 &&
  write.bytes > 4096 && boundary.checkpointEntry === null &&
  boundary.preUpdateFilesAbsent === true &&
  !boundary.journal.recordCheckpoint.shards.some(({fileName}) => fileName === write.fileName || fileName === write.descriptorFileName) &&
  Array.isArray(kill?.exitedPids) && Array.isArray(processCapture?.processes) &&
  processCapture.processes.every(({pid}) => kill.exitedPids.includes(pid)) &&
  Array.isArray(processCapture?.processes) && processCapture.processes.some(({pid, startedAt, command}) =>
    pid === kill?.rootPid && typeof startedAt === 'string' && startedAt.length > 0 &&
    typeof command === 'string' && command.includes('--user-data-dir=') &&
    !/--type=|crashpad_handler/u.test(command)) &&
  Array.isArray(kill?.signalledPids) && kill.signalledPids.includes(kill.rootPid) &&
  Array.isArray(kill?.exitedPids) && kill.exitedPids.includes(kill.rootPid);
const launches = Array.isArray(report.launches) ? report.launches : [];
const validLaunches = ['initial', 'recovery'].every((name) => {
  const launch = launches.find((item) => item.name === name);
  const diagnostics = launch?.diagnostics;
  const storage = diagnostics?.openStorageDiagnostics;
  const worker = storage?.runtimeContext;
  return launch?.runtimeIdentity?.origin === `chrome-extension://${report.runtimeExtensionId}` &&
    launch.runtimeIdentity.runtimeId === report.runtimeExtensionId &&
    launch.serviceWorkerExtensionId === report.runtimeExtensionId && diagnostics?.usesFallbackStorage === false &&
    storage?.mode === 'opfs-sahpool' && storage.hasOpfsSahpoolVfs === true &&
    storage.opfsSahpoolInstallResult === 'installed' && worker?.isDedicatedWorkerGlobalScope === true &&
    worker.hasStorageGetDirectory === true && worker.hasCreateSyncAccessHandle === true;
});
const oracleWitness = oracle?.revision && typeof oracle.generationId === 'string' &&
  Number.isSafeInteger(oracle.inventory?.terms) && oracle.inventory.terms > 0 &&
  typeof oracle.exactExpression === 'string' && typeof oracle.exactContent === 'string' &&
  typeof oracle.absentExpression === 'string' && oracle.missCount === 0 && oracle.noTransientRows === true &&
  oracle.strictOpfs === true;
const largeUpdateWitness = largeUpdate?.revision === 'revision-two-c92a' &&
  typeof largeUpdate.previousGenerationId === 'string' && largeUpdate.previousGenerationId === oracle?.generationId &&
  typeof largeUpdate.generationId === 'string' && largeUpdate.generationId !== largeUpdate.previousGenerationId &&
  largeUpdate.inventory?.terms === 350001 && largeUpdate.exactExpression === '再起動証拠新' &&
  largeUpdate.exactContent === 'RESTART_CAMPAIGN_REVISION_TWO_CONTENT_C92A' &&
  largeUpdate.absentExpression === '再起動証拠旧' && largeUpdate.missCount === 0 &&
  largeUpdate.noTransientRows === true && largeUpdate.strictOpfs === true;
const gitObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const identities = gitObjectId(report.sourceHead) && gitObjectId(report.sourceTree) &&
  sha256(report.packageSha256) && sha256(report.harnessSha256) &&
  sha256(report.fixtureHashes?.revisionOneSha256) && sha256(report.fixtureHashes?.revisionTwoSha256) &&
  sha256(report.testOnlyPackageObserver?.originalSha256) &&
  sha256(report.testOnlyPackageObserver?.instrumentedSha256) &&
  sha256(report.testOnlyPackageObserver?.originalPackageZipSha256) &&
  sha256(report.testOnlyPackageObserver?.instrumentedExtractedPackageTreeSha256) &&
  report.testOnlyPackageObserver?.originalPackageZipSha256 === report.packageSha256 &&
  typeof report.browserVersion === 'string' && report.browserVersion.length > 0;
if (report.status !== 'success' || required.some((passed) => !passed) || !boundaryWitness ||
    !validLaunches || !oracleWitness || !largeUpdateWitness || !identities || !report.runtimeExtensionId || !report.browserVersion ||
    report.nodeVersion !== 'v22.22.0') {
  console.error(JSON.stringify({status: report.status, requiredPhaseStatuses: required, boundaryWitness: Boolean(boundaryWitness),
    validLaunches, oracleWitness: Boolean(oracleWitness), largeUpdateWitness: Boolean(largeUpdateWitness), identities: Boolean(identities), runtimeExtensionId: report.runtimeExtensionId,
    browserVersion: report.browserVersion, nodeVersion: report.nodeVersion, sourceStatus: report.sourceStatus}, null, 2));
  process.exit(1);
}

// Additive immutable source/package identity; original recovery oracle above is unchanged.
if (report.sourceHead !== '9da7dedd17535b4a0f8edb97e56756049bbad7a7' ||
    report.sourceTree !== 'ee65e5a994b4017a443893dc7b0b268900538e94') {
  throw new Error('Restart campaign source differs from the frozen parser-bundle candidate');
}
const runtimeIdentityPath = process.env.MANABITAN_RESTART_RUNTIME_IDENTITY;
if (!runtimeIdentityPath) { throw new Error('Missing separately verified runtime package identity'); }
const runtimeIdentity = JSON.parse(fs.readFileSync(runtimeIdentityPath, 'utf8'));
if (runtimeIdentity.status !== 'passed' ||
    runtimeIdentity.sourceHead !== report.sourceHead ||
    runtimeIdentity.sourceTree !== report.sourceTree ||
    runtimeIdentity.package?.sha256 !== report.packageSha256 ||
    runtimeIdentity.sourceFileSha256?.['test/chromium/restart-interruption.e2e.js'] !== report.harnessSha256) {
  throw new Error('Restart campaign and independently recorded package/harness identities disagree');
}
console.log('Existing recovery oracle and frozen runtime/package/harness identity passed; this one-bank fixture does not establish parallel-parser cancellation.');
