"""Frozen full public readback and physical-layout qualification rules."""

import re


def differences(a, b, location=""):
    if type(a) is not type(b):
        return [{"path": location, "baseline": a, "candidate": b}]
    if isinstance(a, dict):
        if a.keys() != b.keys():
            return [{"path": location, "baseline": a, "candidate": b}]
        return [item for key in a for item in differences(a[key], b[key], location + "/" + key)]
    if isinstance(a, list):
        if len(a) != len(b):
            return [{"path": location, "baseline": a, "candidate": b}]
        return [item for index, (x, y) in enumerate(zip(a, b))
                for item in differences(x, y, location + "/" + str(index))]
    return [] if a == b else [{"path": location, "baseline": a, "candidate": b}]


def verify_preview_counts(probes):
    for term in probes:
        for probe in term["probes"]:
            rows = probe["rowSample"]
            if probe["rowSampleCount"] != len(rows):
                raise ValueError("Physical probe row count mismatch")
            previews = [row["rawContentPreview"] for row in rows]
            if any(value is not None and not isinstance(value, str) for value in previews):
                raise ValueError("Invalid raw preview type")
            readable = sum(isinstance(value, str) and len(value) > 0 and
                           value not in ("<read-null>", "<read-failed>") for value in previews)
            if probe["readablePreviewRowCount"] != readable:
                raise ValueError("Raw preview count derivation mismatch")


def validate_readback(report, validation, fixture):
    if report["status"] != "success" or report["skippedVerification"] is not False:
        raise ValueError("Failed or skipped browser validation")
    if report["benchmark"]["validation"] != validation:
        raise ValueError("Summary and retained report validation differ")
    if (validation["title"] != fixture["expectedTitle"] or validation["revision"] != fixture["revision"] or
            validation["termRows"] != fixture["termRows"] or validation["contentReadable"] is not True or
            validation["probeCount"] < 12 or
            ("mediaRows" in fixture and validation["mediaRows"] != fixture["mediaRows"])):
        raise ValueError("Pinned fixture/readback mismatch")
    for state_name in ("preRestart", "postRestart"):
        state = report["benchmark"]["readbackDiagnostics"][state_name]
        if (state["physicalProbes"] != validation["physicalProbes"] or
                state["physicalDigestSha256"] != validation["outputDigestSha256"] or
                state["semanticProbes"] != validation["semanticProbes"] or
                state["semanticDigestSha256"] != validation["semanticDigestSha256"]):
            raise ValueError("Complete physical/semantic readback changed across restart")
        verify_preview_counts(state["physicalProbes"])
        semantic = state["semanticProbes"]
        if len(semantic) != validation["probeCount"] or [item["term"] for item in semantic] != validation["probeTerms"]:
            raise ValueError("Semantic probes do not match requested terms")
        for item in semantic:
            result = item["result"]
            if not result["dictionaryEntries"] or result.get("dictionaryAvailability"):
                raise ValueError("Empty or degraded semantic result")
        if sum(len(item["result"]["dictionaryEntries"]) for item in semantic) != validation["semanticProbeEntryCount"]:
            raise ValueError("Semantic entry count mismatch")


def verify_cross_arm(observations, expected_counts, layout_rules):
    actual_counts = {arm: sum(item["arm"] == arm for item in observations) for arm in expected_counts}
    if actual_counts != expected_counts or len(observations) != sum(expected_counts.values()):
        raise ValueError("Missing or unexpected fixed observation")
    validations = [item["validation"] for item in observations]
    for key in ("semanticDigestSha256", "outputDigestSha256"):
        if any(re.fullmatch(r"[0-9a-f]{64}", value[key]) is None for value in validations):
            raise ValueError("Invalid readback digest")
    semantic = validations[0]["semanticProbes"]
    if any(value["semanticProbes"] != semantic or
           value["semanticDigestSha256"] != validations[0]["semanticDigestSha256"] for value in validations):
        raise ValueError("Complete public semantic results changed between arms")
    physical, physical_digests = {}, {}
    for arm in expected_counts:
        selected = [item["validation"] for item in observations if item["arm"] == arm]
        if any(item["physicalProbes"] != selected[0]["physicalProbes"] or
               item["outputDigestSha256"] != selected[0]["outputDigestSha256"] for item in selected):
            raise ValueError("Physical readback changed within the same package")
        physical[arm] = selected[0]["physicalProbes"]
        physical_digests[arm] = selected[0]["outputDigestSha256"]
    changes_by_comparison = {}
    for rule in layout_rules:
        a_arm, b_arm = rule["baseline"], rule["candidate"]
        changes = differences(physical[a_arm], physical[b_arm])
        changes_by_comparison[a_arm + "-" + b_arm] = changes
        if changes and not rule["allowReferenceLayoutChange"]:
            raise ValueError("Unexpected physical layout change for " + a_arm + "-" + b_arm)
        for change in changes:
            location = change["path"]
            if re.fullmatch(r"/\d+/probes/\d+/rowSample/\d+/(rawEntryContentOffset|rawContentPreview)", location):
                continue
            match = re.fullmatch(r"/(\d+)/probes/(\d+)/readablePreviewRowCount", location)
            if match:
                a = physical[a_arm][int(match[1])]["probes"][int(match[2])]
                b = physical[b_arm][int(match[1])]["probes"][int(match[2])]
                if any(x["rawContentPreview"] != y["rawContentPreview"] for x, y in zip(a["rowSample"], b["rowSample"])):
                    continue
            raise ValueError("Unexplained physical difference: " + location)
    return {"semanticDigestSha256": validations[0]["semanticDigestSha256"],
            "physicalDigests": physical_digests, "differences": changes_by_comparison}
