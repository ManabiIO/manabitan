"""Apply the prospective affinity rule, record it, then replace this process."""
import json
import os
from pathlib import Path
import sys

if len(sys.argv) < 4:
    raise SystemExit("Usage: python pin-cpu.py RECEIPT COMMAND ARG...")
allowed = sorted(os.sched_getaffinity(0))
if not allowed:
    raise RuntimeError("No allowed CPU")
selected = allowed[1] if len(allowed) > 1 else allowed[0]
os.sched_setaffinity(0, {selected})
receipt = {"initialAllowedCpus": allowed, "selectedCpu": selected,
           "activeCpus": sorted(os.sched_getaffinity(0)),
           "rule": "second allowed CPU, or sole CPU when only one is available"}
Path(sys.argv[1]).write_text(json.dumps(receipt, indent=2) + "\n")
os.execvp(sys.argv[2], sys.argv[2:])
