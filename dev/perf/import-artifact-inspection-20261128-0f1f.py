"""Read frozen GitHub artifacts and recompute analysis; never acquire measurements."""
import base64
import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import statistics
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

sys.dont_write_bytecode = True
assert sys.flags.optimize == 0, "Assertions must remain enabled"
SOURCE = Path(__file__)
CONFIG_BYTES = SOURCE.with_suffix(".json").read_bytes()
CFG = json.loads(CONFIG_BYTES)
REPO = CFG["repository"]
TOKEN = os.environ["GH_TOKEN"]
API_ROOT = "https://api.github.com/repos/" + REPO
MAX_TOTAL = 512 * 1024 * 1024
CHUNK = 1024 * 1024
sha = lambda value: hashlib.sha256(value).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def emit(label, value, compact=False):
    payload = json.dumps(value, ensure_ascii=True, allow_nan=False,
                         indent=None if compact else 2, separators=(",", ":") if compact else None)
    data = payload.encode()
    print("MANABITAN_EVIDENCE_BEGIN " + label + " bytes=" + str(len(data)) + " sha256=" + sha(data), flush=True)
    print(payload, flush=True)
    print("MANABITAN_EVIDENCE_END " + label, flush=True)


def file_json(path):
    return json.loads(path.read_bytes())


def stream_hash(stream, sink=None, limit=MAX_TOTAL):
    digest = hashlib.sha256()
    size = 0
    while block := stream.read(CHUNK):
        size += len(block)
        require(size <= limit, "Stream exceeds declared size limit")
        digest.update(block)
        if sink is not None:
            sink.write(block)
    return size, digest.hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect())


def api_request(path):
    require(path.startswith("/") and not path.startswith("//"), "Invalid API path")
    return urllib.request.Request(API_ROOT + path, headers={
        "Authorization": "Bearer " + TOKEN,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "manabitan-frozen-artifact-inspector",
    })


def api_json(path):
    with HTTP.open(api_request(path), timeout=60) as response:
        return json.load(response)


def source_at(path, commit):
    query = "/contents/" + urllib.parse.quote(path, safe="/") + "?ref=" + commit
    value = api_json(query)
    require(value["encoding"] == "base64" and value["path"] == path, "Unexpected source response")
    data = base64.b64decode("".join(value["content"].split()), validate=True)
    blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    require(blob == value["sha"] and len(data) == value["size"], "Source blob identity mismatch")
    return data


def signed_url(value):
    require(not any(ord(c) < 32 for c in value), "Control character in download location")
    url = urllib.parse.urlsplit(value)
    host = (url.hostname or "").lower()
    require(url.scheme == "https" and url.port in (None, 443), "Artifact location is not HTTPS/443")
    require(url.username is None and url.password is None, "Unexpected URL credentials")
    require(host.endswith(".blob.core.windows.net") or host.endswith(".actions.githubusercontent.com"),
            "Unexpected artifact storage host family")
    return value


def download(spec, target):
    # NoRedirect prevents Authorization from crossing the API's redirect.
    try:
        response = HTTP.open(api_request("/actions/artifacts/" + str(spec["id"]) + "/zip"), timeout=60)
    except urllib.error.HTTPError as error:
        require(error.code == 302, "Artifact API did not provide the expected redirect")
        location = signed_url(error.headers["Location"])
        error.close()
    else:
        response.close()
        raise ValueError("Artifact API unexpectedly returned without a redirect")
    for _ in range(4):
        # This is a new unauthenticated request. Never reuse API request headers.
        request = urllib.request.Request(location, headers={"User-Agent": "manabitan-frozen-artifact-inspector"})
        require("Authorization" not in request.headers, "Unexpected download authorization")
        try:
            response = HTTP.open(request, timeout=120)
        except urllib.error.HTTPError as error:
            require(error.code in (301, 302, 303, 307, 308), "Storage download failed")
            location = signed_url(error.headers["Location"])
            error.close()
            continue
        with response, target.open("xb") as output:
            result = stream_hash(response, output, spec["bytes"])
        require(result == (spec["bytes"], spec["sha256"]), "Downloaded ZIP bytes/hash mismatch")
        return
    raise ValueError("Too many unauthenticated storage redirects")


def safe_name(name):
    require(name and "\\" not in name and ":" not in name and "\0" not in name,
            "Unsafe ZIP member name")
    require(not any(ord(c) < 32 for c in name), "Control character in ZIP member name")
    path = PurePosixPath(name)
    require(not path.is_absolute() and all(p not in ("", ".", "..", ".git") for p in path.parts),
            "Unsafe ZIP member path")
    require(str(path) == name.rstrip("/"), "Noncanonical ZIP member path")
    return path


def verify_zip(archive_path, destination=None):
    rows = {}
    total = 0
    with zipfile.ZipFile(archive_path) as archive:
        require(len(archive.infolist()) <= 4096, "Too many ZIP members")
        names = set()
        for info in archive.infolist():
            safe_name(info.filename)
            require(info.filename not in names, "Duplicate ZIP member")
            names.add(info.filename)
            require(not (info.flag_bits & 1), "Encrypted ZIP member")
            file_type = stat.S_IFMT(info.external_attr >> 16)
            require(file_type in (0, stat.S_IFREG, stat.S_IFDIR), "Nonregular ZIP member")
            if info.is_dir():
                require(file_type in (0, stat.S_IFDIR), "Inconsistent directory member")
                continue
            require(file_type in (0, stat.S_IFREG), "Nonregular file member")
            total += info.file_size
            require(total <= MAX_TOTAL, "ZIP expands beyond size limit")
            target = None
            if destination is not None:
                target = destination / info.filename
                target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as stream:
                if target is None:
                    size, digest = stream_hash(stream, limit=info.file_size)
                else:
                    with target.open("xb") as output:
                        size, digest = stream_hash(stream, output, info.file_size)
            require(size == info.file_size, "ZIP size mismatch")
            rows[info.filename] = {"path": info.filename, "bytes": size, "sha256": digest}
    return rows


def declared_inventory(root, rows, name):
    manifest = file_json(root / name)
    listed = manifest["files"]
    require(len({x["path"] for x in listed}) == len(listed), "Duplicate manifest path")
    require({x["path"] for x in listed} == set(rows) - {name}, "Artifact manifest file set mismatch")
    for item in listed:
        require(rows[item["path"]]["bytes"] == item["bytes"] and
                rows[item["path"]]["sha256"] == item["sha256"], "Artifact member manifest mismatch")
    return manifest


def original_file(label, root, name):
    path = root / name
    data = path.read_bytes()
    value = {"path": name, "bytes": len(data), "sha256": sha(data)}
    value["json" if name.endswith(".json") else "text"] = json.loads(data) if name.endswith(".json") else data.decode()
    emit(label + "/original/" + name, value)


def lines_identity(path, commit, tree):
    require(path.read_text().split() == [commit, tree], "Source commit/tree mismatch: " + path.name)


def point_summary(sweeps, kind, left, right):
    output = {}
    for metric in ("compressMs", "envelopeMs", "wrappedMs"):
        values = [(x["index"], x["totals"][left][metric], x["totals"][right][metric])
                  for x in sweeps if x["kind"] == kind]
        pairs = [{"index": i, "baseline": a, "candidate": b,
                  "percent": None if a == 0 else (b / a - 1) * 100} for i, a, b in values]
        valid = all(x["percent"] is not None for x in pairs)
        output[metric] = {"pairs": pairs, "medianPairedPercent": statistics.median(x["percent"] for x in pairs) if valid else None,
                          "equalWorkPercent": (sum(b for _, a, b in values) / sum(a for _, a, b in values) - 1) * 100 if sum(a for _, a, b in values) else None,
                          "faster": sum(b < a for _, a, b in values), "bootstrap": "Not recomputed: original independent bootstrap implementation/seed is unavailable"}
    return output


def inspect_zstd(spec, root, rows):
    label = spec["label"]
    manifest = declared_inventory(root, rows, "manifest.json")
    zstd = CFG["zstd"]
    require(manifest["baseline"] == CFG["baseline"]["commit"] and manifest["dictionary"] == "jitendex", "Wrong codec corpus")
    require(str(manifest["compilerArtifactId"]) == str(zstd["compilerArtifact"]) and
            manifest["compilerArtifactZipSha256"] == zstd["compilerZip"], "Wrong compiler artifact")
    for name in ("tooling-source.txt", "product-source.txt", "product-source-after.txt"):
        original_file(label, root, name)
    lines_identity(root / "tooling-source.txt", spec["head"], zstd["toolingTree"])
    for name in ("product-source.txt", "product-source-after.txt"):
        lines_identity(root / name, CFG["baseline"]["commit"], CFG["baseline"]["tree"])
    for name in ("product-status-before.txt", "product-status-after.txt"):
        require((root / name).read_bytes() == b"", "Product worktree changed")
    report = file_json(root / "observations/report.json")
    partial = file_json(root / "observations/report.partial.json")
    require(partial["status"] == "complete" and all(k == "status" or report.get(k) == v for k, v in partial.items()),
            "Final partial report does not match complete acquisition")
    require(file_json(root / "observations/corpus.json") == report["corpus"], "Corpus copies differ")
    binding = report["runBinding"]
    require(binding["sourceHead"] == CFG["baseline"]["commit"] and binding["runnerSha256"] == zstd["count128Oracle"] and
            binding["sourceBindingSha256"] == zstd["count128Binding"] and binding["candidatePatchSha256"] == zstd["count128Patch"],
            "Codec source binding mismatch")
    require(binding["checkedInWasmSha256"] == zstd["baselineWasm"] and binding["checkedInModuleJsSha256"] == zstd["moduleJs"],
            "Wrong baseline codec bytes")
    for arm, kind in (("A0", "baseline"), ("B0", "count128"), ("A1", "baseline")):
        module = binding["modules"][arm]
        require(module["arm"] == kind and module["wasmSha256"] == zstd["baselineWasm" if kind == "baseline" else "count128Wasm"] and
                module["moduleJsSha256"] == zstd["moduleJs"], "Codec module identity mismatch")
    oracle = source_at("dev/perf/zstd-count128-20261128/corpus-oracle.mjs", spec["head"])
    require(sha(oracle) == zstd["count128Oracle"], "Published codec oracle identity mismatch")
    for relative, key in (("compiler-input/tooling-sha256.txt", "compilerToolingManifestSha256"),
                          ("compiler-input/compiler/build-report.json", "buildReportSha256")):
        require(sha((root / relative).read_bytes()) == binding[key], "Compiler source receipt mismatch")
    corpus = report["corpus"]
    lock = source_at("test/perf/dictionaries.lock.json", CFG["baseline"]["commit"])
    require(sha(lock) == CFG["baseline"]["fixtureLockSha256"], "Fixture lock mismatch")
    require(corpus["fixture"] == json.loads(lock)["dictionaries"]["jitendex"] and corpus["rows"] == corpus["fixture"]["termRows"],
            "Fixture identity/row count mismatch")
    require(len(corpus["groups"]) == 22 and len(corpus["blocks"]) == 385 and corpus["canonicalBytes"] == 389687485,
            "Unexpected codec corpus work")
    require(report["exactComparisons"] == 18341 and report["roundTrips"] == 3203 and report["syntheticCases"] == 2048,
            "Incomplete codec correctness counters")
    admission = corpus["blockAdmission"]
    require(admission["timedBlockIndexes"] == list(range(385)) and not admission["correctnessOnlyBlockIndexes"],
            "Unexpected codec admission set")
    require(corpus["nativeCompressionEntryPoint"] == "ZSTD_compress_usingDict" and corpus["compressionLevel"] == -1,
            "Wrong native route")
    schedule = [("cold-native-compression", 0, ["A0", "B0", "A1"]), ("fixed-warmup", 0, ["B0", "A1", "A0"])]
    for pair in range(12):
        schedule.append(("AB", pair, ["A0", "B0"] if pair % 2 == 0 else ["B0", "A0"]))
        if pair % 3 == 2:
            control = (pair - 2) // 3
            schedule.append(("AA", control, ["A0", "A1"] if control % 2 == 0 else ["A1", "A0"]))
    require(len(report["sweeps"]) == len(schedule) == 18, "Missing codec sweep")
    compact = []
    for sweep, expected in zip(report["sweeps"], schedule):
        require((sweep["kind"], sweep["index"], sweep["order"]) == expected, "Codec schedule drift")
        require([x["block"] for x in sweep["blocks"]] == list(range(385)), "Codec block set/order drift")
        totals = {arm: {metric: 0.0 for metric in ("compressMs", "envelopeMs", "wrappedMs")} for arm in sweep["order"]}
        for block in sweep["blocks"]:
            require(set(block["arms"]) == set(sweep["order"]), "Codec arm set drift")
            for arm, clocks in block["arms"].items():
                require(set(clocks) == {"compressMs", "envelopeMs", "wrappedMs"}, "Unexpected codec clock fields")
                require(all(isinstance(x, (int, float)) and math.isfinite(x) and x >= 0 for x in clocks.values()), "Invalid codec clock")
                require(clocks["wrappedMs"] == clocks["compressMs"] + clocks["envelopeMs"], "Wrapped clock mismatch")
                for metric, value in clocks.items():
                    totals[arm][metric] += value
        require(totals == sweep["totals"], "Block clocks do not sum exactly to original totals")
        compact.append({k: sweep[k] for k in ("kind", "index", "order", "blockScope", "totals", "memory")})
    require(report["nativeMemory"]["A0"] == report["nativeMemory"]["B0"] == report["nativeMemory"]["A1"], "Codec native heap mismatch")
    for arm, calls in (("A0", 6930), ("B0", 5390), ("A1", 2310)):
        memory = report["nativeMemory"][arm]
        require(memory["heapBytes"] == memory["maxHeapBytes"] == 16908288, "Unexpected codec native heap")
        require(report["nativeActivation"][arm]["corpus"] == {
            "ZSTD_compress": 0, "ZSTD_compress_usingDict": calls, "nativeEnvelope": calls, "javascriptEnvelope": 0}, "Native route counter mismatch")
    for name in ("manifest.json", "fixture.json", "compiler-artifact.json", "acquisition-specification.json",
                 "observations/run-binding.json", "observations/corpus.json"):
        original_file(label, root, name)
    emit(label + "/report-metadata", {k: v for k, v in report.items() if k not in ("sweeps", "corpus")})
    emit(label + "/all-original-sweep-totals", compact)
    emit(label + "/point-statistics-recomputed-from-raw-clocks", {
        "AB": point_summary(report["sweeps"], "AB", "A0", "B0"),
        "AA": point_summary(report["sweeps"], "AA", "A0", "A1"),
        "cold": compact[0], "excludedWarmup": compact[1],
        "allBlockClocksSummedExactly": True,
        "limitations": ["Cold is a single native sweep, not a replicated cold-import estimate.",
                       "Original frame payloads are absent; reported exact-frame/roundtrip assertions are source-bound counters, not newly replayed compression.",
                       "No browser import, scheduling, persistence or process-memory inference; no cross-host count64/count128 ranking."]})


def inspect_canonical(spec, root, rows):
    label = spec["label"]
    identity = CFG["canonical"]
    declared_inventory(root, rows, "artifact-manifest.json")
    hashes = {"tooling/analyze.py": identity["analyzerSha256"], "tooling/protocol.json": identity["protocolSha256"],
              "tooling/source-inventory.json": identity["sourceInventorySha256"], "snapshots/inventory.json": identity["snapshotInventorySha256"],
              "workflow.yml": identity["workflowSha256"]}
    for name, digest in hashes.items():
        require(sha((root / name).read_bytes()) == digest, "Frozen canonical tooling mismatch: " + name)
    require((root / "tooling/snapshot-inventory.json").read_bytes() == (root / "snapshots/inventory.json").read_bytes(),
            "Snapshot inventory copies differ")
    source_inventory = file_json(root / "tooling/source-inventory.json")
    require(len(source_inventory["files"]) == 14, "Unexpected canonical tooling file count")
    for item in source_inventory["files"]:
        safe_name(item["path"])
        data = (root / "tooling" / item["path"]).read_bytes()
        require(len(data) == item["bytes"] and sha(data) == item["sha256"], "Canonical source member mismatch")
    lines_identity(root / "tooling-source.txt", spec["head"], identity["tree"])
    for name in ("product-source.txt", "product-source-after.txt"):
        lines_identity(root / name, CFG["baseline"]["commit"], CFG["baseline"]["tree"])
    for name in ("product-status-before.txt", "product-status-after.txt", "product-build-diff.txt"):
        require((root / name).read_bytes() == b"", "Canonical product source changed")
    for name, digest in identity["modules"].items():
        require(sha((root / "modules" / (name + ".wasm")).read_bytes()) == digest, "Canonical module mismatch")
    inventory = file_json(root / "snapshots/inventory.json")
    require(inventory["complete"] is True and len(inventory["groups"]) == 12, "Incomplete canonical inventory")
    groups = {x["group"]: x for x in inventory["groups"]}
    require(list(groups) == list(range(1, 13)), "Canonical group order mismatch")
    snapshot_checks = []
    for group in groups.values():
        require(group["memoryPages"] == 400 and group["before"]["bytes"] == group["afterXor"]["bytes"] == 26214400, "Wrong arena capacity")
        paths = []
        for key in ("before", "afterXor"):
            item = group[key]
            safe_name(item["path"])
            path = root / "snapshots" / item["path"]
            with path.open("rb") as stream:
                require(stream_hash(stream) == (item["compressedBytes"], item["compressedSha256"]), "Compressed snapshot mismatch")
            paths.append(path)
        digests = [hashlib.sha256(), hashlib.sha256(), hashlib.sha256()]
        total = 0
        with gzip.open(paths[0], "rb") as before, gzip.open(paths[1], "rb") as delta:
            while True:
                left, right = before.read(65536), delta.read(65536)
                require(len(left) == len(right), "Unequal snapshot stream lengths")
                if not left:
                    break
                total += len(left)
                require(total <= 26214400, "Oversized decoded arena")
                digests[0].update(left)
                digests[1].update(right)
                digests[2].update((int.from_bytes(left, "little") ^ int.from_bytes(right, "little")).to_bytes(len(left), "little"))
        require(total == 26214400 and [x.hexdigest() for x in digests] ==
                [group["before"]["sha256"], group["afterXor"]["sha256"], group["afterSha256"]], "Decoded/XOR arena mismatch")
        snapshot_checks.append({"group": group["group"], "bytes": total, "beforeSha256": digests[0].hexdigest(),
                                "deltaSha256": digests[1].hexdigest(), "afterSha256": digests[2].hexdigest(), "pass": True})
    preflight = file_json(root / "preflight.json")
    require(preflight["complete"] is True and preflight["snapshotInventorySha256"] == identity["snapshotInventorySha256"],
            "Incomplete original preflight")
    require([(x["group"], x["module"]) for x in preflight["observations"]] ==
            [(g, m) for g in range(1, 13) for m in ("baseline", "row-helper", "reservation-helper")], "Wrong preflight call set")
    for entry in preflight["observations"]:
        group = groups[entry["group"]]
        require(entry["returned"] == group["expectedReturn"] and entry["bytes"] == 26214400 and
                entry["actualAfterSha256"] == group["afterSha256"], "Original preflight parity failure")
    protocol = file_json(root / "tooling/protocol.json")
    expected_names = {x["id"] + ".json" for x in protocol["schedule"]}
    observation_paths = sorted((root / "cohort/observations").glob("*.json"))
    require({x.name for x in observation_paths} == expected_names and len(observation_paths) == 36, "Wrong observation file set")
    for name in ("artifact-manifest.json", "tooling/protocol.json", "tooling/source-inventory.json", "snapshots/inventory.json",
                 "tooling-source.txt", "product-source.txt", "product-source-after.txt", "modules/build-report.json", "preflight.json",
                 "harness-contracts.json", "cohort/acquisition.json", "cohort/analysis.json"):
        original_file(label, root, name)
    emit(label + "/snapshot-byte-verification", snapshot_checks)
    columns = ["pass", "group", "rowCount", "uniqueRows", "elapsedMs", "returnValue", "expectedReturn",
               "fullMemoryEqual", "actualAfterSha256", "expectedAfterSha256"]
    for path in observation_paths:
        report = file_json(path)
        emit(label + "/original-observation/" + path.stem, {
            "fileSha256": sha(path.read_bytes()), "metadata": {k: v for k, v in report.items() if k != "calls"},
            "callColumns": columns, "callRows": [[call.get(k) for k in columns] for call in report["calls"]],
            "additionalCallFields": [{k: v for k, v in call.items() if k not in columns} for call in report["calls"]]}, compact=True)
    # Only this exact, published, stdlib-only analyzer is executed. It returns
    # analysis without writes. No browser, native module or verify.mjs is run.
    analyzer_path = root / "tooling/analyze.py"
    module_spec = importlib.util.spec_from_file_location("frozen_canonical_" + spec["variant"], analyzer_path)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    result = module.analyze(root / "tooling/protocol.json", root / "tooling/source-inventory.json",
                            root / "snapshots/inventory.json", root / "cohort", spec["variant"])
    emit(label + "/recomputed-original-analyzer", result)
    require(result == file_json(root / "cohort/analysis.json"), "Stored canonical analysis differs from deterministic recomputation")
    require(result["status"] == "valid-component-cohort", "Canonical acquisition is invalid; do not qualify any metric")
    emit(label + "/inspection-limitations", {
        "analysisMatchesExactly": True, "noNativeExecution": True, "noRemeasurement": True,
        "scope": "Captured canonical arena component only; no complete-import or cold-browser inference."})


def inspect_lint(spec, root, rows):
    label = spec["label"]
    require(set(rows) == {"check.log", "source.txt", "source-status.txt", "input-sha256.txt"}, "Unexpected source-gate artifact layout")
    lines_identity(root / "source.txt", CFG["zstd"]["productCommit"], CFG["zstd"]["productTree"])
    require((root / "source-status.txt").read_bytes() == b"", "Source gate left tracked or untracked changes")
    inputs = {}
    for line in (root / "input-sha256.txt").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        require(match is not None and match[2] not in inputs, "Malformed source-gate input hash")
        inputs[match[2]] = match[1]
    require(set(inputs) == {"dev/bin/build-zstd-wasm.js", "dev/data/zstd-simd.wasm", "dev/data/zstd-wasm-count.patch", "dev/lib/zstd-simd-module.js"},
            "Unexpected source-gate input set")
    for path, expected in inputs.items():
        require(sha(source_at(path, CFG["zstd"]["productCommit"])) == expected, "Source-gate input does not match frozen product")
    require(inputs["dev/data/zstd-simd.wasm"] == CFG["zstd"]["count64Wasm"] and
            inputs["dev/data/zstd-wasm-count.patch"] == CFG["zstd"]["count64Patch"] and
            inputs["dev/lib/zstd-simd-module.js"] == CFG["zstd"]["moduleJs"], "Source-gate codec identity mismatch")
    for name in ("source.txt", "source-status.txt", "input-sha256.txt", "check.log"):
        original_file(label, root, name)
    emit(label + "/scope", {"allOriginalLogBytesPrinted": True, "gateNotRerun": True, "claimsRequireOriginalJobSuccess": True})


def inspect_zero(spec, root, rows, run):
    label = spec["label"]
    matches = [name for name in rows if PurePosixPath(name).name == "source-identities.json"]
    require(len(matches) == 1, "Ambiguous zero-sample evidence root")
    prefix = PurePosixPath(matches[0]).parent
    identities = file_json(root / matches[0])
    require(identities["changedPackageEntries"] == ["lib/zstd.wasm"], "Unexpected original package delta")
    maps = {}
    for arm, commit, tree in (("A", CFG["baseline"]["commit"], CFG["baseline"]["tree"]),
                              ("B", CFG["zstd"]["productCommit"], CFG["zstd"]["productTree"])):
        identity = identities["arms"][arm]
        require(identity["sha"] == commit and identity["tree"] == tree, "Failed-cell source identity mismatch")
        package_path = root / prefix / ("package-" + arm + ".zip")
        with package_path.open("rb") as stream:
            require(stream_hash(stream)[1] == identity["packageSha256"], "Failed-cell package ZIP mismatch")
        members = verify_zip(package_path)
        maps[arm] = {name: item["sha256"] for name, item in members.items()}
        require(maps[arm] == identity["entries"], "Failed-cell package member map mismatch")
        require(identity["lockSha256"] == CFG["baseline"]["packageLockSha256"] and
                identity["fixtureLockSha256"] == CFG["baseline"]["fixtureLockSha256"], "Failed-cell lock identity mismatch")
    require(set(maps["A"]) == set(maps["B"]), "Failed-cell package file sets differ")
    require([name for name in maps["A"] if maps["A"][name] != maps["B"][name]] == ["lib/zstd.wasm"],
            "Failed-cell package has another changed entry")
    require(maps["A"]["lib/zstd.wasm"] == CFG["zstd"]["baselineWasm"] and
            maps["B"]["lib/zstd.wasm"] == CFG["zstd"]["count64Wasm"], "Failed-cell native bytes mismatch")
    require(not any(PurePosixPath(name).name == "registered-plan.json" for name in rows), "A measurement plan exists")
    forbidden = ("warmup-", "pair-", "control-", "media-", "memory-")
    require(not any(any(part.startswith(forbidden) for part in PurePosixPath(name).parts) or
                    PurePosixPath(name).name in ("run-1.json", "summary.json", "canonical-receipt.json") for name in rows),
            "A measurement observation exists")
    workflow_path = run["path"].split("@", 1)[0]
    require(workflow_path.startswith(".github/workflows/"), "Unexpected original workflow path")
    workflow = source_at(workflow_path, spec["head"])
    require(b"--expected-package-entry lib/zstd-simd.wasm" in workflow and
            b"--expected-package-entry lib/zstd.wasm" not in workflow, "Original expected-path mismatch not present")
    driver = source_at("dev/perf/import-qualification-20261125-a7f7.py", spec["head"])
    require(sha(driver) == CFG["importDriverSha256"], "Original observer source mismatch")
    text = driver.decode()
    require('evidence.mkdir(parents=True, exist_ok=False)' in text and
            text.index('write_json(evidence / "source-identities.json"') <
            text.index('if set(changed_entries) != set(args.expected_package_entry):') <
            text.index('write_json(evidence / "registered-plan.json"') <
            text.index("for item in schedule:"), "Observer control-flow proof differs")
    original_file(label, root, matches[0])
    for name in rows:
        if PurePosixPath(name).name == "browser-identity.json":
            original_file(label, root, name)
    emit(label + "/original-workflow", {"path": workflow_path, "sha256": sha(workflow), "text": workflow.decode()})
    emit(label + "/zero-measurement-proof", {
        "classification": "Original infrastructure failure before schedule registration or first import",
        "expectedWrongEntry": "lib/zstd-simd.wasm", "actualSoleChangedEntry": "lib/zstd.wasm",
        "packageMapsFullyVerified": True, "registeredPlanAbsent": True, "allObservationKindsAbsent": True,
        "observerSha256": sha(driver), "timingObservations": 0,
        "scope": "Preserved original failure, not a failed performance result and not a rerun. No measurements acquired by this inspector."})


def inspect(spec, workspace):
    label = spec["label"]
    run = api_json("/actions/runs/" + str(spec["run"]))
    artifact = api_json("/actions/artifacts/" + str(spec["id"]))
    job = api_json("/actions/jobs/" + str(spec["job"])) if "job" in spec else None
    require(run["id"] == spec["run"] and run["run_attempt"] == 1 and run["head_sha"] == spec["head"], "Original run identity/attempt mismatch")
    require(artifact["id"] == spec["id"] and not artifact["expired"] and artifact["size_in_bytes"] == spec["bytes"],
            "Artifact metadata identity/size mismatch")
    require(artifact["digest"] == "sha256:" + spec["sha256"] and artifact["workflow_run"]["id"] == spec["run"] and
            artifact["workflow_run"]["head_sha"] == spec["head"], "Artifact digest or run binding mismatch")
    if job is not None:
        require(job["run_id"] == spec["run"] and job["head_sha"] == spec["head"] and job["status"] == "completed",
                "Original job identity/status mismatch")
        require(job.get("run_attempt", 1) == 1, "Original job attempt mismatch")
    emit(label + "/original-github-identities", {
        "specification": spec,
        "run": {key: run.get(key) for key in ("id", "head_sha", "head_branch", "run_attempt", "status", "conclusion", "path", "html_url")},
        "artifact": {key: artifact.get(key) for key in ("id", "name", "size_in_bytes", "digest", "expired", "created_at", "updated_at", "workflow_run")},
        "job": None if job is None else {key: job.get(key) for key in ("id", "run_id", "head_sha", "run_attempt", "name", "status", "conclusion", "started_at", "completed_at")}})
    archive = workspace / "original.zip"
    download(spec, archive)
    root = workspace / "members"
    root.mkdir()
    rows = verify_zip(archive, root)
    emit(label + "/verified-zip-member-inventory", {"zipBytes": spec["bytes"], "zipSha256": spec["sha256"], "files": list(rows.values())})
    if spec["kind"] == "zstd":
        inspect_zstd(spec, root, rows)
    elif spec["kind"] == "canonical":
        inspect_canonical(spec, root, rows)
    elif spec["kind"] == "lint":
        inspect_lint(spec, root, rows)
    else:
        inspect_zero(spec, root, rows, run)
    if job is not None:
        require(job["conclusion"] == "success", "Original completed job was not successful; preserve evidence without qualification")
    emit(label + "/inspection-result", {"status": "pass", "noRemeasurement": True, "zipSha256": spec["sha256"]})


def main():
    command_token = "artifact-inspection-" + uuid.uuid4().hex
    print("::stop-commands::" + command_token, flush=True)
    results = []
    try:
        emit("inspection/source", {"scriptSha256": sha(SOURCE.read_bytes()), "manifestSha256": sha(CONFIG_BYTES),
             "githubSha": os.environ.get("GITHUB_SHA"), "githubRunId": os.environ.get("GITHUB_RUN_ID"),
             "githubRunAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "python": sys.version,
             "scope": "Read-only inspection of frozen original artifacts. No imports, browser runs, compression or WASM execution."})
        for spec in CFG["artifacts"]:
            try:
                with tempfile.TemporaryDirectory(prefix="manabitan-artifact-inspection-") as directory:
                    inspect(spec, Path(directory))
                results.append({"label": spec["label"], "status": "pass"})
            except Exception as error:
                # Never print request URLs, response headers, signed URLs or tokens.
                detail = str(error) if isinstance(error, (ValueError, AssertionError, KeyError)) else "See error type and HTTP status; network URL deliberately omitted"
                result = {"label": spec["label"], "status": "failed", "errorType": type(error).__name__,
                          "httpStatus": getattr(error, "code", None), "detail": detail}
                emit(spec["label"] + "/inspection-failure", result)
                results.append(result)
        emit("inspection/final", {"results": results, "allPassed": all(x["status"] == "pass" for x in results),
             "noMeasurementsExecuted": True, "originalArtifactsUnmodified": True})
    finally:
        print("::" + command_token + "::", flush=True)
    return 0 if all(x["status"] == "pass" for x in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
