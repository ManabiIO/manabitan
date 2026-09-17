from pathlib import Path
import sys
src=Path(sys.argv[1]).read_text()
start=src.index('const variants=')
end=src.index('\nconst selected=',start)
src=src[:start]+"const variants={control:{},w3:{experimentalParserWorkers3:true},w4:{experimentalParserWorkers4:true}}"+src[end:]
src=src.replace("'control,fast2,workers2,generic,both'","'control,w3,w4'")
src=src.replace("base:'2f407e86fae0d3e39f506e6b1ce30886697698ea'","base:'e6f85c1fb8fec871eef76363ac0ba3c59aff78f7'")
src=src.replace("'test/term-bank-experiments.test.js','test/term-content-block-store.test.js'","'test/term-bank-experiments.test.js','test/term-bank-parser-worker-policy.test.js','test/term-content-block-store.test.js'")
src=src.replace("        assert.deepEqual(finalization.compressionExperiments,snapshotTermBankExperiments(entry.flags),'Storage-side flags differ')\n", "        assert.deepEqual(parser.parserExperiments,snapshotTermBankExperiments(entry.flags),'Parser-side flags differ')\n")
old="contentBytes:parser.parserEncodedContentBytes,storedRecordBytes:finalization.termRecordTotalWriteBytes,lookupBytes:finalization.termRecordLookupIndexWriteBytes,dedupUniqueCount:parser.dedupUniqueCount,groups:parser.parserParallelGroupCount,workers:parser.parserParallelWorkerCount"
new="dedupUniqueCount:parser.dedupUniqueCount"
assert src.count(old)==1
src=src.replace(old,new)
src=src.replace("console.log(`${id}: ${actual.totalImportMs.toFixed(2)} ms; ${finalization.termContentTotalWriteBytes} content bytes`)","console.log(`${id}: ${actual.totalImportMs.toFixed(2)} ms; workers=${parser.parserParallelWorkerCount}; groups=${parser.parserParallelGroupCount}; encoded=${parser.parserEncodedContentBytes}; lookup=${finalization.termRecordLookupIndexWriteBytes}; heap=${parser.parserMaxWasmHeapBytes}`)")
Path(sys.argv[2]).write_text(src)
print('Created fixed-plan parser-worker driver; grouping-dependent encoded/lookup layout and worker/group counts are observations, while logical rows/source/unique-content totals must match')
