from pathlib import Path
import sys
modes=set(sys.argv[1:] or ['keys','media','projection'])
assert modes <= {'keys','media','projection'}
def edit(name,old,new,n=1):
 p=Path(name); s=p.read_text(); assert s.count(old)==n,(name,old[:100],s.count(old),n); p.write_text(s.replace(old,new))
def flag(name,bit=None):
 edit('types/ext/dictionary-importer.d.ts','export type ImportExperiments = {\n',f'export type ImportExperiments = {{\n    {name}?: boolean;\n')
 edit('ext/js/dictionary/term-bank-experiments.js','    return Object.freeze({\n',f'    return Object.freeze({{\n        {name}: options.{name} === true,\n')
 if bit is not None:
  edit('ext/js/dictionary/term-bank-experiments.js','    return (options.',f'    return (options.{name} === true ? {bit} : 0) |\n    (options.')
if 'projection' in modes:
 flag('experimentalMediaOnlyProjection')
 p='ext/js/dictionary/term-bank-wasm-parser.js'
 old='        const needsRowProjection = fusedStringPlan === null || emitTermByteLists || !emitContentSlab || mediaHintFastScan;'
 new='''        const mediaOnlyProjection = experiments.experimentalMediaOnlyProjection &&
            fusedStringPlan !== null && !emitTermByteLists && emitContentSlab;
        const needsRowProjection = !mediaOnlyProjection && (fusedStringPlan === null || emitTermByteLists || !emitContentSlab || mediaHintFastScan);
        if (mediaOnlyProjection && mediaHintFastScan) {
            // All ordinary columns already alias the fused parser's output.
            // Scan only the media hint column; do not rewrite shared columns.
            for (let sourceIndex = start; sourceIndex < end; ++sourceIndex) {
                if (metas[sourceIndex * META_U32_FIELDS + 14] !== 1) { continue; }
                mediaRows.push({
                    index: sourceIndex - start,
                    row: decodeParsedTermRowMinimal(source, metas, contentMetas, heap, contentOutPtr, version, sourceIndex, false, true, true, true, true),
                });
            }
        }'''
 edit(p,old,new)
if modes & {'keys','media'}:
 p='ext/js/dictionary/wasm/term-bank-parser.c'
 edit(p,'    uint32_t* text_normalization_hint\n)', '    uint32_t* text_normalization_hint,\n    uint32_t experiment_mask\n)',2)
 edit(p,'out_end, 0, 0, 0);','out_end, 0, 0, 0, 0u);')
 edit(p,'out_end, media_hint, normalization_hint, text_normalization_hint);','out_end, media_hint, normalization_hint, text_normalization_hint, experiment_mask);')
 edit(p,'    uint32_t* glossary_witness\n)', '    uint32_t* glossary_witness,\n    uint32_t experiment_mask\n)')
 edit(p,'                    &out_meta->glossary_requires_text_normalization\n','                    &out_meta->glossary_requires_text_normalization,\n                    experiment_mask\n')
 edit(p,'media_hints, &row_end, 0, 0u, 0))','media_hints, &row_end, 0, 0u, 0, 0u))',2)
 edit(p,'!= 0u ? &glossary_witness : 0))','!= 0u ? &glossary_witness : 0, experiment_mask))')
if 'keys' in modes:
 flag('experimentalShortGlossaryKeys',32)
 p='ext/js/dictionary/wasm/term-bank-parser.c'
 helper='''// Exact, bounded recognizers for frequent structured-content object keys.
// Every miss goes through the original validating string scanner.
static inline int short_glossary_key_end(const uint8_t* src, uint32_t len, uint32_t start, uint32_t* out_end) {
    if (len - start < 5u) { return 0; }
    uint32_t prefix;
    __builtin_memcpy(&prefix, src + start, sizeof(prefix));
    if (prefix == UINT32_C(0x67617422) && src[start + 4u] == '"') {
        *out_end = start + 5u;
        return 1;
    }
    if (len - start >= 6u && src[start + 5u] == '"' &&
        ((prefix == UINT32_C(0x74616422) && src[start + 4u] == 'a') ||
         (prefix == UINT32_C(0x70797422) && src[start + 4u] == 'e'))) {
        *out_end = start + 6u;
        return 1;
    }
    if (len - start >= 9u && prefix == UINT32_C(0x6e6f6322)) {
        uint64_t word;
        __builtin_memcpy(&word, src + start, sizeof(word));
        if (word == UINT64_C(0x746e65746e6f6322) && src[start + 8u] == '"') {
            *out_end = start + 9u;
            return 1;
        }
    }
    return 0;
}

'''
 edit(p,'static int parse_composite_span_impl(',helper+'static int parse_composite_span_impl(')
 edit(p,'            if (!parse_string_span(src, len, i, &s_end)) { return 0; }','''            if (!((experiment_mask & 32u) != 0u &&
                (state == OBJECT_FIRST || state == OBJECT_KEY) &&
                short_glossary_key_end(src, len, i, &s_end)) &&
                !parse_string_span(src, len, i, &s_end)) { return 0; }''')
if 'media' in modes:
 flag('experimentalExactMediaHints',64)
 p='ext/js/dictionary/wasm/term-bank-parser.c'
 helper='''static inline int token_has_escape(const uint8_t* src, uint32_t start, uint32_t end) {
    for (uint32_t i = start; i < end; ++i) {
        if (src[i] == '\\\\') { return 1; }
    }
    return 0;
}

'''
 edit(p,'static int parse_composite_span_impl(',helper+'static int parse_composite_span_impl(')
 edit(p,"    uint8_t state = src[start] == '[' ? ARRAY_FIRST : OBJECT_FIRST;", "    uint8_t state = src[start] == '[' ? ARRAY_FIRST : OBJECT_FIRST;\n    uint8_t media_key = 0u;")
 edit(p,'if (media_hint != 0 && *media_hint == 0u && is_media_marker_at(src, len, i)) {','if ((experiment_mask & 64u) == 0u && media_hint != 0 && *media_hint == 0u && is_media_marker_at(src, len, i)) {')
 needle='''            if (state == OBJECT_FIRST || state == OBJECT_KEY) {
                if ('''
 replacement='''            if ((experiment_mask & 64u) != 0u && media_hint != 0 && *media_hint == 0u) {
                if (state == OBJECT_FIRST || state == OBJECT_KEY) {
                    media_key = 0u;
                    const uint32_t length = s_end - i;
                    if (length == 5u && src[i + 1u] == 't' && src[i + 2u] == 'a' && src[i + 3u] == 'g') {
                        media_key = 1u;
                    } else if (length == 6u && src[i + 1u] == 't' && src[i + 2u] == 'y' && src[i + 3u] == 'p' && src[i + 4u] == 'e') {
                        media_key = 2u;
                    } else if (token_has_escape(src, i, s_end)) {
                        // Escaped keys may name tag/type: use the existing
                        // general media resolver rather than risk a false negative.
                        *media_hint = 1u;
                    }
                } else if (state == OBJECT_VALUE && media_key != 0u) {
                    const uint32_t length = s_end - i;
                    if (((media_key == 1u && length == 5u) || (media_key == 2u && length == 7u)) &&
                        is_media_marker_at(src, len, i)) {
                        *media_hint = 1u;
                    } else if (token_has_escape(src, i, s_end)) {
                        *media_hint = 1u;
                    }
                    media_key = 0u;
                }
            }
            if (state == OBJECT_FIRST || state == OBJECT_KEY) {
                if ('''
 edit(p,needle,replacement)
