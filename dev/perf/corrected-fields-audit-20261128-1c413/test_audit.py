"""Pure checks for the reconstructed auditor; no product or network execution."""
import copy
import struct
import unittest
import zipfile

import audit_fields as fields
from transport import AuditError, inspect_zip, parse_json, safe_name

class FakeArchive:
    def __init__(self, entries):
        self.entries = entries

    def infolist(self):
        return self.entries

class AuditTests(unittest.TestCase):
    def test_json_numbers_keys_and_boolean_identity(self):
        for value in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}'):
            with self.assertRaises((AuditError, ValueError)):
                parse_json(value)
        self.assertEqual(parse_json('{"x":1e2}')["x"], 100)
        self.assertFalse(fields.same_json(True, 1))
        self.assertFalse(fields.same_json({"flag": 0}, {"flag": False}))
        self.assertTrue(fields.same_json(1.0, 1))

    def test_canonical_archive_names(self):
        for name in (".", "./", "a//", "a//b", "a/./b", "../a", "/a", "C:/a", "a\\b", "a\0b"):
            with self.subTest(name=name), self.assertRaises(AuditError):
                safe_name(name)
        self.assertEqual(str(safe_name("a/b/")), "a/b")
        self.assertEqual(str(safe_name("a/b")), "a/b")

    def test_archive_collision_and_directory_payload(self):
        cases = [
            [zipfile.ZipInfo("a"), zipfile.ZipInfo("a")],
            [zipfile.ZipInfo("a"), zipfile.ZipInfo("a/")],
            [zipfile.ZipInfo("a"), zipfile.ZipInfo("a/b/")],
            [zipfile.ZipInfo("a"), zipfile.ZipInfo("a/b")],
            [zipfile.ZipInfo("a\0ignored")],
        ]
        payload = zipfile.ZipInfo("directory/")
        payload.file_size = 1
        cases.append([payload])
        disguised = zipfile.ZipInfo("directory/")
        disguised.external_attr = 0o100644 << 16
        cases.append([disguised])
        link = zipfile.ZipInfo("link")
        link.external_attr = 0o120777 << 16
        cases.append([link])
        for entries in cases:
            with self.subTest(names=[entry.orig_filename for entry in entries]), self.assertRaises(AuditError):
                inspect_zip(FakeArchive(entries))
        valid = [zipfile.ZipInfo("a/"), zipfile.ZipInfo("a/b")]
        self.assertEqual(len(inspect_zip(FakeArchive(valid))), 2)

    def test_exact_schedule_and_balance(self):
        schedule = fields.expected_schedule()
        self.assertEqual(len(schedule), 42)
        self.assertEqual([row["arm"] for row in schedule[:6]], list("ABCCBA"))
        self.assertEqual([row["mode"] for row in schedule[:6]], ["untimed"] * 6)
        self.assertEqual([row["mode"] for row in schedule[6:]], ["timed"] * 36)
        for counts in fields.schedule_balance()["positions"].values():
            self.assertEqual(counts, [4, 4, 4])
        self.assertEqual(set(fields.schedule_balance()["withinBlockTransitions"].values()), {4})

    def test_raw_clocks_are_independently_recomputed(self):
        timing = {"cpuBefore": {"user": 1000, "system": 100}, "cpuAfter": {"user": 9000, "system": 2100},
                  "cpuUserMicros": 8000, "cpuSystemMicros": 2000, "cpuMs": 10,
                  "wallBeforeNs": "1234567890123456", "wallAfterNs": "1234567910123456", "wallMs": 20}
        self.assertEqual(fields.raw_timing(timing), {"cpuMs": 10, "wallMs": 20})
        for key, value in (("cpuMs", 1), ("wallMs", 1), ("cpuUserMicros", 7999),
                           ("wallAfterNs", timing["wallBeforeNs"]), ("cpuSystemMicros", True)):
            altered = copy.deepcopy(timing)
            altered[key] = value
            with self.subTest(key=key), self.assertRaises(AuditError):
                fields.raw_timing(altered)
        altered = copy.deepcopy(timing)
        altered["cpuBefore"]["user"] = True
        with self.assertRaises(AuditError):
            fields.raw_timing(altered)

    def test_compact_record_vector_and_bounds(self):
        rows = 6
        expected = (struct.pack("<4Ii", 0x3246524d, rows, 1, 2, -7)
                    + struct.pack("<6I", 0, 0xffffffff, 0, 0xffffffff, 0, 0xffffffff)
                    + struct.pack("<6H", 3, 0, 3, 0, 3, 0)
                    + struct.pack("<6H", 0, 0, 0, 0, 0, 0))
        call = {"rowCount": rows, "contentOffsetBase": 1000, "scoreCount": 1}
        columns = {"uniqueIndexes": [0, 1, 0, 1, 0, 1], "scores": [-7] * rows,
                   "resolvedOffsets": [1000.0, -1.0], "resolvedLengths": [3, 0], "output": expected}
        output, stats = fields.reconstruct(call, columns, 131072)
        self.assertEqual(output, expected)
        self.assertEqual(stats["inputCopiedBytes"], 72)
        self.assertEqual(stats["outputCopiedBytes"], 68)
        self.assertEqual(stats["memoryGrowthBytes"], 65536)
        for name, changed in (("uniqueIndexes", [2] * rows), ("resolvedLengths", [65535, 0]),
                              ("resolvedOffsets", [1000.5, -1.0]), ("output", bytes(len(expected)))):
            altered = dict(columns)
            altered[name] = changed
            with self.subTest(name=name), self.assertRaises(AuditError):
                fields.reconstruct(call, altered, 131072)

    def test_both_controls_absolute_saving_and_stability_gate(self):
        good = {"medianPercent": -25, "medianSaving": 6, "fasterPairs": 10, "equalWorkPercent": -25}
        control = {"medianPercent": 0.2, "medianSaving": 0, "fasterPairs": 6, "equalWorkPercent": 0.3}
        contrasts = {"cpuMs": {"BoverA": dict(good), "BoverC": dict(good), "CoverA": control}}
        self.assertTrue(all(fields.gate_checks(contrasts).values()))
        changes = [("BoverA", "medianPercent", -19.999), ("BoverC", "medianPercent", -19.999),
                   ("BoverA", "medianSaving", 4.999), ("BoverC", "medianSaving", 4.999),
                   ("BoverA", "fasterPairs", 8), ("BoverC", "fasterPairs", 8),
                   ("CoverA", "medianPercent", -3.001), ("CoverA", "equalWorkPercent", 3.001)]
        for arm, key, value in changes:
            altered = copy.deepcopy(contrasts)
            altered["cpuMs"][arm][key] = value
            with self.subTest(arm=arm, key=key):
                self.assertFalse(all(fields.gate_checks(altered).values()))

if __name__ == "__main__":
    unittest.main()
