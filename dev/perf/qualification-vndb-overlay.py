#!/usr/bin/env python3
"""Apply the same VNDB-only measurement overlay to either qualified source tree."""

import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()


def replace_once(path, old, new):
    source = (root / path).read_text()
    if source.count(old) != 1:
        raise RuntimeError(f"Expected one measurement overlay anchor in {path}: {old[:70]}")
    (root / path).write_text(source.replace(old, new, 1))


lock_path = root / "test/perf/dictionaries.lock.json"
lock = json.loads(lock_path.read_text())
if "vndb" in lock["dictionaries"]:
    raise RuntimeError("VNDB fixture already present")
lock["dictionaries"]["vndb"] = {
    "label": "VNDB",
    "cacheFile": "vndb_characters_by_bee.zip",
    "release": "1.0.0",
    "url": "https://github.com/bee-san/VNDB-Character-Names-by-Bee/releases/download/1.0.0/vndb_characters_by_bee.zip",
    "sha256": "da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792",
    "sizeBytes": 291705969,
    "expectedTitle": "VNDB Characters by Bee",
    "revision": "395525135651",
    "termRows": 6648310,
    "mediaRows": 146570,
    "mediaProbePaths": ["img/cc18737.webp"],
}
lock_path.write_text(json.dumps(lock, indent=4) + "\n")

replace_once(
    "dev/perf/dictionary-fixtures.js",
    "        jmdictPath: paths.jmdict,\n        fixtures,",
    "        jmdictPath: paths.jmdict,\n        vndbPath: paths.vndb,\n        fixtures,",
)

harness = "test/chromium/extension-two-dictionary-import.e2e.js"
replace_once(
    harness,
    "const supportedQuickImportBenchmarkDictionaries = new Set(['jmdict', 'jmnedict', 'jitendex']);",
    "const supportedQuickImportBenchmarkDictionaries = new Set(['jmdict', 'jmnedict', 'jitendex', 'vndb']);",
)
replace_once(
    harness,
    "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},",
    "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},\n"
    "            vndb: {label: 'VNDB', filePath: cachedDictionaries.vndbPath},",
)
replace_once(
    harness,
    "                state.counts[0]?.terms !== fixture.termRows) {",
    "                state.counts[0]?.terms !== fixture.termRows ||\n"
    "                (fixture.mediaRows !== undefined && state.counts[0]?.media !== fixture.mediaRows)) {",
)
replace_once(
    harness,
    "                restartedState.counts[0]?.terms !== fixture.termRows) {",
    "                restartedState.counts[0]?.terms !== fixture.termRows ||\n"
    "                (fixture.mediaRows !== undefined && restartedState.counts[0]?.media !== fixture.mediaRows)) {",
)

media_helper = r"""
async function qualifyArchiveMedia(page, archive, fixture) {
    if (fixture.mediaRows === undefined) { return null; }
    const {stdout: listing} = await execFileAsync('unzip', ['-Z1', archive], {maxBuffer: 8 * 1024 * 1024});
    const names = listing.split('\n').filter((name) => name.endsWith('.webp'));
    if (names.length !== fixture.mediaRows) { fail('Source media count differs from the locked fixture'); }
    const paths = [...new Set([names[0], names[Math.floor(names.length / 3)], names[Math.floor(names.length * 2 / 3)], names[names.length - 1], ...fixture.mediaProbePaths])];
    const media = await evalSendMessage(page, 'readerBridgeRuntime', {
        action: 'getMedia', params: {targets: paths.map((path) => ({path, dictionary: fixture.expectedTitle}))},
    });
    if (!Array.isArray(media) || media.length !== paths.length) { fail('Persisted media probes are incomplete'); }
    const results = [];
    for (const path of paths) {
        const found = media.filter((entry) => entry.path === path && entry.dictionary === fixture.expectedTitle);
        if (found.length !== 1 || typeof found[0].content !== 'string' || found[0].mediaType !== 'image/webp') { fail(`Invalid persisted media probe: ${path}`); }
        const {stdout: source} = await execFileAsync('unzip', ['-p', archive, path], {encoding: 'buffer', maxBuffer: 4 * 1024 * 1024});
        const actual = Buffer.from(found[0].content, 'base64');
        const expectedHash = createHash('sha256').update(source).digest('hex');
        const actualHash = createHash('sha256').update(actual).digest('hex');
        if (actual.length !== source.length || actualHash !== expectedHash) { fail(`Persisted media bytes differ from source: ${path}`); }
        results.push({path, bytes: actual.length, sha256: actualHash});
    }
    return results;
}

"""
replace_once(harness, "async function main() {", media_helper + "async function main() {")
replace_once(
    harness,
    "                const preRestartOutputDigest = probeDigest(probeResults);",
    "                const preRestartOutputDigest = probeDigest(probeResults);\n"
    "                let packedMediaActivation = null;\n"
    "                if (fixture.mediaRows !== undefined) {\n"
    "                    const phases = initialImportDebug.importerPhaseTimings.filter((phase) => phase.phase === 'import-data-banks');\n"
    "                    const details = phases.length === 1 ? phases[0].details : null;\n"
    "                    const descriptor = info[0].generationMedia;\n"
    "                    if (descriptor?.version !== 2 || !(descriptor.count > 0 && descriptor.count <= fixture.mediaRows) ||\n"
    "                        details?.step4SourcePackedMediaEntryCount !== descriptor.count || !(details.step4SourcePackedMediaBytes > 0)) {\n"
    "                        fail('VNDB packed-media validation path did not activate');\n"
    "                    }\n"
    "                    packedMediaActivation = {entries: details.step4SourcePackedMediaEntryCount, bytes: details.step4SourcePackedMediaBytes};\n"
    "                }\n"
    "                const mediaBeforeRestart = await qualifyArchiveMedia(page, initialImportSpec.filePath, fixture);",
)
replace_once(
    harness,
    "                const postRestartOutputDigest = probeDigest(restartedProbeResults);",
    "                const postRestartOutputDigest = probeDigest(restartedProbeResults);\n"
    "                const mediaAfterRestart = await qualifyArchiveMedia(page, initialImportSpec.filePath, fixture);\n"
    "                if (fixture.mediaRows !== undefined && JSON.stringify(info[0].generationMedia) !== JSON.stringify(restartedInfo[0].generationMedia)) { fail('Packed-media descriptor changed across restart'); }\n"
    "                if (JSON.stringify(mediaBeforeRestart) !== JSON.stringify(mediaAfterRestart)) { fail('Media changed across browser restart'); }",
)
replace_once(
    harness,
    "                    outputDigestSha256: postRestartOutputDigest,",
    "                    outputDigestSha256: postRestartOutputDigest,\n"
    "                    mediaRows: state.counts[0].media,\n"
    "                    generationMedia: info[0].generationMedia ?? null,\n"
    "                    packedMediaActivation,\n"
    "                    mediaBeforeRestart, mediaAfterRestart,",
)

print(json.dumps({"fixture": lock["dictionaries"]["vndb"], "overlayRoot": str(root)}))
