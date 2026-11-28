"""Run one fixed forward/reverse staging-allocation cohort in fresh processes."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--workspace", type=Path, required=True)
parser.add_argument("--archive", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
node = shutil.which("node")
assert node
schedule = ["baseline", "parent", "followup", "followup", "parent", "baseline"]
roots = {"baseline": "bench-baseline", "parent": "media-parent", "followup": "media-work"}
runner = args.workspace / "media-evidence" / "replay.mjs"
manifest = {
    "scope": "Forced-GC retained heap and external memory before the first media payload read; not peak memory or import latency",
    "schedule": schedule,
    "node": node,
    "attempts": [],
}
manifest_path = args.output / "cohort.json"
with manifest_path.open("x") as out:
    out.write(json.dumps(manifest, indent=2) + "\n")
for ordinal, arm in enumerate(schedule, 1):
    output = args.output / f"{ordinal}-{arm}.json"
    command = [node, "--expose-gc", str(runner), str(args.workspace / roots[arm]), str(args.archive), "baseline" if arm == "baseline" else "candidate", str(output), "allocation"]
    completed = subprocess.run(command, capture_output=True, text=True)
    (args.output / f"{ordinal}-{arm}.stdout.log").write_text(completed.stdout)
    (args.output / f"{ordinal}-{arm}.stderr.log").write_text(completed.stderr)
    manifest["attempts"].append({"ordinal": ordinal, "arm": arm, "exitCode": completed.returncode, "output": output.name})
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest["attempts"][-1]), flush=True)
    if completed.returncode != 0:
        sys.exit(completed.returncode)
