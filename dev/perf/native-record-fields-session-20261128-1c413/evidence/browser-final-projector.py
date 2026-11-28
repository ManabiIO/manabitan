function compactOriginalFieldsEvidence(result, resultIdentity) {
  const same = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ' mismatch')
  }
  const close = (actual, expected, label) => {
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > 1e-10) throw new Error(label + ' mismatch')
  }
  const median = values => {
    const sorted = values.slice().sort((a, b) => a - b)
    const middle = sorted.length >> 1
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
  const sum = values => values.reduce((a, b) => a + b, 0)
  const columns = ['path', 'role', 'arm', 'pair', 'order', 'recordedTotalImportMs', 'includedInContrasts', 'mediaCheck', 'memory', 'semanticPassed', 'passed', 'activationPassed', 'activationProfile', 'rawReportSha256', 'summarySha256', 'canonicalReceiptSha256', 'failures']
  const cells = result.cells.map(cell => {
    same(cell.allOriginalObservations.length, 74, 'all original rows')
    same(new Set(cell.allOriginalObservations.map(row => row.path)).size, 74, 'unique original rows')
    const roles = {}
    const profiles = []
    const rows = cell.allOriginalObservations.map(row => {
      roles[row.role] = (roles[row.role] || 0) + 1
      const profile = row.activationAudit.activation
      const serialized = JSON.stringify(profile)
      let index = profiles.findIndex(value => JSON.stringify(value) === serialized)
      if (index === -1) {
        index = profiles.length
        profiles.push(profile)
      }
      return [row.path, row.role, row.arm, row.pair, row.order, row.recordedTotalImportMs, row.includedInContrasts, row.mediaCheck, row.memory, row.semanticPassed, row.passed, row.activationAudit.passed, index, row.rawReportSha256, row.summarySha256, row.canonicalReceiptSha256, row.failures]
    })
    same(roles, {warmup: 4, candidate: 48, control: 16, 'full-media': 2, memory: 4}, 'roles')
    const contrast = (role, comparisonArm, expectedCount, recorded) => {
      const originals = cell.allOriginalObservations.filter(row => row.role === role)
      same(originals.length, expectedCount * 2, 'contrast row count')
      const pairs = []
      for (let pair = 1; pair <= expectedCount; pair++) {
        const members = originals.filter(row => row.pair === pair)
        same(members.length, 2, 'pair count')
        const a = members.find(row => row.arm === 'A')
        const b = members.find(row => row.arm === comparisonArm)
        if (!a || !b || !a.includedInContrasts || !b.includedInContrasts || !a.passed || !b.passed) throw new Error('unqualified contrast member')
        if (!(a.recordedTotalImportMs > 0 && b.recordedTotalImportMs > 0)) throw new Error('duration')
        pairs.push([pair, a.recordedTotalImportMs, b.recordedTotalImportMs, a.order, b.order])
      }
      const a = pairs.map(pair => pair[1])
      const b = pairs.map(pair => pair[2])
      const ratios = pairs.map(pair => pair[2] / pair[1])
      const changes = ratios.map(ratio => (ratio - 1) * 100)
      const recomputed = {
        count: pairs.length,
        medianPairedChangePercent: median(changes),
        equalWorkChangePercent: (sum(b) / sum(a) - 1) * 100,
        fasterPairs: ratios.filter(ratio => ratio < 1).length,
        baselineMedianMs: median(a),
        comparisonMedianMs: median(b),
        medianPairedSavingMs: median(pairs.map(pair => pair[1] - pair[2]))
      }
      same(recomputed.count, recorded.count, 'recorded contrast count')
      same(recomputed.fasterPairs, recorded.fasterPairs, 'recorded faster count')
      close(recomputed.medianPairedChangePercent, recorded.medianPairedChangePercent, 'recorded median')
      close(recomputed.equalWorkChangePercent, recorded.equalWorkChangePercent, 'recorded equal work')
      for (let i = 0; i < ratios.length; i++) close(ratios[i], recorded.ratios[i], 'recorded ratio')
      return {columns: ['pair', 'baselineAMs', 'comparison' + comparisonArm + 'Ms', 'baselineOrder', 'comparisonOrder'], pairs, recomputed, recordedDescriptiveBootstrap95Percent: recorded.descriptiveBootstrap95Percent}
    }
    const memory = cell.memory.comparison.observations.map(row => ({
      name: row.name, arm: row.arm, pair: row.pair, benchmarkExitCode: row.benchmarkExitCode,
      qualifiedForWholeTreePss: row.qualifiedForWholeTreePss, qualificationFailures: row.qualificationFailures,
      maxSampledPssKiB: row.maxSampledPssKiB, maxSampledPrivateKiB: row.maxSampledPrivateKiB,
      maximumCoveredSampleGapMs: row.maximumCoveredSampleGapMs,
      allObservedSampleCount: row.allObservedSampleCount,
      fullyContainedImportSampleCount: row.fullyContainedImportSampleCount,
      stableFullyReadImportSampleCount: row.stableFullyReadImportSampleCount,
      samplesWithUnavailableSmaps: row.samplesWithUnavailableSmaps,
      samplesWithUnreadableAddressSpaces: row.samplesWithUnreadableAddressSpaces
    }))
    same(memory.length, 4, 'all memory rows')
    return {
      dictionary: cell.dictionary, initialOrder: cell.initialOrder,
      originalArtifactId: cell.originalArtifactId, originalJobId: cell.originalJobId, originalJobConclusion: cell.originalJobConclusion,
      evidenceValidated: cell.evidenceValidated, roleCounts: roles, observationColumns: columns,
      allOriginalObservations: rows, activationProfiles: profiles, activationPassed: cell.activation.passed,
      candidateVsBaseline: contrast('candidate', 'B', 24, cell.candidateVsBaseline),
      identicalCodeControl: contrast('control', 'C', 8, cell.identicalCodeControl),
      memory: {passed: cell.memory.passed, observations: memory, rawScanCount: cell.memory.audit.rawScanCount, metrics: cell.memory.audit.metrics, semanticFailures: cell.memory.semanticFailures, auditFailure: cell.memory.auditFailure},
      qualification: cell.qualification, contrastFailures: cell.contrastFailures, integrityFailures: cell.integrityFailures, observationFailures: cell.observationFailures
    }
  })
  same(cells.length, 6, 'six original cells')
  same(cells.reduce((n, cell) => n + cell.allOriginalObservations.length, 0), 444, 'all 444 rows')
  return {
    schemaVersion: 1, scope: 'Lossless numeric/role/activation projection of all 444 original reports; full source evidence remains in the exact original reader JSON and artifact. No new observations.',
    exactSourceResult: resultIdentity, source: result.source, originalPublication: result.originalPublication,
    originalRunConclusion: result.originalRunConclusion, auditEvidenceValidated: result.evidenceValidated,
    qualification: result.qualification, cells
  }
}