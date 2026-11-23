# Independent in-flight validation screen

This separate campaign uses the already frozen round-three timing driver and
readback guards. The only runtime difference is `dictionary-database.js` at the
source revisions recorded in `candidates.json`. It compares the current develop
base with an independently guarded in-flight registration validator.

The preliminary component replay removed repeated type checks across every
pinned JMdict group, but its absolute warmed-Node saving was only about 3.7 ms
per corpus. That observation does not establish a browser import improvement.
The measured component source predates separately recorded lint and correctness
hardening; the new campaign uses the final checked revision only. No component
timing is repeated to select a favorable outcome.

All three corpora have two fixed 26-observation replications, each with eight
adjacent counterbalanced candidate pairs and four baseline A/A controls. The
full semantic and physical probe results must remain identical between arms,
and every import includes restart verification. Every original result, control,
failure and provenance receipt is retained. There is no process-memory sampling
in this timing screen.

The candidate remains a draft until the full import data justifies its added
guard logic. Removing component work alone is not a claim that users will see
faster imports.
