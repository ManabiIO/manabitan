#!/usr/bin/env python3
"""Resolve one official Mozilla runtime, then reuse exactly that archive in every cell."""

import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile
import urllib.parse
import urllib.request


MOZILLA_URL = "https://download.mozilla.org/?product=firefox-devedition-latest-ssl&os=linux64&lang=en-US"
GECKODRIVER_URL = "https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux64.tar.gz"
GECKODRIVER_SHA256 = "e815130ea95983e162ae91843b48d3a3ce991735635fce83a647afde21e09f7e"


def checked(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path, algorithm="sha256"):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def download(url, destination):
    request = urllib.request.Request(url, headers={"User-Agent": "Manabitan-JMdict-browser-study/1"})
    with urllib.request.urlopen(request, timeout=120) as response, Path(destination).open("xb") as output:
        final_url = response.url
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    return final_url


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


def resolve(args):
    args.output.mkdir(parents=True, exist_ok=False)
    archive = args.output / "firefox.archive"
    redirected = download(MOZILLA_URL, archive)
    parsed = urllib.parse.urlparse(redirected)
    checked(parsed.scheme == "https" and parsed.hostname in {
        "archive.mozilla.org", "download-installer.cdn.mozilla.net"}, "Unexpected Mozilla download host")
    match = re.fullmatch(r"/pub/devedition/releases/([0-9.]+b[0-9]+)/linux-x86_64/en-US/(firefox-[0-9.]+b[0-9]+\.tar\.(?:xz|bz2))", parsed.path)
    checked(match is not None, f"Unexpected immutable Mozilla release URL: {redirected}")
    version, filename = match.groups()
    checked(filename.startswith(f"firefox-{version}.tar."), "Release path and filename differ")
    sums_url = f"https://archive.mozilla.org/pub/devedition/releases/{version}/SHA512SUMS"
    sums = args.output / "SHA512SUMS"
    sums_final = download(sums_url, sums)
    checked(sums_final == sums_url, "Unexpected Mozilla checksum redirect")
    relative = f"linux-x86_64/en-US/{filename}"
    matches = [line.split()[0] for line in sums.read_text().splitlines()
               if len(line.split()) == 2 and line.split()[1].lstrip("*") == relative]
    checked(len(matches) == 1 and re.fullmatch(r"[a-f0-9]{128}", matches[0]), "Missing unique release archive checksum")
    checked(digest(archive, "sha512") == matches[0], "Firefox archive failed official SHA512 verification")
    driver_archive = args.output / "geckodriver.tar.gz"
    download(GECKODRIVER_URL, driver_archive)
    checked(digest(driver_archive) == GECKODRIVER_SHA256, "Pinned geckodriver checksum failed")
    firefox_dir = args.output / "verify-firefox"
    driver_dir = args.output / "verify-driver"
    unpack(archive, firefox_dir)
    unpack(driver_archive, driver_dir)
    identity = firefox_identity(firefox_dir)
    # Beta application.ini may carry the platform version without the display suffix.
    checked(identity["applicationVersion"] in {version, version.split("b")[0]}, "Archive application version differs from release URL")
    receipt = {"schemaVersion": 1, "officialMozillaBuild": True,
               "requestedUrl": MOZILLA_URL, "resolvedUrl": redirected, "release": version,
               "checksumUrl": sums_url, "officialArchivePath": relative,
               "archiveFile": archive.name, "archiveSha256": digest(archive), "archiveSha512": matches[0],
               "archiveBytes": archive.stat().st_size, **identity,
               "geckodriver": {"version": "0.37.1", "url": GECKODRIVER_URL,
                                "archiveFile": driver_archive.name, "archiveSha256": GECKODRIVER_SHA256,
                                "binarySha256": digest(driver_dir / "geckodriver")}}
    save(args.output / "runtime.json", receipt)
    print(json.dumps(receipt), flush=True)


def install(args):
    receipt_path = args.artifact / "runtime.json"
    receipt = json.loads(receipt_path.read_text())
    checked(receipt.get("schemaVersion") == 1 and receipt.get("officialMozillaBuild") is True, "Unverified runtime artifact")
    archive = args.artifact / receipt["archiveFile"]
    driver_archive = args.artifact / receipt["geckodriver"]["archiveFile"]
    checked(digest(archive) == receipt["archiveSha256"] and digest(archive, "sha512") == receipt["archiveSha512"], "Firefox archive changed in transport")
    checked(digest(driver_archive) == GECKODRIVER_SHA256 == receipt["geckodriver"]["archiveSha256"], "geckodriver archive changed in transport")
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
    parser.add_argument("phase", choices=("resolve", "install"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--artifact", type=Path)
    args = parser.parse_args()
    if args.phase == "install":
        checked(args.artifact is not None, "--artifact is required to install")
    (resolve if args.phase == "resolve" else install)(args)


if __name__ == "__main__":
    main()
