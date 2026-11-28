"""Summarize a frozen hosted cell without replacing or filtering observations."""
import json
from pathlib import Path
import statistics
import sys

root = Path(sys.argv[1])
dictionary = sys.argv[2]
order = sys.argv[3]
result = {"dictionary": dictionary, "initialOrder": order, "complete": False,
          "scope": "One independent hosted cell; no pooled or control-adjusted result"}
analysis_path = root / "analysis.json"
if analysis_path.exists():
    analysis = json.loads(analysis_path.read_text())
    result["analysis"] = analysis
    observations = json.loads((root / "observations.json").read_text())
    result["ordinaryObservations"] = [
        {k: x[k] for k in ("id", "kind", "pair", "arm", "totalImportMs")}
        for x in observations
    ]
    b = [x["totalImportMs"] for x in observations if x["kind"] == "candidate" and x["arm"] == "B"]
    c = [x["totalImportMs"] for x in observations if x["kind"] == "control" and x["arm"] == "C"]
    paired = analysis["candidateVsBaseline"]
    controls = analysis["identicalCodeControl"]
    control_ok = controls["count"] == 4 and abs(controls["medianPairedChangePercent"]) <= 5
    complete = paired["count"] == 12 and len(b) == 12 and len(c) == 4
    correct = analysis["status"] == "correctness-memory-passed" and analysis["memoryPassed"]
    b_vs_c = (statistics.median(b) / statistics.median(c) - 1) * 100
    result["candidateMedianVsControlCPercent"] = b_vs_c
    result["complete"] = complete
    result["gates"] = {
        "correctnessAndMemory": correct,
        "completeSchedule": complete,
        "unchangedControls": control_ok,
        "nonRegression": complete and correct and control_ok and
            paired["medianPairedChangePercent"] <= 3 and
            paired["equalWorkChangePercent"] <= 3 and
            paired["descriptiveBootstrap95Percent"][1] <= 5,
        "wholeImportGain": complete and correct and control_ok and
            paired["medianPairedChangePercent"] <= -5 and b_vs_c <= -5 and
            paired["fasterPairs"] >= 10 and paired["equalWorkChangePercent"] < 0 and
            paired["descriptiveBootstrap95Percent"][1] < 0,
    }
else:
    result["failure"] = "No complete analysis; all setup/observation logs remain in the artifact"
target = root.parent / "cell-summary.json"
target.write_text(json.dumps(result, indent=2) + "\n")
print("PATH_QUALIFICATION_RESULT " + json.dumps(result, separators=(",", ":")))
