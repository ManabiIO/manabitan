from pathlib import Path
import subprocess
ROOT = Path.cwd()
TOOLS = Path(__file__).resolve().parent
subprocess.run(['python3',str(TOOLS/'prepare.py')],check=True)
for filename in ['ext/js/dictionary/term-bank-experiments.js','types/ext/dictionary-importer.d.ts']:
    p=ROOT/filename
    text=p.read_text()
    for size in [32,48]:
        lines=[line for line in text.splitlines(True) if f'experimentalParserGroups{size}MiB' in line]
        assert len(lines)==1
        text=text.replace(lines[0],'')
    p.write_text(text)
p=ROOT/'ext/js/dictionary/term-bank-group-policy.js'
header=p.read_text().split('/**')[0]
p.write_text(header+'''/**
 * Keep non-lazy and flag-off grouping unchanged. The source lead allowance is
 * nominal: archive banks are indivisible, and this is not a browser-memory cap.
 * @param {number} defaultGroupsPerWorker
 * @param {boolean} lazy
 * @param {import('dictionary-importer').ImportExperiments} [options]
 * @returns {{groupsPerWorker: number, targetGroupBytes: number}}
 */
export function getTermBankGroupPolicy(defaultGroupsPerWorker, lazy, options = {}) {
    const enabled = lazy && options.experimentalParserGroups16MiB === true
    return {
        groupsPerWorker: enabled ? Math.floor(defaultGroupsPerWorker * 1.5) : defaultGroupsPerWorker,
        targetGroupBytes: (enabled ? 16 : 24) * 1024 * 1024,
    }
}
''')
p=ROOT/'test/term-bank-group-policy.test.js'
header=p.read_text().split("import {describe")[0]
p.write_text(header+'''import {describe, expect, test} from 'vitest'
import {getTermBankGroupPolicy} from '../ext/js/dictionary/term-bank-group-policy.js'
import {snapshotTermBankExperiments} from '../ext/js/dictionary/term-bank-experiments.js'

/** @typedef {import('dictionary-importer').ImportExperiments} Experiments */

describe('bounded 16 MiB parser group experiment', () => {
    test.each([3, 4])('keeps absent, non-true and non-lazy policies unchanged: %i', (groups) => {
        const baseline = {groupsPerWorker: groups, targetGroupBytes: 24 * 1024 * 1024}
        expect(getTermBankGroupPolicy(groups, true)).toEqual(baseline)
        expect(getTermBankGroupPolicy(groups, false, {experimentalParserGroups16MiB: true})).toEqual(baseline)
        for (const value of [false, 0, 1, null, undefined, 'true', {}]) {
            const flags = /** @type {Experiments} */ (/** @type {unknown} */ ({experimentalParserGroups16MiB: value}))
            expect(getTermBankGroupPolicy(groups, true, flags)).toEqual(baseline)
            expect(snapshotTermBankExperiments(flags).experimentalParserGroups16MiB).toBe(false)
        }
    })
    test.each([3, 4])('preserves the nominal source lead allowance: %i', (groups) => {
        const flags = {experimentalParserGroups16MiB: true}
        const policy = getTermBankGroupPolicy(groups, true, flags)
        expect(policy.targetGroupBytes).toBe(16 * 1024 * 1024)
        expect(policy.groupsPerWorker).toBe(groups === 3 ? 4 : 6)
        expect(policy.groupsPerWorker * policy.targetGroupBytes).toBeLessThanOrEqual(groups * 24 * 1024 * 1024)
        expect(snapshotTermBankExperiments(flags).experimentalParserGroups16MiB).toBe(true)
    })
    test('uses independent frozen flags across successive imports', () => {
        const flags = {experimentalParserGroups16MiB: true}
        const frozen = snapshotTermBankExperiments(flags)
        flags.experimentalParserGroups16MiB = false
        expect(getTermBankGroupPolicy(4, true, frozen)).toEqual({groupsPerWorker: 6, targetGroupBytes: 16 * 1024 * 1024})
        expect(getTermBankGroupPolicy(4, true, flags)).toEqual({groupsPerWorker: 4, targetGroupBytes: 24 * 1024 * 1024})
        expect(getTermBankGroupPolicy(3, true)).toEqual({groupsPerWorker: 3, targetGroupBytes: 24 * 1024 * 1024})
    })
})
''')
print('Only g16 production flag remains; rejected g32/g48 code and tests excluded')
