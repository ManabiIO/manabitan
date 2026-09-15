#!/usr/bin/env python3
"""Apply the reviewed policy patch, then narrow activation to oversized groups."""
from pathlib import Path
import hashlib
import subprocess
import sys

root = Path.cwd()
patch = Path(sys.argv[1])
assert hashlib.sha256(patch.read_bytes()).hexdigest() == '8266b0ca7541a0209276325a734daae25172c4a9b6b83320ff9fdc829ed50397'
subprocess.run(['git', 'apply', '--check', str(patch)], check=True)
subprocess.run(['git', 'apply', str(patch)], check=True)

p = root / 'ext/js/dictionary/term-bank-experiments.js'
s = p.read_text().replace('owner selects the qualified four-part pipeline. Explicit overrides retain', 'owner selects native segmentation for oversized groups. Explicit overrides retain')
s = s.replace('        experimentalLookupScratchReuse: true,\n        experimentalNativeSegmentedLookup: true,\n        experimentalTermBankSpans: true,\n        experimentalGlobalExactContentReuse: true,', '        experimentalNativeSegmentedLookup: true,')
p.write_text(s)
p = root / 'ext/js/dictionary/term-bank-wasm-parser.js'
s = p.read_text()
a = 'retiredLookupScratch: experiments.experimentalLookupScratchReuse ?'
assert s.count(a) == 1
s = s.replace(a, '''// Segmented lookup reuses only dead parser workspace. Small native groups
            // retain their established allocator unless explicitly experimented on.
            retiredLookupScratch: (experiments.experimentalLookupScratchReuse ||
            (experiments.experimentalNativeSegmentedLookup && (rowCount >= 0xffff || stringUniqueCount >= 0xffff))) ?''')
a = 'const retiredScratch = experiments.experimentalLookupScratchReuse && fusedPlanLayout !== null &&'
assert s.count(a) == 1
s = s.replace(a, 'const retiredScratch = (experiments.experimentalLookupScratchReuse || segmentedLookup) && fusedPlanLayout !== null &&')
p.write_text(s)
p = root / 'test/term-bank-import-policy.test.js'
s = p.read_text().replace("new Set(['experimentalLookupScratchReuse', 'experimentalNativeSegmentedLookup', 'experimentalTermBankSpans', 'experimentalGlobalExactContentReuse'])", "new Set(['experimentalNativeSegmentedLookup'])").replace('enables exactly the four qualified import paths', 'enables only native segmentation at the import boundary').replace('options.experimentalTermBankSpans = true', 'options.experimentalNativeSegmentedLookup = true').replace('disabled.experimentalTermBankSpans', 'disabled.experimentalNativeSegmentedLookup').replace('resolveTermBankImportExperiments().experimentalTermBankSpans', 'resolveTermBankImportExperiments().experimentalNativeSegmentedLookup')
p.write_text(s)
p = root / 'test/lookup-construction-experiments.test.js'
s = p.read_text()
s = s.replace("import {createRetiredLookupScratchAllocator} from '../ext/js/dictionary/term-lookup-scratch.js'", "import {createRetiredLookupScratchAllocator} from '../ext/js/dictionary/term-lookup-scratch.js'\nimport * as lookupScratch from '../ext/js/dictionary/term-lookup-scratch.js'")
at = s.index("    test('scratch reuse works independently")
s = s[:at] + '''    test('segmentation alone keeps small native groups on their established allocation path', async () => {
        const banks = makeBanks(20001)
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true})
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe(0)
        expect(candidate.profile?.nativeLookupScratchReuseGroups).toBe(0)
        expect(candidate.profile?.nativeLookupScratchReusedBytes).toBe(0)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
    })

    test('oversized native lookup automatically uses retired workspace without the small-group experiment', async () => {
        const banks = makeBanks(70001)
        const baseline = await parse(banks)
        const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true})
        expect(candidate.profile?.experiments?.experimentalLookupScratchReuse).toBe(false)
        expect(candidate.profile?.nativeSegmentedLookupSegments).toBe(3)
        expect(candidate.profile?.nativeLookupScratchReuseGroups).toBe(1)
        expect(candidate.profile?.nativeLookupScratchReusedBytes).toBeGreaterThan(0)
        expect(candidate.profile?.nativeLookupScratchReuseMisses).toBe(0)
        expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
    })

    test('oversized native lookup abandons partially planned retired space on exhaustion', async () => {
        const banks = makeBanks(70001)
        const baseline = await parse(banks)
        const original = createRetiredLookupScratchAllocator
        let allocations = 0
        const mock = vi.spyOn(lookupScratch, 'createRetiredLookupScratchAllocator').mockImplementation((regions, memoryBytes) => {
            const allocator = original(regions, memoryBytes)
            return {
                // Use real retired addresses, then inject a late capacity miss.
                // Address planning must not write anything before all allocations fit.
                allocate(size) { return ++allocations > 2 ? null : allocator.allocate(size) },
                usedBytes() { return allocator.usedBytes() },
            }
        })
        try {
            const candidate = await parse(banks, {experimentalNativeSegmentedLookup: true})
            expect(allocations).toBeGreaterThan(2)
            expect(candidate.profile?.nativeSegmentedLookupFallbacks).toBe(1)
            expect(candidate.profile?.nativeLookupScratchReuseMisses).toBe(1)
            expect(candidate.profile?.nativeLookupScratchReusedBytes).toBe(0)
            expect(digestIndexes(candidate.indexes)).toBe(digestIndexes(baseline.indexes))
        } finally {
            mock.mockRestore()
        }
    })

''' + s[at:]
p.write_text(s)
subprocess.run(['git', 'add', 'dev/perf/benchmark-support.js', 'ext/js/dictionary/dictionary-importer.js', 'ext/js/dictionary/term-bank-experiments.js', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/pages/settings/dictionary-import-controller.js', 'test/lookup-construction-experiments.test.js', 'test/perf-import-experiment-evidence.test.js', 'test/term-bank-import-policy.test.js'], check=True)
assert subprocess.check_output(['git', 'write-tree'], text=True).strip() == '2330e712e57fd0e0da641f347fd683165b24bd51'
