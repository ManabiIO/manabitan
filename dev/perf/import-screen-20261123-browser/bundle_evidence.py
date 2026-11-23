#!/usr/bin/env python3
"""Package exact import-screen evidence without duplicate HTML/progress output."""

import argparse
import hashlib
import io
import json
import lzma
from pathlib import Path
import tarfile
import zipfile


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text())


def build(root, metadata, output):
    output.mkdir(parents=True, exist_ok=True)
    bundles = []
    for artifact in metadata:
        archive = root / (artifact["name"] + ".zip")
        raw = archive.read_bytes()
        expected = artifact["digest"]
        if "sha256:" + sha256(raw) != expected:
            raise ValueError(f"Original artifact digest mismatch: {archive}")
        extracted = root / artifact["name"]
        protocols = list(extracted.rglob("protocol.json"))
        if len(protocols) != 1:
            raise ValueError(f"Expected exactly one protocol in {extracted}")
        directory = protocols[0].parent
        summary = directory / "summary.json"
        state_path = summary if summary.exists() else directory / "progress.json"
        state = read(state_path)
        prefix = f'{state["label"]}/{state["dictionary"]}'
        paths = {state_path}
        paths.update(path for name in (
            "protocol.json", "expected-lookup-signature.json", "runner.py", "workflow.yml"
        ) if (path := directory / name).exists())
        paths.update(directory.glob("*/*.json"))
        files = []
        stream = io.BytesIO()
        with zipfile.ZipFile(archive) as original, tarfile.open(
            fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT
        ) as packed:
            for path in sorted(paths):
                data = path.read_bytes()
                relative = path.relative_to(directory).as_posix()
                source_name = path.relative_to(extracted).as_posix()
                if original.read(source_name) != data:
                    raise ValueError(f"Extracted file differs from original ZIP: {path}")
                name = f"{prefix}/{relative}"
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                info.mtime = 0
                packed.addfile(info, io.BytesIO(data))
                files.append({"path": name, "bytes": len(data), "sha256": sha256(data)})
        packed_bytes = lzma.compress(stream.getvalue(), preset=6)
        bundle_name = f'{state["label"]}-{state["dictionary"]}-{artifact["workflow_run"]["id"]}.tar.xz'
        bundle_path = output / bundle_name
        bundle_path.write_bytes(packed_bytes)
        with tarfile.open(bundle_path, "r:xz") as verification:
            for item in files:
                data = verification.extractfile(item["path"]).read()
                if len(data) != item["bytes"] or sha256(data) != item["sha256"]:
                    raise ValueError(f"Bundle verification failed: {item['path']}")
        receipt = {
            "schemaVersion": 1,
            "label": state["label"],
            "dictionary": state["dictionary"],
            "status": state["status"],
            "observations": len(state["observations"]),
            "baseline": state["baseline"],
            "candidate": state["candidate"],
            "studyCommit": artifact["workflow_run"]["head_sha"],
            "originalArtifact": artifact,
            "originalZipSha256Verified": True,
            "artifactRetentionDays": 30,
            "workflowUrl": f'https://github.com/ManabiIO/manabitan/actions/runs/{artifact["workflow_run"]["id"]}',
            "archive": {"path": bundle_name, "bytes": len(packed_bytes), "sha256": sha256(packed_bytes)},
            "files": files,
            "exclusions": "Redundant progress (when a final summary exists), separate identity/package maps already embedded in the final summary, HTML views, and console logs remain in the original GitHub ZIP. Every observation result and raw JSON phase report is retained byte-for-byte."
        }
        if state["label"] == "media-ranges":
            receipt["supersededByStudy"] = "media-adjacent"
        manifest_name = bundle_name.removesuffix(".tar.xz") + ".manifest.json"
        (output / manifest_name).write_text(json.dumps(receipt, indent=2) + "\n")
        bundles.append({key: receipt[key] for key in (
            "label", "dictionary", "status", "observations", "baseline", "candidate", "studyCommit",
            "workflowUrl", "archive"
        )} | {"manifest": manifest_name, "artifactId": artifact["id"], "originalArtifactSha256": expected}
        | ({"supersededByStudy": receipt["supersededByStudy"]} if "supersededByStudy" in receipt else {}))
    (output / "index.json").write_text(json.dumps({"schemaVersion": 1, "bundles": bundles}, indent=2) + "\n")
    return bundles


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("output", type=Path)
    options = parser.parse_args()
    result = build(options.root, read(options.metadata), options.output)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
