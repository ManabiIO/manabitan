from pathlib import Path
import sys
ROOT = Path.cwd()
ASSETS = Path(__file__).parent
modes = set(sys.argv[1:] or ['range', 'simd', 'capacity'])
def replace(path, old, new, count=1):
    p = ROOT / path
    s = p.read_text()
    assert s.count(old) == count, (path, old[:80], s.count(old), count)
    p.write_text(s.replace(old, new))
def flag(name):
    replace('ext/js/dictionary/term-bank-experiments.js', '    return Object.freeze({\n', f'    return Object.freeze({{\n        {name}: options.{name} === true,\n')
    replace('types/ext/dictionary-importer.d.ts', 'export type ImportExperiments = {\n', f'export type ImportExperiments = {{\n    {name}?: boolean;\n')
if 'range' in modes:
    flag('experimentalRangeZipReads')
    source = (ASSETS / 'range-class.js').read_text()
    source = '/* eslint @stylistic/semi: ["error", "never"] */\n' + source + '/* eslint @stylistic/semi: ["error", "always"] */\n\n'
    replace('ext/js/dictionary/term-bank-source-pipeline.js', '/** Owns entry-identity-keyed, independently abortable ZIP reads. */', source + '/** Owns entry-identity-keyed, independently abortable ZIP reads. */')
    replace('ext/js/dictionary/dictionary-importer.js', 'import {RawZipPayloadReader, TermBankSourcePipeline}', 'import {RawZipPayloadReader, RangeZipPayloadReader, TermBankSourcePipeline}')
    replace('ext/js/dictionary/dictionary-importer.js', '        const rawZipPayloadReader = RawZipPayloadReader.supportsArchive(archiveContent) ?\n            new RawZipPayloadReader(archiveContent) :\n            null;', '        let rawZipPayloadReader = RawZipPayloadReader.supportsArchive(archiveContent) ?\n            new RawZipPayloadReader(archiveContent) :\n            null;\n        if (this._termBankExperiments.experimentalRangeZipReads &&\n            RangeZipPayloadReader.supportsArchive(archiveContent, activeTermFiles)) {\n            rawZipPayloadReader = new RangeZipPayloadReader(/** @type {Blob} */ (archiveContent));\n        }')
    replace('ext/js/dictionary/dictionary-importer.js', '        let rawZipPayloadReader =', '        /** @type {RawZipPayloadReader|RangeZipPayloadReader|null} */\n        let rawZipPayloadReader =')
    replace('ext/js/dictionary/dictionary-importer.js', '                fastPathParserExperiments: this._termBankExperiments,', '                rangeZipPayloadReader: rawZipPayloadReader instanceof RangeZipPayloadReader,\n                fastPathParserExperiments: this._termBankExperiments,')
if 'simd' in modes:
    flag('experimentalSimdContentHash')
    replace('ext/js/dictionary/term-bank-experiments.js', '(options.experimentalFastGlossaryNormalization === true ? 16 : 0)', '(options.experimentalFastGlossaryNormalization === true ? 16 : 0) |\n    (options.experimentalSimdContentHash === true ? 32 : 0)')
    p = 'ext/js/dictionary/wasm/term-bank-parser.c'
    replace(p, '#include <stdint.h>', '#include <stdint.h>\n#include <wasm_simd128.h>')
    replace(p, '#define EXPERIMENT_FAST_GLOSSARY_NORMALIZATION 16u', '#define EXPERIMENT_FAST_GLOSSARY_NORMALIZATION 16u\n#define EXPERIMENT_SIMD_CONTENT_HASH 32u')
    replace(p, 'static inline int write_byte_and_hash(', (ASSETS / 'simd.c').read_text() + '\nstatic inline int write_byte_and_hash(')
    replace(p, '    hash_content_xxh32_pair(out + row_start, row_length, FNV1A_OFFSET, MIX_OFFSET, &h1, &h2);\n    if ((h1 | h2) == 0u)', '    if ((experiment_mask & EXPERIMENT_SIMD_CONTENT_HASH) != 0u && row_length >= 64u) {\n        hash_content_xxh32_pair_simd(out + row_start, row_length, FNV1A_OFFSET, MIX_OFFSET, &h1, &h2);\n        if (experiment_stats != 0) { ++experiment_stats[5]; }\n    } else {\n        hash_content_xxh32_pair(out + row_start, row_length, FNV1A_OFFSET, MIX_OFFSET, &h1, &h2);\n    }\n    if ((h1 | h2) == 0u)')
    replace(p, 'for (uint32_t i = 0u; i < 5u; ++i) { experiment_stats[i] = 0u; }', 'for (uint32_t i = 0u; i < 6u; ++i) { experiment_stats[i] = 0u; }')
    p = 'ext/js/dictionary/term-bank-wasm-parser.js'
    replace(p, 'fastGlossaryNormalizationFallbackCount?: number,', 'fastGlossaryNormalizationFallbackCount?: number, simdContentHashCount?: number,')
    replace(p, "allocateWasmBuffer(wasm, 20, 'experiment stats')", "allocateWasmBuffer(wasm, 24, 'experiment stats')")
    replace(p, '[0, 0, 0, 0, 0] :', '[0, 0, 0, 0, 0, 0] :')
    replace(p, 'new Uint32Array(wasm.memory.buffer, experimentStatsPtr, 5)', 'new Uint32Array(wasm.memory.buffer, experimentStatsPtr, 6)')
    replace(p, '        const escapedKeyDecodeCount = experimentStats[0];', '        const simdContentHashCount = experimentStats[5];\n        const escapedKeyDecodeCount = experimentStats[0];')
    replace(p, '            fallback.escapedKeyDecodeCount = escapedKeyDecodeCount;', '            fallback.simdContentHashCount = simdContentHashCount;\n            fallback.escapedKeyDecodeCount = escapedKeyDecodeCount;')
    replace(p, '            fusedParseAttempts: 1,\n            escapedKeyDecodeCount,', '            fusedParseAttempts: 1,\n            simdContentHashCount,\n            escapedKeyDecodeCount,')
    replace(p, '        escapedKeyDecodeCount: parsed.escapedKeyDecodeCount ?? 0,', '        simdContentHashCount: parsed.simdContentHashCount ?? 0,\n        escapedKeyDecodeCount: parsed.escapedKeyDecodeCount ?? 0,')
    replace(p, "        escapedKeyDecodeCount: sum('escapedKeyDecodeCount'),", "        simdContentHashCount: sum('simdContentHashCount'),\n        escapedKeyDecodeCount: sum('escapedKeyDecodeCount'),")
    p = 'ext/js/dictionary/dictionary-importer.js'
    replace(p, '                            parserEscapedKeyDecodeCount:', '                            parserSimdContentHashCount: parserProfile.simdContentHashCount ?? 0,\n                            parserEscapedKeyDecodeCount:')
    replace(p, '                fastPathParserEscapedKeyDecodeCount:', '                fastPathParserSimdContentHashCount: fastPathProfile?.simdContentHashCount ?? 0,\n                fastPathParserEscapedKeyDecodeCount:')
if 'capacity' in modes:
    flag('experimentalLargerFusedCapacity')
    p = 'ext/js/dictionary/term-bank-wasm-parser.js'
    text = (ROOT / p).read_text()
    start = text.index('    const initialMetaCapacity = Math.min(')
    end = text.index('    if (useFusedParse) {', start)
    original = text[start:end]
    boundary = original.index('    const useFusedParse = (')
    capacity = original[:boundary].replace(' * INITIAL_META_ROWS_PER_SOURCE)', ' * (useFusedParse && experiments.experimentalLargerFusedCapacity === true ? 32768 : INITIAL_META_ROWS_PER_SOURCE))')
    replace(p, original, original[boundary:] + capacity)
