#!/usr/bin/env python3
"""Recover exact, indexed corpus helper/oracle bytes on an isolated evidence branch."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import urllib.error
import urllib.request

REPOSITORY = "ManabiIO/manabitan"
BRANCH = "experiment/recover-import-evidence-20261128-4d9f"
SOURCE_COMMIT = "a72385b08a1004bec627172b0ca07f49b50c2f19"
SOURCE_DIRECTORY = "builds/perf/20261128-4d9f-reference-fields"
ARCHIVE_NAME = "local-experiment-chronology.tar.gz"
ARCHIVE_SHA256 = "8494a9252c805062b35c9b9f4f35ca9b613b9187091a1b8b87c1f5dc16aa2da9"
ARCHIVE_BYTES = 1818484
INDEX_SHA256 = "5b64a8d0821383eab2655faa611f64fc1f3e2107dbbaac3e99712290d494e427"
DESTINATION = "builds/perf/20261128-4d9f-recovered-corpus"
HELPERS = {
    "actual-fields.mjs", "actual-fields.test.mjs", "archive-catalog.mjs",
    "common.mjs", "compare-results.mjs", "expanded-file-oracle.mjs",
    "file-oracle.mjs", "legacy-field-analysis.mjs", "metadata-oracle.mjs",
    "node-opfs-bounded.mjs", "node-opfs-bounded.test.mjs", "run.mjs",
    "launch.py", "vndb-media-oracle.py", "helper-frozen-4.json",
}
ORACLES = {
    "jitendex-output.json", "jmdict-output.json", "jmdict-reference.json",
    "vndb-corpus.json", "vndb-directory.json", "vndb-media-files.json",
    "vndb-media-original-helper.py", "vndb-output.json",
}
SELECTED = (
    {f"corpus/{name}" for name in HELPERS}
    | {f"corpus/evidence/oracles/{name}" for name in ORACLES}
    | {"corpus/evidence/protocol.json", "corpus/evidence/verification-manifest.json"}
)

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()

def api(method, resource, payload=None):
    token = os.environ["GH_TOKEN"]
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPOSITORY}/{resource}",
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "manabitan-indexed-evidence-recovery",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"GitHub {method} {resource} failed with HTTP {error.code}") from None

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-directory", required=True)
    parser.add_argument("--output-directory", required=True)
    args = parser.parse_args()
    assert os.environ["GITHUB_REPOSITORY"] == REPOSITORY
    assert os.environ["GITHUB_REF_NAME"] == BRANCH
    workflow_commit = os.environ["GITHUB_SHA"]
    source = Path(args.source_directory).resolve() / SOURCE_DIRECTORY
    output = Path(args.output_directory).resolve()
    output.mkdir(parents=True, exist_ok=False)
    index_bytes = (source / "chronology-index.json").read_bytes()
    assert sha256(index_bytes) == INDEX_SHA256, "Frozen chronology index mismatch"
    index = json.loads(index_bytes)
    archive = (source / ARCHIVE_NAME).read_bytes()
    assert len(archive) == ARCHIVE_BYTES and sha256(archive) == ARCHIVE_SHA256
    assert index["memberCount"] == 174
    expected = index["members"]
    assert len(expected) == 174 and SELECTED <= set(expected)
    recovered = {}
    verified = {}
    with tarfile.open(source / ARCHIVE_NAME, "r:gz") as tar:
        members = tar.getmembers()
        assert len(members) == 174 and len({m.name for m in members}) == 174
        assert {m.name for m in members} == set(expected)
        for member in members:
            path = PurePosixPath(member.name)
            assert member.isfile() and not path.is_absolute() and ".." not in path.parts
            receipt = expected[member.name]
            assert member.size == receipt["bytes"]
            handle = tar.extractfile(member)
            assert handle is not None
            with handle:
                data = handle.read(receipt["bytes"] + 1)
            assert len(data) == receipt["bytes"] and sha256(data) == receipt["sha256"], member.name
            verified[member.name] = {"bytes": len(data), "sha256": sha256(data)}
            if member.name in SELECTED:
                recovered[member.name] = data
    assert sum(x["bytes"] for x in verified.values()) == index["uncompressedBytes"]
    assert set(recovered) == SELECTED
    for name, data in recovered.items():
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    receipt = {
        "schemaVersion": 1,
        "sourceCommit": SOURCE_COMMIT,
        "sourceArchive": f"{SOURCE_DIRECTORY}/{ARCHIVE_NAME}",
        "sourceArchiveBytes": ARCHIVE_BYTES,
        "sourceArchiveSha256": ARCHIVE_SHA256,
        "sourceIndexSha256": INDEX_SHA256,
        "workflowCommit": workflow_commit,
        "verifiedArchiveMembers": len(verified),
        "verifiedUncompressedBytes": sum(x["bytes"] for x in verified.values()),
        "selectedFiles": {p: verified[p] for p in sorted(SELECTED)},
        "allSelectedBytesUnchanged": True,
        "scope": "Exact recovery of the accepted format4 derivative and original source oracles. This is not the untouched metadata fb9 helper, and it contains no later implicit-record-ID decoder. No new product validation or performance claim.",
        "productBranchModified": False,
    }
    publish = dict(recovered)
    publish["recovery-receipt.json"] = (json.dumps(receipt, indent=2) + "\n").encode()
    publish["chronology-index.json"] = index_bytes
    publish["README.md"] = (
        "# Exact corpus evidence recovery\n\n"
        "The selected bytes are copied unchanged from the public a723 chronology archive. "
        "All 174 archive members were verified before selection. The recovered runner is "
        "the format4 derivative of the S1 helper, not frozen metadata helper fb9. "
        "Its original profiles and oracles are retained unchanged. Any new latest-source "
        "metadata adaptation must use a separate directory, fixed source guards and explicit "
        "independent record-ID/S1/name-prefix controls before acquisition.\n"
    ).encode()
    for name, data in publish.items():
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    current = api("GET", f"git/ref/heads/{BRANCH}")
    assert current["object"]["sha"] == workflow_commit, "Recovery branch advanced before publication"
    base = api("GET", f"git/commits/{workflow_commit}")
    entries = []
    for name, data in sorted(publish.items()):
        blob = api("POST", "git/blobs", {"encoding": "base64", "content": base64.b64encode(data).decode("ascii")})
        assert blob["sha"] == git_blob(data), name
        entries.append({"path": f"{DESTINATION}/{name}", "mode": "100644", "type": "blob", "sha": blob["sha"]})
    tree = api("POST", "git/trees", {"base_tree": base["tree"]["sha"], "tree": entries})
    commit = api("POST", "git/commits", {
        "message": "test: recover exact indexed corpus helpers and source oracles",
        "tree": tree["sha"], "parents": [workflow_commit],
    })
    current = api("GET", f"git/ref/heads/{BRANCH}")
    assert current["object"]["sha"] == workflow_commit, "Recovery branch advanced during publication"
    api("PATCH", f"git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": False})
    result = {"success": True, "sourceCommit": SOURCE_COMMIT, "workflowCommit": workflow_commit,
              "recoveredCommit": commit["sha"], "recoveredTree": tree["sha"], "branch": BRANCH,
              "files": len(publish), "archiveMembersVerified": len(verified),
              "receiptSha256": sha256(publish["recovery-receipt.json"])}
    (output / "publication-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
