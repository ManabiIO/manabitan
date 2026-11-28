#!/usr/bin/env python3
"""Select the documented Mac validation compiler and retain its exact receipt.

No installation or fallback is performed. SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import time


LLVM_VERSION = "18.1.8"
IMAGE_MANIFEST = (
    "https://github.com/actions/runner-images/blob/"
    "f10516542b8f2fef89b652a8d5f5de63aa543b77/images/macos/macos-15-Readme.md"
)
PROBE_FLAGS = [
    "--target=wasm32-freestanding", "-matomics", "-mbulk-memory", "-nostdlib",
    "-Wl,--no-entry", "-Wl,--shared-memory", "-Wl,--max-memory=4294967296",
    "-Wl,--export=probe", "-Wl,--strip-all",
]


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def run(command, label, evidence, receipt, environment):
    stdout = evidence / f"{label}.stdout.log"
    stderr = evidence / f"{label}.stderr.log"
    detail = {"command": command, "stdout": stdout.name, "stderr": stderr.name,
              "startedAtUnix": time.time()}
    receipt["commands"].append(detail)
    try:
        with stdout.open("wb") as output, stderr.open("wb") as errors:
            result = subprocess.run(command, stdout=output, stderr=errors,
                                    env=environment, timeout=120, check=False)
        detail["exitCode"] = result.returncode
        if result.returncode != 0:
            raise RuntimeError(f"Compiler preflight {label} exited {result.returncode}; see {stderr}")
        return stdout.read_text(errors="replace")
    except Exception as error:
        detail["error"] = str(error)
        raise
    finally:
        detail["finishedAtUnix"] = time.time()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=pathlib.Path)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    receipt = {
        "status": "failed", "startedAtUnix": time.time(), "expectedLlvmVersion": LLVM_VERSION,
        "documentedImageManifest": IMAGE_MANIFEST,
        "host": {"platform": sys.platform, "machine": platform.machine(),
                 "macVersion": platform.mac_ver()[0], "kernel": platform.release(),
                 "imageOS": os.environ.get("ImageOS"), "imageVersion": os.environ.get("ImageVersion"),
                 "runnerOS": os.environ.get("RUNNER_OS"), "runnerArch": os.environ.get("RUNNER_ARCH")},
        "commands": [], "environmentExported": False,
    }
    try:
        if sys.platform != "darwin" or platform.machine() != "x86_64":
            raise RuntimeError("Compiler preflight requires the registered Intel macOS runner")
        environment = dict(os.environ, HOMEBREW_NO_AUTO_UPDATE="1")
        brew = shutil.which("brew")
        if brew is None:
            raise RuntimeError("Homebrew is absent; the pinned validation compiler cannot be selected")
        prefix_output = run([brew, "--prefix", "llvm@18"], "brew-prefix", evidence, receipt, environment).strip()
        prefix = pathlib.Path(prefix_output)
        if not prefix.is_absolute():
            raise RuntimeError(f"Invalid llvm@18 prefix: {prefix_output!r}")
        prefix = prefix.resolve(strict=True)
        binary_directory = prefix / "bin"
        environment["PATH"] = str(binary_directory) + os.pathsep + environment.get("PATH", "")
        receipt["llvmPrefix"] = str(prefix)
        receipt["tools"] = {}
        for name, version_label in (("clang", "clang version"), ("wasm-ld", "LLD")):
            command_path = binary_directory / name
            if not command_path.is_file() or not os.access(command_path, os.X_OK):
                raise RuntimeError(f"Required llvm@18 tool is not executable: {command_path}")
            real_path = command_path.resolve(strict=True)
            tool = {"command": str(command_path), "realPath": str(real_path),
                    "sha256": digest(real_path), "bytes": real_path.stat().st_size}
            receipt["tools"][name] = tool
            # Keep the wasm-ld invocation name even when it resolves to multicall lld.
            version = run([str(command_path), "--version"], f"{name}-version", evidence, receipt, environment)
            tool["versionOutput"] = version
            expected = rf"\b{re.escape(version_label)} {re.escape(LLVM_VERSION)}(?:\s|$)"
            if re.search(expected, version) is None:
                raise RuntimeError(f"Unexpected {name} version; required {LLVM_VERSION}")
        receipt["formulaInstallation"] = run(
            [brew, "list", "--versions", "llvm@18"], "brew-formula", evidence, receipt, environment,
        ).strip()
        compiler = receipt["tools"]["clang"]["command"]
        environment["MANABITAN_CLANG"] = compiler
        probe_source = evidence / "wasm-compiler-probe.c"
        probe_output = evidence / "wasm-compiler-probe.wasm"
        probe_source.write_text("void probe(void) {}\n")
        probe_command = [compiler, *PROBE_FLAGS, "-o", str(probe_output), str(probe_source)]
        run(probe_command, "shared-memory-probe", evidence, receipt, environment)
        receipt["probe"] = {"source": probe_source.name, "sourceSha256": digest(probe_source),
                            "output": probe_output.name, "outputSha256": digest(probe_output),
                            "outputBytes": probe_output.stat().st_size}
        for variable, value in (("GITHUB_ENV", f"MANABITAN_CLANG={compiler}"),
                                ("GITHUB_PATH", str(binary_directory))):
            if "\n" in value or "\r" in value:
                raise RuntimeError("Compiler environment path contains a newline")
            destination = pathlib.Path(os.environ[variable])
            with destination.open("a") as output:
                output.write(value + "\n")
        receipt["environmentExported"] = True
        receipt["status"] = "complete"
    except Exception as error:
        receipt["error"] = str(error)
        raise
    finally:
        receipt["finishedAtUnix"] = time.time()
        receipt["files"] = [
            {"path": path.name, "bytes": path.stat().st_size, "sha256": digest(path)}
            for path in sorted(evidence.iterdir()) if path.is_file()
        ]
        (evidence / "compiler-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
