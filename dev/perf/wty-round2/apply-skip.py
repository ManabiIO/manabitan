from pathlib import Path

def edit(path, old, new):
    p = Path(path)
    s = p.read_text()
    assert s.count(old) == 1, (path, old[:100], s.count(old))
    p.write_text(s.replace(old, new))

edit('types/ext/dictionary-importer.d.ts', 'export type ImportExperiments = {\n', 'export type ImportExperiments = {\n    /** Bypass speculative fused parsing; retain the established general parser. */\n    experimentalSkipFusedProbe?: boolean;\n')
edit('ext/js/dictionary/term-bank-experiments.js', '    return Object.freeze({\n', '    return Object.freeze({\n        experimentalSkipFusedProbe: options.experimentalSkipFusedProbe === true,\n')
edit('ext/js/dictionary/term-bank-wasm-parser.js', '    const useFusedParse = (\n        allowFusedParse &&', '    const useFusedParse = (\n        !experiments.experimentalSkipFusedProbe &&\n        allowFusedParse &&')
