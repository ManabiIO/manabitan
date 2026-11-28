"""Pure helpers for original-artifact auditing. Importing this module performs no I/O."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "ManabiIO/manabitan"
HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
MAX_EXPANDED = 4 * 1024 * 1024 * 1024
MAX_MEMBER = 512 * 1024 * 1024
MAX_MEMBERS = 50000

class AuditError(Exception):
    pass

def require(condition, message):
    if not condition:
        raise AuditError(message)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "Duplicate JSON key: " + key)
        value[key] = item
    return value

def parse_json(data):
    def invalid(value):
        raise AuditError("Nonfinite JSON literal: " + value)
    def finite_float(value):
        result = float(value)
        require(math.isfinite(result), "Nonfinite JSON number")
        return result
    return json.loads(data, object_pairs_hook=unique_object, parse_constant=invalid, parse_float=finite_float)

def read_json(path):
    return parse_json(Path(path).read_bytes())

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".writing")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    temporary.replace(path)

def safe_name(name):
    require(type(name) is str and name and "\0" not in name and "\\" not in name, "Unsafe member name")
    p = PurePosixPath(name)
    require(not p.is_absolute() and ".." not in p.parts and "." not in p.parts, "Unsafe member path")
    require(str(p) != "." and name in (str(p), str(p) + "/"), "Noncanonical member path")
    require(not re.match(r"^[A-Za-z]:", name), "Drive-qualified member path")
    return p

def inspect_zip(archive):
    entries = archive.infolist()
    require(len(entries) <= MAX_MEMBERS, "Too many archive members")
    names = set()
    files = set()
    canonical_names = set()
    total = 0
    for info in entries:
        require(info.orig_filename == info.filename, "ZIP filename was normalized or NUL-truncated")
        p = safe_name(info.filename)
        require(info.filename not in names, "Duplicate archive member")
        names.add(info.filename)
        require(str(p) not in canonical_names, "Duplicate canonical member path")
        canonical_names.add(str(p))
        mode = (info.external_attr >> 16) & 0o170000
        require(mode in (0, 0o100000, 0o040000), "Nonregular archive member")
        require(not info.flag_bits & 1, "Encrypted archive member")
        require(0 <= info.file_size <= MAX_MEMBER, "Oversized archive member")
        total += info.file_size
        require(total <= MAX_EXPANDED, "Expanded archive limit exceeded")
        if info.is_dir():
            require(info.file_size == 0 and mode in (0, 0o040000), "Payload or regular-file mode on directory member")
        else:
            require(mode != 0o040000, "Directory mode on file member")
            files.add(str(p))
    for name in canonical_names:
        require(not any(str(parent) in files for parent in PurePosixPath(name).parents if str(parent) != "."), "File/directory path collision")
    return entries

def stream_digest(source, target=None, expected=None):
    h = hashlib.sha256()
    size = 0
    for block in iter(lambda: source.read(1024 * 1024), b""):
        size += len(block)
        if expected is not None:
            require(size <= expected, "Stream exceeds declared byte count")
        h.update(block)
        if target is not None:
            target.write(block)
    if expected is not None:
        require(size == expected, "Stream shorter than declared byte count")
    return {"sha256": h.hexdigest(), "bytes": size}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None

class GitHub:
    def __init__(self, repository, output):
        require(repository == REPOSITORY, "Unexpected repository")
        self.repository = repository
        self.prefix = "https://api.github.com/repos/" + repository
        self.output = output
        self.headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                        "User-Agent": "manabitan-original-artifact-audit"}
        token = os.environ.get("GH_TOKEN")
        if token:
            self.headers["Authorization"] = "Bearer " + token
        self.trees = {}
        self.blobs = {}

    def json(self, suffix, label):
        require(suffix.startswith("/") and not suffix.startswith("//"), "Invalid API path")
        request = urllib.request.Request(self.prefix + suffix, headers=self.headers, method="GET")
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
                require(response.status == 200, "Unexpected API status")
                data = response.read(16 * 1024 * 1024 + 1)
                require(len(data) <= 16 * 1024 * 1024, "Oversized API response")
        except urllib.error.HTTPError as error:
            raise AuditError("GitHub API HTTP " + str(error.code) + " for " + suffix) from None
        value = parse_json(data)
        write_json(self.output / "api" / (label + ".json"), value)
        return value

    def artifact(self, expected, publication, output):
        artifact_id = expected["id"]
        require(type(artifact_id) is int and artifact_id > 0, "Invalid artifact ID")
        metadata = self.json("/actions/artifacts/" + str(artifact_id), "artifact-" + str(artifact_id))
        for key, wanted in (("id", artifact_id), ("name", expected["name"]),
                            ("size_in_bytes", expected["sizeBytes"]), ("digest", "sha256:" + expected["sha256"]),
                            ("expired", False)):
            require(metadata.get(key) == wanted, "Artifact metadata differs: " + key)
        association = metadata.get("workflow_run", {})
        for key, wanted in (("id", publication["runId"]), ("head_sha", publication["headSha"]),
                            ("head_branch", publication["headBranch"])):
            require(association.get(key) == wanted, "Artifact run association differs: " + key)
        request = urllib.request.Request(self.prefix + "/actions/artifacts/" + str(artifact_id) + "/zip",
                                         headers=self.headers, method="GET")
        try:
            response = urllib.request.build_opener(NoRedirect()).open(request, timeout=60)
        except urllib.error.HTTPError as error:
            require(error.code in (301, 302, 303, 307, 308), "Artifact redirect failed")
            location = error.headers.get("Location", "")
            parsed = urllib.parse.urlparse(location)
            require(parsed.scheme == "https" and parsed.hostname and parsed.username is None and parsed.password is None,
                    "Invalid artifact redirect")
            # The signed URL is never persisted. No GitHub token crosses this boundary.
            try:
                response = urllib.request.urlopen(urllib.request.Request(location, method="GET"), timeout=60)
            except Exception as failure:
                raise AuditError("Signed artifact download failed: " + type(failure).__name__) from None
        path = output / ("original-" + str(artifact_id) + ".zip")
        with response, path.open("xb") as target:
            received = stream_digest(response, target, expected["sizeBytes"])
        require(received["sha256"] == expected["sha256"], "Artifact ZIP SHA256 differs")
        return path, metadata

    def tree(self, commit_sha, expected_tree=None):
        require(HEX40.fullmatch(commit_sha) is not None, "Invalid source commit")
        if commit_sha not in self.trees:
            commit = self.json("/git/commits/" + commit_sha, "commit-" + commit_sha)
            require(commit.get("sha") == commit_sha, "Commit identity differs")
            tree_sha = commit["tree"]["sha"]
            raw = self.json("/git/trees/" + tree_sha + "?recursive=1", "tree-" + tree_sha)
            require(raw.get("sha") == tree_sha and raw.get("truncated") is False, "Incomplete source tree")
            blobs = {}
            for entry in raw["tree"]:
                if entry["type"] == "blob":
                    require(entry["path"] not in blobs, "Duplicate source tree path")
                    blobs[entry["path"]] = entry
            self.trees[commit_sha] = (tree_sha, blobs)
        tree_sha, blobs = self.trees[commit_sha]
        if expected_tree is not None:
            require(tree_sha == expected_tree, "Source tree differs")
        return blobs

    def source(self, commit_sha, path):
        tree = self.tree(commit_sha)
        require(path in tree and tree[path]["mode"] in ("100644", "100755"), "Missing regular source file: " + path)
        blob_sha = tree[path]["sha"]
        if blob_sha not in self.blobs:
            raw = self.json("/git/blobs/" + blob_sha, "blob-" + blob_sha)
            require(raw.get("sha") == blob_sha and raw.get("encoding") == "base64", "Unexpected blob encoding")
            data = base64.b64decode("".join(raw["content"].split()), validate=True)
            require(len(data) == raw["size"], "Blob size differs")
            git_hash = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            require(git_hash == blob_sha, "Git blob hash differs")
            self.blobs[blob_sha] = data
        return self.blobs[blob_sha]

