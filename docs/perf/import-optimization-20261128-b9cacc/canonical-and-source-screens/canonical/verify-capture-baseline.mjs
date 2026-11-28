// Independent semantic audit only. One baseline native call, no clocks or candidate load.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ownPath = fileURLToPath(import.meta.url);
const [registrationPath, registrationSha256, manifestPath, manifestSha256, indexText] = process.argv.slice(2);
const report = {
    schemaVersion: 1, status: 'failed',
    scope: 'Independent untimed baseline-only semantic verification; no candidate load, clocks, replay registration, or performance observation',
    helperSha256: sha256(readFileSync(ownPath)),
    nodeVersion: process.version, nodeExecutable: realpathSync(process.execPath), nativeCalls: 0,
};
try {
    const registrationBytes = readFileSync(registrationPath);
    assert.equal(sha256(registrationBytes), registrationSha256);
    const registration = JSON.parse(registrationBytes);
    assert.equal(registration.baseline.commit, '9e10d3b3fcf66d344ab31bc42c9b522fa5215da2');
    assert.equal(registration.baseline.wasmSha256, '40948d5c20d26253e86c93d267e3cbb3817ea87c9731e02bcca0523c0eb3d6af');
    assert.equal(process.version, 'v22.22.0');
    assert.equal(process.version, registration.nodeVersion);
    assert.equal(realpathSync(registration.nodeExecutable), report.nodeExecutable);
    assert.equal(registration.limits.maxArenaBytes, 67108864);
    const manifestBytes = readFileSync(manifestPath);
    assert.equal(sha256(manifestBytes), manifestSha256);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.registrationSha256, registrationSha256);
    assert.equal(manifest.status, 'qualified-source-derived-component');
    assert.equal(manifest.captures.length, 12);
    assert(/^(?:[0-9]|1[01])$/.test(indexText));
    const index = Number(indexText);
    const capture = manifest.captures[index];
    assert.equal(capture.index, index);
    assert.equal(capture.group, index);
    assert.equal(capture.file, 'native-' + String(index).padStart(3, '0') + '.bin.gz');
    assert.equal(capture.expectedReturn, 0);
    assert(Number.isSafeInteger(capture.memoryBytes) && capture.memoryBytes >= 8388608);
    assert(capture.memoryBytes <= registration.limits.maxArenaBytes && capture.memoryBytes % 65536 === 0);
    const inputPath = path.join(path.dirname(manifestPath), capture.file);
    const root = realpathSync(registration.temporaryRoot) + path.sep;
    assert(realpathSync(inputPath).startsWith(root));
    const compressed = readFileSync(inputPath);
    assert.equal(compressed.byteLength, capture.compressedBytes);
    assert.equal(sha256(compressed), capture.compressedSha256);
    const input = gunzipSync(compressed, {maxOutputLength: registration.limits.maxArenaBytes});
    assert.equal(input.byteLength, capture.memoryBytes);
    assert.equal(sha256(input), capture.inputSha256);
    const config = Array.from({length: 22}, (_, i) => input.readUInt32LE(1088 + 4 * i));
    assert.deepEqual(config, capture.config);
    const baselinePath = path.join(registration.baseline.path, 'dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm');
    const baseline = readFileSync(baselinePath);
    assert.equal(sha256(baseline), registration.baseline.wasmSha256);
    const module = new WebAssembly.Module(baseline);
    assert.deepEqual(WebAssembly.Module.imports(module), [{module: 'env', name: 'memory', kind: 'memory'}]);
    const pages = input.byteLength / 65536;
    const memory = new WebAssembly.Memory({initial: pages, maximum: pages});
    const instance = new WebAssembly.Instance(module, {env: {memory}});
    assert.equal(typeof instance.exports.scan_canonical, 'function');
    new Uint8Array(memory.buffer).set(input);
    ++report.nativeCalls;
    const returned = instance.exports.scan_canonical();
    const bytes = new Uint8Array(memory.buffer);
    const outputSha256 = createHash('sha256').update(bytes.subarray(1024, 1052))
        .update(bytes.subarray(1088, 1176)).update(bytes.subarray(131072)).digest('hex');
    const header = [...new Uint32Array(memory.buffer, 1024, 7)];
    Object.assign(report, {registrationSha256, manifestSha256, captureIndex: index,
        baselineWasmSha256: sha256(baseline), memoryBytes: input.byteLength,
        compressedSha256: sha256(compressed), inputSha256: sha256(input),
        returned, header, outputSha256, expectedOutputSha256: capture.outputSha256,
        semanticRanges: [[1024, 1052], [1088, 1176], [131072, input.byteLength]]});
    assert.equal(returned, capture.expectedReturn);
    assert.deepEqual(header, capture.header);
    assert.equal(outputSha256, capture.outputSha256);
    assert.equal(sha256(readFileSync(inputPath)), capture.compressedSha256, 'Capture remains untouched');
    assert.equal(sha256(readFileSync(manifestPath)), manifestSha256, 'Manifest remains untouched');
    assert.equal(sha256(readFileSync(baselinePath)), registration.baseline.wasmSha256, 'Baseline remains untouched');
    report.status = 'passed';
} catch (error) {
    report.failure = {name: error?.name ?? 'Error', message: String(error?.message ?? error)};
    process.exitCode = 1;
}
report.processPeakRssBytes = process.resourceUsage().maxRSS * 1024;
process.stdout.write(JSON.stringify(report) + '\n');
