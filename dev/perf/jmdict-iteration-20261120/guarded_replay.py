"""Execute an unchanged archived CLI with network/process/external reads denied."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time
import traceback
import zipfile


def main():
    analyzer, evidence, audit_path = map(Path, sys.argv[1:])
    analyzer, evidence, audit_path = analyzer.resolve(), evidence.resolve(), audit_path.resolve()
    packet = Path(__file__).resolve().parent
    allowed = [packet, Path(sys.base_prefix).resolve(), Path(sys.exec_prefix).resolve()]
    reads, denied = set(), []
    active = True

    def audit(event, arguments):
        if not active:
            return
        if event.startswith("socket.") or event in ("urllib.Request", "subprocess.Popen", "os.system", "os.posix_spawn", "os.exec"):
            denied.append(event)
            raise RuntimeError("Offline replay denied: " + event)
        if event != "open" or isinstance(arguments[0], int):
            return
        path = Path(os.fsdecode(arguments[0])).resolve()
        mode, flags = arguments[1:3]
        if (isinstance(mode, str) and any(char in mode for char in "wax+")) or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
            denied.append("write:" + str(path))
            raise RuntimeError("Archived analysis attempted a write")
        if not any(path.is_relative_to(root) for root in allowed):
            denied.append("external-read:" + str(path))
            raise RuntimeError("Archived analysis attempted an external file read: " + str(path))
        if path.is_relative_to(evidence):
            reads.add(path.relative_to(evidence).as_posix())

    sys.dont_write_bytecode = True
    sys.addaudithook(audit)
    sys.argv = [str(analyzer), "analyze", "--evidence", str(evidence)]
    status = 0
    try:
        runpy.run_path(str(analyzer), run_name="__main__")
    except SystemExit as error:
        status = error.code if isinstance(error.code, int) else 1
    except BaseException:
        traceback.print_exc()
        status = 1
    finally:
        active = False
        audit_path.write_text(json.dumps({"readFiles": sorted(reads), "deniedOperations": denied, "networkDenied": True, "childProcessesDenied": True, "externalDataReadsDenied": True, "writesDenied": True}, indent=2) + "\n")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
