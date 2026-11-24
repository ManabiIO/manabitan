# Native glossary scan/encode architecture review

**Decision: close this lead without a runtime change.** On frozen product base `bbccabd520972cc351a65d9f545bd5369b6e9747`, ordinary token-binary glossary encoding has no second grammar traversal to remove. The dominant validator still performs necessary source validation.

## Actual call sequence

1. [`parse_format3_row`](https://github.com/ManabiIO/manabitan/blob/bbccabd520972cc351a65d9f545bd5369b6e9747/ext/js/dictionary/wasm/term-bank-parser.c#L1349) calls `parse_value_span_with_glossary_hints` unless a prior exact validated glossary witness applies. That call performs the strict grammar walk, top-level glossary required-field/type validation, nesting bounds, media hint and normalization hints. The parser subsequently validates sequence and trailing term tags before the row succeeds.
2. [`encode_term_content_token_binary_row`](https://github.com/ManabiIO/manabitan/blob/bbccabd520972cc351a65d9f545bd5369b6e9747/ext/js/dictionary/wasm/term-bank-parser.c#L1987) emits the `MBR6` header and quoted rules/definition-tags/term-tags fields. When `glossary_requires_text_normalization == 0`, it copies the already validated raw glossary with `write_content_bytes`, which is a checked `memcpy`. It then calculates the two persisted XXH32 hashes over the finished content. It does not invoke a glossary grammar parser on that branch.
3. A second traversal occurs only when a `type:"text"` pair sets the text-normalization hint. [`write_normalized_glossary_value`](https://github.com/ManabiIO/manabitan/blob/bbccabd520972cc351a65d9f545bd5369b6e9747/ext/js/dictionary/wasm/term-bank-parser.c#L1858) can rescan array elements to unwrap supported text objects. Merely containing whitespace sets a different hint and does not select this token-binary normalization branch.
4. In the [fused row loop](https://github.com/ManabiIO/manabitan/blob/bbccabd520972cc351a65d9f545bd5369b6e9747/ext/js/dictionary/wasm/term-bank-parser.c#L3205), parsing happens before key preparation, recent raw-content matching and final canonical encoding/deduplication. A recent-content hit can avoid encoding entirely. Encoding during the grammar walk would run before that decision and before trailing term tags are known, requiring speculative output and rollback or additional buffer movement to preserve the exact header-before-glossary layout.

## Complete fixture activation check

The read-only ZIP-bank scan covers every term bank in both locked fixtures and checks literal as well as Unicode-escaped ASCII spellings of the `type` key and `text` value. This is a necessary trigger for the native text-normalization hint; the result is **zero pairs** in both archives.

| Fixture  | Archive SHA-256                                                    | Banks examined | Text-normalization trigger pairs |
| -------- | ------------------------------------------------------------------ | -------------: | -------------------------------: |
| JMdict   | `3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f` |             53 |                                0 |
| Jitendex | `e914c76596220dffc6ee0c069cd05992f03adb2988c12c3cebe817a3ac271356` |            219 |                                0 |

Exact pattern, source identity and results are retained in `native-normalization-activation.json`. Healthy archive CRCs are checked while reading every bank. This is a read-only source-shape audit; no changed native build or benchmark was run.

## Existing copy/hash work

[PR #840](https://github.com/ManabiIO/manabitan/pull/840), head `44686ef6ebaafa624e6d228494719bbed4cb8ef4`, already fuses copying and both persisted hashes for raw glossaries longer than 512 bytes. Its complete 7,613,164-row correctness oracle passed, but its full browser studies do not establish an import improvement. The separate fixed 12-block Jitendex assessment reports candidate/baseline paired medians of **+1.140% and +1.059%**, equal-work changes **+0.581% and +0.401%**, and only **4/12 faster pairs** against each identical baseline control. That existing open draft owns the raw copy/hash opportunity and supplies adverse or inconclusive browser evidence.

A new general scan/encode fusion would therefore target already explored copy/hash memory passes while complicating ordering, duplicate avoidance, capacity growth and rollback. It would not eliminate the dominant mandatory grammar walk for these fixtures. No material, unowned whole-import hypothesis is established by this architecture check.
