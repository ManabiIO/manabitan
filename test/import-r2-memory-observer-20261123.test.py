"""Linux subprocess witnesses; no browser launch or import benchmark."""

import copy
import errno
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import importlib.util
import sys

OBSERVER_PATH = Path(__file__).resolve().parents[1] / "dev/perf/import-r2-memory-observer-20261123.py"
SPEC = importlib.util.spec_from_file_location("chromium_memory", OBSERVER_PATH)
sampler = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sampler
SPEC.loader.exec_module(sampler)


CHILD_SOURCE = r'''
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void *live_worker(void *unused) {
    (void)unused;
    for (;;) pause();
    return NULL;
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *mode = argv[1];
    const char *chrome = argv[2];
    const char *helper = argv[3];
    int browser = strncmp(mode, "browser", 7) == 0;
    if (strcmp(mode, "threaded") == 0) {
        pthread_t worker;
        if (pthread_create(&worker, NULL, live_worker, NULL) != 0) return 5;
        printf("threaded %ld\n", (long)getpid());
        fflush(stdout);
        pthread_exit(NULL);
    }
    if (browser || strcmp(mode, "renderer") == 0) {
        pid_t child = fork();
        if (child < 0) return 3;
        if (child == 0) {
            char title[4096];
            int renderer = browser;
            const char *program = renderer ? chrome : helper;
            snprintf(title, sizeof(title), "%s%s", program,
                     renderer ? " --type=renderer --witness-title=rewritten" : " arbitrary renamed descendant");
            char *arguments[] = {title, renderer ? "renderer" : "leaf", (char *)chrome, (char *)helper, NULL};
            execv(program, arguments);
            _exit(4);
        }
    }
    if (browser && strcmp(mode, "browser") != 0) {
        pid_t child = fork();
        if (child < 0) return 6;
        if (child == 0) {
            if (strcmp(mode, "browser-zombie") == 0) _exit(0);
            char *arguments[] = {"arbitrary threaded descendant", "threaded", (char *)chrome, (char *)helper, NULL};
            execv(helper, arguments);
            _exit(7);
        }
        if (strcmp(mode, "browser-zombie") == 0) printf("zombie %ld\n", (long)child);
    }
    printf("%s %ld\n", browser ? "browser" : mode, (long)getpid());
    fflush(stdout);
    for (;;) pause();
}
'''


def process_record(pid, parent, executable, argv):
    return {"pid": pid, "parentPid": parent, "startTimeTicks": pid * 10,
            "state": "S", "threadCount": 1, "executable": executable, "comm": "test",
            "argv": argv, "metadataReadErrors": []}


class ChromiumMemoryWitness(unittest.TestCase):
    def test_rewritten_titles_and_arbitrary_descendant(self):
        self.run_live_tree("browser")

    def test_actual_unreaped_zombie(self):
        self.run_live_tree("browser-zombie")

    def test_actual_zombie_leader_with_live_thread(self):
        self.run_live_tree("browser-threaded")

    def run_live_tree(self, mode):
        compiler = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
        self.assertIsNotNone(compiler, "A C compiler is required for the subprocess witness")
        with tempfile.TemporaryDirectory(prefix="chromium-memory-witness-") as temporary:
            directory = Path(temporary)
            source = directory / "witness.c"
            chrome = directory / "chrome"
            helper = directory / "unrelated-helper"
            source.write_text(CHILD_SOURCE)
            subprocess.run([compiler, "-O0", "-pthread", str(source), "-o", str(chrome)], check=True)
            shutil.copy2(chrome, helper)
            process = subprocess.Popen(
                [str(chrome) + " rewritten browser title", mode, str(chrome), str(helper)],
                executable=str(chrome), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True,
            )
            try:
                expected_count = 3 if mode == "browser" else 4
                output = b""
                deadline = time.monotonic() + 10
                while output.count(b"\n") < expected_count and time.monotonic() < deadline:
                    ready, _, _ = select.select([process.stdout], [], [], 0.1)
                    if ready:
                        data = os.read(process.stdout.fileno(), 4096)
                        if not data:
                            break
                        output += data
                self.assertEqual(output.count(b"\n"), expected_count, output.decode(errors="replace"))
                pids = {name: int(pid) for name, pid in (line.split() for line in output.decode().splitlines())}
                inventory = sampler.process_inventory()
                special = pids.get("zombie", pids.get("threaded"))
                if special is not None:
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        record = inventory["processes"].get(special, {})
                        if record.get("state") == "Z" and record.get("threadCount") == (2 if mode == "browser-threaded" else 1):
                            break
                        time.sleep(0.01)
                        inventory = sampler.process_inventory()
                    self.assertEqual(record.get("state"), "Z", record)
                    self.assertEqual(record.get("threadCount"), 2 if mode == "browser-threaded" else 1)
                tree = sampler.discover_tree(os.getpid(), inventory)
                selected = {item["pid"]: item for item in tree["processes"]}
                self.assertEqual(set(selected), set(pids.values()))
                self.assertEqual(selected[pids["browser"]]["browserSeedMatch"], "exe")
                self.assertEqual(selected[pids["renderer"]]["browserSeedMatch"], "exe")
                self.assertEqual(selected[pids["renderer"]]["role"], "renderer")
                self.assertIsNone(selected[pids["leaf"]]["browserSeedMatch"])
                self.assertEqual(selected[pids["leaf"]]["role"], "descendant-unknown")
                # This is the exact title shape rejected by the old predicate.
                self.assertNotIn(Path(selected[pids["renderer"]]["argv"][0]).name, sampler.BROWSER_NAMES)
                sample = sampler.sample_memory(os.getpid())
                qualified = mode != "browser-threaded"
                self.assertEqual(sample["qualifiedForWholeTreePss"], qualified, sample["qualificationFailures"])
                self.assertEqual({item["pid"] for item in sample["processes"]}, set(pids.values()) - ({special} if special is not None else set()))
                unavailable = sample["unavailableProcesses"]
                self.assertEqual({item["pid"] for item in unavailable}, {special} if special is not None else set())
                if special is not None:
                    self.assertEqual(unavailable[0]["smapsReadError"]["errno"], errno.ESRCH)
                    self.assertEqual(unavailable[0]["threadCount"], 2 if mode == "browser-threaded" else 1)
                self.assertEqual(len(sample["confirmedExitedZombies"]), int(mode == "browser-zombie"))
                self.assertEqual(len(sample["unreadableAddressSpaces"]), int(mode == "browser-threaded"))
                self.assertGreater(sample["readableProcessPssKiB"], 0)
                summary = sampler.summarize_samples([sample], 0)
                self.assertEqual(summary["qualifiedForWholeTreePss"], qualified)
                self.assertEqual(summary["observedProcessCountRange"], [3, 3] if qualified else [0, 0])
                self.assertEqual(summary["confirmedExitedZombieObservationCount"], int(mode == "browser-zombie"))
                if not qualified:
                    self.assertIsNone(summary["maxSampledPssKiB"])
                    self.assertIsNone(summary["maxSampledPrivateKiB"])
                print(json.dumps({
                    "kind": "live-process-tree-witness",
                    "mode": mode,
                    "unavailableProcesses": unavailable,
                    "confirmedExitedZombies": sample["confirmedExitedZombies"],
                    "unreadableAddressSpaces": sample["unreadableAddressSpaces"],
                    "processes": sample["processes"],
                    "observedRoles": sample["observedRoles"],
                    "qualifiedForWholeTreePss": sample["qualifiedForWholeTreePss"],
                    "readableProcessPssKiB": sample["readableProcessPssKiB"],
                    "readableProcessPrivateKiB": sample["readableProcessPrivateKiB"],
                }), flush=True)
            finally:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

    def test_zombie_exemption_fails_closed(self):
        before = process_record(22, 20, None, [])
        before.update(state="Z", metadataReadErrors=[{"field": "executable", "errno": errno.ENOENT}],
                      smapsReadError={"errno": errno.ESRCH})
        after = copy.deepcopy(before)
        after.pop("smapsReadError")
        self.assertTrue(sampler.confirmed_exited_zombie(before, after))
        self.assertFalse(sampler.confirmed_exited_zombie(before, None))
        mutations = [
            ("live-before", "before", "state", "S"),
            ("live-after", "after", "state", "S"),
            ("two-threads-before", "before", "threadCount", 2),
            ("two-threads-after", "after", "threadCount", 2),
            ("unknown-threads-before", "before", "threadCount", None),
            ("unknown-threads-after", "after", "threadCount", None),
            ("changed-pid", "after", "pid", 23),
            ("missing-pid", "before", "pid", None),
            ("changed-starttime", "after", "startTimeTicks", 999),
            ("missing-starttime-before", "before", "startTimeTicks", None),
            ("missing-starttime-after", "after", "startTimeTicks", None),
            ("executable-before", "before", "executable", "/opt/helper"),
            ("executable-after", "after", "executable", "/opt/helper"),
            ("no-exe-error-before", "before", "metadataReadErrors", []),
            ("no-exe-error-after", "after", "metadataReadErrors", []),
            ("exe-permission-before", "before", "metadataReadErrors", [{"field": "executable", "errno": errno.EACCES}]),
            ("exe-permission-after", "after", "metadataReadErrors", [{"field": "executable", "errno": errno.EACCES}]),
            ("smaps-permission", "before", "smapsReadError", {"errno": errno.EACCES}),
            ("smaps-enoent", "before", "smapsReadError", {"errno": errno.ENOENT}),
            ("smaps-unknown", "before", "smapsReadError", {}),
        ]
        for name, side, field, value in mutations:
            with self.subTest(name=name):
                cases = {"before": copy.deepcopy(before), "after": copy.deepcopy(after)}
                if value is None:
                    cases[side].pop(field)
                else:
                    cases[side][field] = value
                self.assertFalse(sampler.confirmed_exited_zombie(cases["before"], cases["after"]))

    def test_argv_fallback_and_denied_descendant_smaps(self):
        inventory = {"identityReadErrors": [], "processes": {
            10: process_record(10, 1, "/usr/bin/python3", ["python3"]),
            20: process_record(20, 10, None, ["/opt/chrome rewritten browser title"]),
            21: process_record(21, 20, "/opt/chrome", ["/opt/chrome --type=renderer"]),
            22: process_record(22, 21, "/opt/unrelated-helper", ["renamed helper"]),
        }}
        self.assertEqual(sampler.browser_identity(inventory["processes"][20]), "argv0-fallback")
        tree = sampler.discover_tree(10, inventory)
        self.assertEqual([item["pid"] for item in tree["processes"]], [20, 21, 22])

        def read(pid, _proc):
            if pid == 22:
                raise PermissionError(errno.EACCES, "witness denied smaps")
            return {"pssKiB": 10, "rssKiB": 20, "privateKiB": 5}

        with patch.object(sampler, "process_inventory", return_value=inventory), patch.object(sampler, "read_smaps", side_effect=read):
            denied = sampler.sample_memory(10)
        self.assertTrue(denied["stableObservedProcessTree"])
        self.assertEqual(denied["observedRoles"], ["browser", "renderer"])
        self.assertFalse(denied["qualifiedForWholeTreePss"])
        self.assertIn("unreadable-discovered-process-smaps", denied["qualificationFailures"])
        self.assertEqual(denied["unavailableProcesses"][0]["pid"], 22)
        with patch.object(sampler, "process_inventory", return_value=inventory), patch.object(sampler, "read_smaps", return_value={"pssKiB": 10, "rssKiB": 20, "privateKiB": 5}):
            good = sampler.sample_memory(10)
        self.assertTrue(good["qualifiedForWholeTreePss"])
        summary = sampler.summarize_samples([good, denied], 0)
        self.assertFalse(summary["qualifiedForWholeTreePss"])
        self.assertIn("process-smaps-coverage-unqualified", summary["qualificationFailures"])
        self.assertIsNone(summary["maxSampledPssKiB"])
        self.assertIsNone(summary["maxSampledPrivateKiB"])
        self.assertEqual(summary["sampleCount"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
