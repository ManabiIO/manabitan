#!/usr/bin/env python3
"""Derive the separate a300 qualification from the completed faf6 workflow."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OLD_DIR = "dev/perf/import-numeric-suffix-972-qualification-c563d487"
NEW_DIR = "dev/perf/numeric-suffix-proof-consumer-982-qualification-c563d487"
OLD_WORKFLOW = ".github/workflows/import-numeric-suffix-972-qualification-c563d487.yml"
NEW_WORKFLOW = ".github/workflows/import-suffix-proof-982-qualification-c563d487.yml"
PROVENANCE = ["prospective-review-criteria.json", "source-binding.json", "fresh-correctness-proof.json",
              "storage-prerequisite-decision.json", "full-qualification-binding.json"]
sha = lambda data: hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    old = (ROOT / "original-faf6-workflow.yml").read_text()
    assert sha(old.encode()) == "46d6037dbcf9e85b6811a9da83f2bd6a74e9b6b01dcc3889b00009adea75fcf2"
    text = old
    replacements = []
    def replace(before, after, count=None):
        nonlocal text
        found = text.count(before)
        assert found and (count is None or count == found), (before, found, count)
        text = text.replace(before, after)
        replacements.append({"before": before, "after": after, "count": found})
    replace("Current-base numeric suffix import qualification c563d487",
            "Current-base suffix proof consumer import qualification c563d487", 1)
    replace("perf/import-numeric-suffix-972-qualification-20261128-c563d487",
            "perf/import-suffix-proof-982-qualification-20261128-c563d487", 1)
    replace(OLD_WORKFLOW, NEW_WORKFLOW, 2)
    replace(OLD_DIR, NEW_DIR)
    replace("dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16", "a300da36d00df8e353c5679b1528b50a1299b75f", 1)
    replace("4cd1abfabcb92c09694f107ff8e856add52e07df", "61ac55c50d9ade7b90dbeb9299de18e094e25044", 1)
    replace("d28d74f9c1047491670942ec6e0414cc9c823101", "4b1d90e0cfbc4d19322105a92b1b3c0d9792436c", 1)
    replace("numeric-suffix-972-c563d487-", "suffix-proof-982-c563d487-")
    replace("numeric-suffix-972-correctness-reuse", "suffix-proof-982-fresh-correctness-reuse")
    replace("Bind exact product to original correctness", "Bind exact product to fresh current correctness", 1)
    replace("Bind the six-file product to all original correctness proofs", "Bind the eight-file product to fresh exact-head correctness", 1)
    replace("verify-correctness-reuse.py", "verify-fresh-correctness.py")
    replace("--binding " + NEW_DIR + "/correctness-reuse-binding.json",
            "--binding " + NEW_DIR + "/full-qualification-binding.json", 1)
    replace('command.extend(["--vndb-sah-allocation-units", "37", "37"])',
            'command.extend(["--vndb-sah-allocation-units", "77", "77"])', 1)
    replace('if name == "prospective-complete-import-criteria.json":',
            'if name == "prospective-review-criteria.json":', 1)
    old_provenance = '''              "prospective-complete-import-criteria.json": "42364fda4ae7201e788e734a2ba49ccf0d7bfe178f56550b3046ba5935b861ee",
              "correctness-reuse-binding.json": "5e05d27bb1d7dd1bc0b95e3255e9ad8f0035a11c61c31b2c771d9e52f949cb03",
              "original-correctness-recovery.json": "1a41b0ccb3b8cfdcbcfd4cfba97ab25f8ac1c616e8ce86fcd8b859675386e720"'''
    hashes = {name: sha((ROOT / name).read_bytes()) for name in PROVENANCE}
    new_provenance = ",\n".join('              ' + json.dumps(name) + ": " + json.dumps(value) for name, value in hashes.items())
    replace(old_provenance, new_provenance, 3)
    replace('"verify-fresh-correctness.py": "de63b509951892b9d83f6a0087fb77e20f9e224d4cb5d5ffebc09a9d0c5cf988"',
            '"verify-fresh-correctness.py": "' + sha((ROOT / "verify-fresh-correctness.py").read_bytes()) + '"', 1)
    runtime_gate = '''      - name: Verify pinned browser before any observation
        run: |
          python - <<'PYTHON'
          import hashlib
          import json
          from pathlib import Path
          import subprocess
          import sys
          source = json.loads(Path("NEW_TOOL_DIR/source-binding.json").read_text())
          node = subprocess.check_output(["node", "--version"], text=True).strip()
          browser = Path(subprocess.check_output([
              "node", "--input-type=module", "-e",
              "import {chromium} from 'playwright'; process.stdout.write(chromium.executablePath())"
          ], text=True))
          digest = hashlib.sha256()
          with browser.open("rb") as stream:
              for block in iter(lambda: stream.read(1048576), b""):
                  digest.update(block)
          version = subprocess.check_output([str(browser), "--version"], text=True).strip()
          identity = {"nodeVersion": node, "pythonVersion": sys.version,
                      "browserPath": str(browser), "browserSha256": digest.hexdigest(),
                      "browserVersionOutput": version, "timed": False}
          print("MANABITAN_PINNED_RUNTIME " + json.dumps(identity, sort_keys=True), flush=True)
          if node != source["runtime"]["node"] or digest.hexdigest() != source["runtime"]["browser"]["sha256"] or version != source["runtime"]["browser"]["versionOutput"]:
              raise SystemExit("Pinned browser or Node identity differs before observation")
          PYTHON
'''.replace("NEW_TOOL_DIR", NEW_DIR)
    replace("      - name: Install pinned Chromium\n        run: npx playwright install --with-deps chromium\n",
            "      - name: Install pinned Chromium\n        run: npx playwright install --with-deps chromium\n" + runtime_gate, 1)
    # Extractor remains byte-identical apart from the explicit result/workflow path names.
    marker = "      - name: Print every raw observation and final result as compact JSON lines\n"
    end = "      - name: Preserve all original non-package evidence in bounded log chunks\n"
    old_extractor = old.split(marker, 1)[1].split(end, 1)[0]
    expected_extractor = old_extractor.replace("numeric-suffix-972-c563d487-", "suffix-proof-982-c563d487-").replace(OLD_WORKFLOW, NEW_WORKFLOW)
    actual_extractor = text.split(marker, 1)[1].split(end, 1)[0]
    assert expected_extractor == actual_extractor
    command_start = "          command = [\n"
    command_end = "          subprocess.run(command, check=True)\n"
    old_command = old.split(command_start, 1)[1].split(command_end, 1)[0]
    expected_command = old_command.replace("numeric-suffix-972-c563d487-", "suffix-proof-982-c563d487-").replace('"37", "37"', '"77", "77"')
    assert text.split(command_start, 1)[1].split(command_end, 1)[0] == expected_command
    for value in ("dcfc02a", "4cd1abfa", "37\", \"37", "42364fda", "5e05d27b", "1a41b0cc", "verify-correctness-reuse.py"):
        assert value not in text, value
    output = ROOT / args.output
    with output.open("x") as stream:
        stream.write(text)
    receipt = {"kind": "prospective-full-workflow-mechanical-composition",
               "baselineWorkflowSha256": sha(old.encode()), "workflowSha256": sha(text.encode()),
               "replacements": replacements,
               "frozenProvenance": hashes,
               "extractorByteIdenticalAfterPaths": True,
               "observerCommandIdenticalAfterEvidencePathAndProspective77": True,
               "archiveHelperUnchangedSha256": sha((ROOT / "archive-evidence.py").read_bytes()),
               "earlyRuntimeGate": "Read-only Node/browser identity and Python version receipt before any observation; no import flag, timer, sampler or workload changes.",
               "fullObservationsAcquired": 0}
    with output.with_suffix(".composition.json").open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    with output.with_suffix(".diff").open("x") as stream:
        stream.writelines(difflib.unified_diff(old.splitlines(True), text.splitlines(True),
                         fromfile="published-faf6-workflow", tofile=output.name))
    print(json.dumps({"workflow": str(output), "sha256": sha(text.encode()), "bytes": len(text.encode()),
                      "provenance": hashes, "extractorAndCommandMatch": True}))


if __name__ == "__main__":
    main()
