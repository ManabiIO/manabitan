"""Linux subprocess witnesses; no browser launch or import benchmark."""

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

import chromium_memory as sampler


CHILD_SOURCE = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *mode = argv[1];
    const char *chrome = argv[2];
    const char *helper = argv[3];
    if (strcmp(mode, "browser") == 0 || strcmp(mode, "renderer") == 0) {
        pid_t child = fork();
        if (child < 0) return 3;
        if (child == 0) {
            char title[4096];
            int renderer = strcmp(mode, "browser") == 0;
            const char *program = renderer ? chrome : helper;
            snprintf(title, sizeof(title), "%s%s", program,
                     renderer ? " --type=renderer --witness-title=rewritten" : " arbitrary renamed descendant");
            char *arguments[] = {title, renderer ? "renderer" : "leaf", (char *)chrome, (char *)helper, NULL};
            execv(program, arguments);
            _exit(4);
        }
    }
    printf("%s %ld\n", mode, (long)getpid());
    fflush(stdout);
    for (;;) pause();
}
'''


def process_record(pid, parent, executable, argv):
    return {"pid": pid, "parentPid": parent, "startTimeTicks": pid * 10,
            "state": "S", "executable": executable, "comm": "test",
            "argv": argv, "metadataReadErrors": []}


class ChromiumMemoryWitness(unittest.TestCase):
    def test_rewritten_titles_and_arbitrary_descendant(self):
        compiler = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
        self.assertIsNotNone(compiler, "A C compiler is required for the subprocess witness")
        with tempfile.TemporaryDirectory(prefix="chromium-memory-witness-") as temporary:
            directory = Path(temporary)
            source = directory / "witness.c"
            chrome = directory / "chrome"
            helper = directory / "unrelated-helper"
            source.write_text(CHILD_SOURCE)
            subprocess.run([compiler, "-O0", str(source), "-o", str(chrome)], check=True)
            shutil.copy2(chrome, helper)
            process = subprocess.Popen(
                [str(chrome) + " rewritten browser title", "browser", str(chrome), str(helper)],
                executable=str(chrome), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True,
            )
            try:
                output = b""
                deadline = time.monotonic() + 10
                while output.count(b"\n") < 3 and time.monotonic() < deadline:
                    ready, _, _ = select.select([process.stdout], [], [], 0.1)
                    if ready:
                        data = os.read(process.stdout.fileno(), 4096)
                        if not data:
                            break
                        output += data
                self.assertEqual(output.count(b"\n"), 3, output.decode(errors="replace"))
                pids = {name: int(pid) for name, pid in (line.split() for line in output.decode().splitlines())}
                inventory = sampler.process_inventory()
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
                self.assertTrue(sample["qualifiedForWholeTreePss"], sample["qualificationFailures"])
                self.assertEqual({item["pid"] for item in sample["processes"]}, set(pids.values()))
                self.assertGreater(sample["readableProcessPssKiB"], 0)
                summary = sampler.summarize_samples([sample], 0)
                self.assertTrue(summary["qualifiedForWholeTreePss"])
                self.assertEqual(summary["observedProcessCountRange"], [3, 3])
                print(json.dumps({
                    "kind": "live-process-tree-witness",
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
