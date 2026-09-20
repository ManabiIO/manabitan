from pathlib import Path
import hashlib, difflib
p = Path('ext/js/dictionary/dictionary-importer.js')
original = p.read_text()
assert hashlib.sha256(original.encode()).hexdigest() == 'a4f6432ac5006c88784e72cfc92ccb17ed10dee522ba4c5a6328d840eb61d64c'
s = original
a = '                    let usePrecomputedTermContent = false;\n'
assert s.count(a) == 1
s = s.replace(a, a + '                    let hasMaterializedGlossary = false;\n')
a = '                                entry.glossary = glossaryList;\n'
assert s.count(a) == 1
s = s.replace(a, a + '                                hasMaterializedGlossary = true;\n')
a = "                            requirementsForChunk !== null &&\n                            typeof entry.glossaryJson !== 'string' &&"
assert s.count(a) == 1
s = s.replace(a, "                            requirementsForChunk !== null &&\n                            !hasMaterializedGlossary &&\n                            typeof entry.glossaryJson !== 'string' &&")
a = '                    // Keep serialization canonical with the runtime deserializer.\n'
assert s.count(a) == 1
s = s.replace(a, a + '                    // A conservative media hint may produce no requirements; preserve\n                    // the formatted glossary even when no later media pass will run.\n')
a = '''                        const skipGlossaryParse = (
                                typeof row.glossaryMayContainMedia === 'boolean' ?
                                    !row.glossaryMayContainMedia :
                                    !this._glossaryJsonLikelyContainsMedia(this._getFastRowGlossaryJson(row))
                        );
                        if (skipGlossaryParse) {
                            if (!this._wasmPassThroughTermContent) {
                                entry.glossaryJson = this._getFastRowGlossaryJson(row);
                            }
'''
b = '''                        const skipGlossaryParse = (
                            this._wasmPassThroughTermContent &&
                            hasPrecomputedTermContent &&
                            (
                                typeof row.glossaryMayContainMedia === 'boolean' ?
                                    !row.glossaryMayContainMedia :
                                    !this._glossaryJsonLikelyContainsMedia(this._getFastRowGlossaryJson(row))
                            )
                        );
                        if (skipGlossaryParse) {
'''
assert s.count(a) == 1
s = s.replace(a, b)
assert hashlib.sha256(s.encode()).hexdigest() == 'be39227c84f7b0cafa32b30abfec77e86e7e11a1e51eef4cca911721e39fed20'
p.write_text(s)
out = Path('builds/glossary-semantics')
out.mkdir(parents=True, exist_ok=True)
(out / 'followup.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True), s.splitlines(True), fromfile='a/' + str(p), tofile='b/' + str(p))))
