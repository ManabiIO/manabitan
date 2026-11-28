# Native media projection differential correctness replay

The replay passed against published PR #875 head
`5afd2e97ec2707b150acfde61115aee688547a78` with a clean checkout and Node
`v24.22.3` on Linux x64. The committed parser WASM SHA-256 is
`b97009b54ae1056efba84964dc6f20e334cd27f47b793a5028e66d9482cb6cfa`.

Using deterministic seed `0xc365831`, the generator produced 5,000 JSON glossary
arrays and one mutation of each array. Generated objects include repeated and
escaped keys, nested arrays and objects, Unicode paths, and combinations of
`type`, `tag`, `path`, `content`, `data`, `style`, and ignored fields. Mutations
append trailing text, truncate input, add a trailing comma, duplicate a colon,
or insert an invalid escape. Mutations that do not change a matching token can
remain valid JSON and are classified by `JSON.parse`.

| Classification                               |  Cases | Result                                                                   |
| -------------------------------------------- | -----: | ------------------------------------------------------------------------ |
| Valid JSON with a usable native projection   |  1,666 | Every returned path matched the existing JavaScript collector exactly    |
| Valid JSON returning the projection fallback |  3,473 | Counted separately; downstream fallback execution is outside this replay |
| Invalid JSON                                 |  4,861 | Every raw native projection result was zero                              |
| Total                                        | 10,000 | No assertion failures                                                    |

Each returned native token is checked to stay inside its input span and to
decode as a string. Invalid-input rejection is checked against the raw native
result before file-extension filtering, so an unsupported extension cannot
hide a nonzero result.

`result.json` and `stderr.txt` preserve the exact output; `invocation.json`
records the command, clean commit/tree, runtime, source and artifact hashes,
and scope limits. `review-media-projection-strict.mjs` accepts the repository
path as its argument and reads the committed WASM artifact. The original
review script is retained unchanged as `review-media-projection-original.mjs`
for provenance; its invalid-input check happened after extension filtering.

This is synthetic correctness evidence. It establishes neither whole-import
performance nor retained-memory behavior and does not resolve the prior #875
memory qualification hold.
