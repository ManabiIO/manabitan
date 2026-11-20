#!/usr/bin/env python3
"""Reuse and verify the immutable official runtime already frozen in PR770."""

import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import tarfile
import urllib.request


GECKODRIVER_SHA256 = "e815130ea95983e162ae91843b48d3a3ce991735635fce83a647afde21e09f7e"


def checked(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path, algorithm="sha256"):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def unpack(archive, destination):
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive) as stream:
        stream.extractall(destination, filter="data")


def firefox_identity(directory):
    binary = directory / "firefox/firefox"
    application = configparser.ConfigParser()
    application.read(directory / "firefox/application.ini")
    checked(binary.is_file(), "Firefox executable is missing")
    return {"binarySha256": digest(binary), "applicationVersion": application["App"]["Version"],
            "applicationBuildId": application["App"]["BuildID"],
            "applicationIniSha256": digest(directory / "firefox/application.ini"),
            "libxulSha256": digest(directory / "firefox/libxul.so")}


def runtime_lock():
    return json.loads(Path(__file__).with_name("manifest.json").read_text())["browserRuntimes"]["firefox"]


def validate_source_metadata(metadata, lock):
    checked(metadata.get("id") == lock["sourceArtifactId"] and
            metadata.get("name") == lock["sourceArtifactName"] and
            metadata.get("size_in_bytes") == lock["sourceArtifactBytes"] and
            metadata.get("digest") == "sha256:" + lock["sourceArtifactSha256"] and
            metadata.get("expired") is False and
            metadata.get("workflow_run", {}).get("id") == lock["sourceRunId"] and
            metadata.get("workflow_run", {}).get("head_sha") == lock["sourceToolingCommit"],
            "Source runtime artifact identity differs from the frozen protocol")


def verify_source(args):
    lock = runtime_lock()
    url = f"https://api.github.com/repos/{lock['repository']}/actions/artifacts/{lock['sourceArtifactId']}"
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + os.environ["GH_TOKEN"],
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Manabitan-JMdict-browser-study/1",
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        metadata = json.load(response)
    validate_source_metadata(metadata, lock)
    args.output.mkdir(parents=True, exist_ok=False)
    save(args.output / "source-artifact.json", metadata)
    print(json.dumps({"verifiedSourceArtifact": lock["sourceArtifactId"], "sourceRun": lock["sourceRunId"]}))


def verify_artifact(directory):
    lock = runtime_lock()
    receipt_path = directory / "runtime.json"
    checked(digest(receipt_path) == lock["receiptSha256"], "Runtime receipt differs from the frozen prior release")
    receipt = json.loads(receipt_path.read_text())
    checked(receipt.get("schemaVersion") == 1 and receipt.get("officialMozillaBuild") is True, "Unverified runtime artifact")
    checked(receipt["binarySha256"] == lock["binarySha256"] and receipt["release"] == lock["version"], "Unexpected Firefox identity")
    validate_source_metadata(json.loads((directory / "source-artifact.json").read_text()), lock)
    checked(receipt["archiveFile"] == "firefox.archive" and receipt["geckodriver"]["archiveFile"] == "geckodriver.tar.gz", "Unexpected archive paths")
    archive = directory / receipt["archiveFile"]
    driver_archive = directory / receipt["geckodriver"]["archiveFile"]
    checked(archive.stat().st_size == receipt["archiveBytes"] and
            digest(archive) == receipt["archiveSha256"] and
            digest(archive, "sha512") == receipt["archiveSha512"], "Firefox archive changed in transport")
    checked(digest(driver_archive) == GECKODRIVER_SHA256 == receipt["geckodriver"]["archiveSha256"], "geckodriver archive changed in transport")
    matches = [line.split()[0] for line in (directory / "SHA512SUMS").read_text().splitlines()
               if len(line.split()) == 2 and line.split()[1].lstrip("*") == receipt["officialArchivePath"]]
    checked(matches == [receipt["archiveSha512"]], "Official checksum record differs")
    return receipt


def install(args):
    receipt_path = args.artifact / "runtime.json"
    receipt = verify_artifact(args.artifact)
    archive = args.artifact / receipt["archiveFile"]
    driver_archive = args.artifact / receipt["geckodriver"]["archiveFile"]
    unpack(archive, args.output)
    unpack(driver_archive, args.output / "driver")
    identity = firefox_identity(args.output)
    checked(all(identity[key] == receipt[key] for key in identity), "Extracted Firefox identity mismatch")
    driver = args.output / "driver/geckodriver"
    checked(digest(driver) == receipt["geckodriver"]["binarySha256"], "Extracted geckodriver identity mismatch")
    environment = {"MANABITAN_STUDY_FIREFOX_RUNTIME_RECEIPT": str(receipt_path.resolve()),
                   "MANABITAN_STUDY_FIREFOX_BINARY": str((args.output / "firefox/firefox").resolve()),
                   "MANABITAN_STUDY_GECKODRIVER": str(driver.resolve()),
                   "MANABITAN_STUDY_FIREFOX_HEADLESS": "0"}
    if "GITHUB_ENV" in os.environ:
        with Path(os.environ["GITHUB_ENV"]).open("a") as stream:
            for key, value in environment.items():
                checked("\n" not in value and "\r" not in value, "Invalid runtime path")
                stream.write(f"{key}={value}\n")
    print(json.dumps(environment), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("verify-source", "verify", "install"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--artifact", type=Path)
    args = parser.parse_args()
    if args.phase == "verify-source":
        checked(args.output is not None, "--output is required")
        verify_source(args)
    else:
        checked(args.artifact is not None, "--artifact is required")
        if args.phase == "verify":
            receipt = verify_artifact(args.artifact)
            print(json.dumps({"verifiedRelease": receipt["release"], "receiptSha256": digest(args.artifact / "runtime.json")}))
        else:
            checked(args.output is not None, "--output is required")
            install(args)


if __name__ == "__main__":
    main()
