#!/usr/bin/env python3
"""One diagnostic browser trace per pinned dictionary; never a timing comparison."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
BASELINE = "5e1f8c12f7ff798ba407323aff675cb23b22af02"
OVERLAY_FILES = (
    "dev/perf/dictionary-fixtures.js",
    "dev/perf/import-benchmark.js",
    "dev/perf/benchmark-support.js",
    "test/chromium/extension-two-dictionary-import.e2e.js",
    "test/perf/dictionaries.lock.json",
)
EXTRA_FIXTURE = {
    "label": "VNDB Characters by Bee",
    "cacheFile": "vndb_characters_by_bee.zip",
    "release": "1.0.0",
    "url": "https://github.com/bee-san/VNDB-Character-Names-by-Bee/releases/download/1.0.0/vndb_characters_by_bee.zip",
    "sha256": "da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792",
    "sizeBytes": 291705969,
    "expectedTitle": "VNDB Characters by Bee",
    "revision": "395525135651",
    "termRows": 6648310,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def capture(args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def clean_environment():
    return {key: value for key, value in os.environ.items()
            if not re.match(r"^MANABITAN_(?:E2E_|CHROMIUM_)", key)}


def command(args, cwd, log, timeout=1200):
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w") as output:
        output.write(json.dumps({"argv": args, "cwd": str(cwd)}) + "\n")
        output.flush()
        result = subprocess.run(args, cwd=cwd, env=clean_environment(),
                                stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    require(result.returncode == 0, f"Command failed ({result.returncode}); see {log}")


def replace_once(source, before, after):
    require(source.count(before) == 1, f"Harness overlay anchor changed: {before[:90]}")
    return source.replace(before, after, 1)


def overlay_contents(config, dictionary):
    """The ordinary fixture lock is never edited in the research checkout."""
    values = {name: (ROOT / name).read_bytes() for name in OVERLAY_FILES}
    lock = json.loads(values["test/perf/dictionaries.lock.json"])
    require("vndb" not in lock["dictionaries"], "VNDB unexpectedly became a default fixture")
    if dictionary == "vndb":
        lock["dictionaries"]["vndb"] = config["extraFixture"]
    values["test/perf/dictionaries.lock.json"] = (json.dumps(lock, indent=4) + "\n").encode()
    name = "dev/perf/dictionary-fixtures.js"
    source = values[name].decode()
    source = replace_once(source, "jmdictPath: string, fixtures:", "jmdictPath: string, vndbPath: string, fixtures:")
    source = replace_once(source, "        jmdictPath: paths.jmdict,", "        jmdictPath: paths.jmdict,\n        vndbPath: paths.vndb,")
    values[name] = source.encode()
    name = "test/chromium/extension-two-dictionary-import.e2e.js"
    source = values[name].decode()
    source = replace_once(source, "new Set(['jmdict', 'jmnedict', 'jitendex'])", "new Set(['jmdict', 'jmnedict', 'jitendex', 'vndb'])")
    source = replace_once(source,
                          "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},",
                          "            jitendex: {label: 'Jitendex', filePath: cachedDictionaries.jitendexPath},\n"
                          "            vndb: {label: 'VNDB Characters by Bee', filePath: cachedDictionaries.vndbPath},")
    values[name] = source.encode()
    return values


def ensure_extra_fixture(fixture, path):
    """Verify all target archives without adding VNDB to other timed workloads."""
    if path.exists() and path.stat().st_size == fixture["sizeBytes"] and file_digest(path) == fixture["sha256"]:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".zip.part")
    try:
        with urllib.request.urlopen(fixture["url"], timeout=120) as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target, 1024 * 1024)
        require(temporary.stat().st_size == fixture["sizeBytes"] and file_digest(temporary) == fixture["sha256"], "Extra fixture integrity mismatch")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
        require(len(names) == len(set(names)), "Duplicate ZIP package entries")
        return {name: digest(archive.read(name)) for name in sorted(names)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dictionary", choices=("jmdict", "jitendex", "vndb"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    require(not (output / "started.json").exists(), "A diagnostic cannot overwrite an earlier attempt")
    write_json(output / "started.json", {"unixTime": time.time(), "dictionary": args.dictionary})
    try:
        require(capture(["node", "--version"]) == "v22.22.0", "Requires pinned Node 22.22.0")
        product_paths = ["ext", "dev/data", "dev/lib", "dev/bin", "dev/build-libs.js", "package.json", "package-lock.json"]
        require(not capture(["git", "diff", "--name-only", BASELINE, "--", *product_paths]), "Baseline product changed")
        original = {name: file_digest(ROOT / name) for name in OVERLAY_FILES}
        overlays = overlay_contents({"extraFixture": EXTRA_FIXTURE}, args.dictionary)
        for name, data in overlays.items():
            (ROOT / name).write_bytes(data)
            saved = output / "overlay" / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.write_bytes(data)
        command(["node", "dev/perf/prepare-dictionaries.js"], ROOT, output / "fixtures.log", timeout=600)
        lock = json.loads((ROOT / "test/perf/dictionaries.lock.json").read_text())
        fixture = lock["dictionaries"][args.dictionary]
        source = ROOT / "builds/e2e-dictionary-cache" / fixture["cacheFile"]
        require(source.stat().st_size == fixture["sizeBytes"] and file_digest(source) == fixture["sha256"], "Fixture mismatch")
        command(["npm", "run", "license-report:html"], ROOT, output / "licenses.log")
        command(["node", "dev/bin/build.js", "--target", "chrome"], ROOT, output / "package.log")
        package = ROOT / "builds/manabitan-chrome.zip"
        executable = capture(["node", "--input-type=module", "-e", "import {chromium} from 'playwright'; console.log(chromium.executablePath())"])
        write_json(output / "package-entries.json", package_entries(package))
        provenance = {
            "baselineSha": BASELINE,
            "researchSha": capture(["git", "rev-parse", "HEAD"]),
            "researchTree": capture(["git", "rev-parse", "HEAD^{tree}"]),
            "scriptSha256": file_digest(__file__),
            "dictionary": args.dictionary,
            "fixture": fixture,
            "node": capture(["node", "--version"]),
            "nodeSha256": file_digest(shutil.which("node")),
            "browser": capture([executable, "--version"]),
            "browserSha256": file_digest(executable),
            "packageSha256": file_digest(package),
            "originalHarnessSha256": original,
            "overlaySha256": {name: file_digest(ROOT / name) for name in OVERLAY_FILES},
            "authoritativeTiming": False,
            "boundary": "browser-wide trace through worker import completion; trace perturbs execution",
        }
        write_json(output / "provenance.json", provenance)
        command(["node", "dev/perf/host-environment.js"], ROOT, output / "host-before.json")
        command(["node", "dev/perf/import-benchmark.js", args.dictionary, "--runs", "1", "--no-build", "--build-target", "chrome", "--trace", "--output", str(output / "trace")], ROOT, output / "trace.log", timeout=660)
        summary = json.loads((output / "trace/summary.json").read_text())
        require(summary["traceEnabled"] is True and summary["authoritativeTiming"] is False, "Diagnostic was mislabeled")
        require(file_digest(package) == provenance["packageSha256"], "Package changed")
        command(["node", "dev/perf/host-environment.js"], ROOT, output / "host-after.json")
        write_json(output / "complete.json", {"unixTime": time.time(), "authoritativeTiming": False})
    except Exception as error:
        write_json(output / "failure.json", {"unixTime": time.time(), "error": f"{type(error).__name__}: {error}"})
        raise


if __name__ == "__main__":
    main()
