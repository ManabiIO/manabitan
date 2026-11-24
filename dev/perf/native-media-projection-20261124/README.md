# Native media-path projection

Baseline: `bbccabd520972cc351a65d9f545bd5369b6e9747`.

The parser worker previously copied and decoded each projected glossary, constructed its complete JavaScript object tree with `JSON.parse`, and walked that tree to retain image paths. The candidate projects quoted path spans in one bounded native batch per parser group, then decodes only those strings. It uses the completed native lookup output arena after all lookup containers have independent ownership. No new projection heap arena, content cache, storage format, parser admission threshold, or worker count is introduced.

The private scratch lease is available only during a single complete chunk callback and expires in `finally`, including after an awaited callback fails. The native projector validates its logical source and scratch ranges. Escaped semantic keys, excessive nesting, malformed input, or exhausted output capacity discard the entire glossary's provisional output and use the existing JavaScript collector. Literal duplicate properties retain their last value. Image nodes suppress child traversal, and paths in unrelated properties remain ignored. JavaScript retains the existing image-extension classification and exact Unicode decoding behavior.

## Complete fixture correctness replay

The [replay](verify-paths.js) verifies the locked archive size and SHA-256, checks each decoded bank's ZIP CRC, and mirrors the production lazy-source partitioning. It processes groups serially. For every chunk, a shallow clone without the private lease runs the unchanged full-glossary collector. Native output must match that reference for the complete copied chunk, every ordered image-path list, and hashes of all live glossary/content/key/lookup buffers before and after scratch reuse.

| Fixture  | Term rows | Banks / groups | Native projected rows | Fallback rows | Unique image paths |
| -------- | --------: | -------------: | --------------------: | ------------: | -----------------: |
| JMdict   |   528,299 |        53 / 12 |                    17 |             0 |                  0 |
| Jitendex |   436,555 |       219 / 22 |                   339 |             0 |                236 |
| VNDB     | 6,648,310 |      665 / 170 |               146,725 |             0 |            146,570 |

All **7,613,164** rows pass. Some media hints contain no supported image; those rows correctly produce empty lists. Repeated references across parser-group boundaries account for VNDB's larger ordered-path count. The [machine-readable report](media-path-parity.json) retains fixture identities, activation counts, complete ordered-path digests, and parity results.

Run from the repository root with the pinned Node runtime and already verified fixture cache:

```sh
node dev/perf/native-media-projection-20261124/verify-paths.js CACHE OUTPUT.json jitendex vndb jmdict
```

This is a functional and activation oracle. It does not establish a complete-import speedup or browser process-memory improvement. Full browser qualification is separate. The parser WASM grows from 62,783 to 67,616 bytes; its pinned Clang/LLD 21.1.8 build has SHA-256 `a094676b0bf219ec57c18bc1932d484c77ed4b96c29eab9656f1be142d6e77ff`.
