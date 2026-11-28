#!/usr/bin/env python3
"""Exact code/index parity guards for analysis-only WASM symbol recovery."""
import copy
import unittest

import recover


def uleb(value):
    output = bytearray()
    while True:
        byte = value & 127
        value >>= 7
        output.append(byte | (128 if value else 0))
        if not value:
            return bytes(output)


def section(kind, payload):
    return bytes([kind]) + uleb(len(payload)) + payload


def name(value):
    data = value.encode()
    return uleb(len(data)) + data


def baseline():
    return (b"\0asm\x01\0\0\0" +
            section(1, b"\x01\x60\x00\x00") +
            section(3, b"\x02\x00\x00") +
            section(7, b"\x01" + name("entry") + b"\x00\x00") +
            section(10, b"\x02\x02\x00\x0b\x02\x00\x0b"))


def names_section(entries=((0, "entry"), (1, "internal_crc"))):
    mapping = uleb(len(entries)) + b"".join(uleb(index) + name(value) for index, value in entries)
    return section(0, name("name") + b"\x01" + uleb(len(mapping)) + mapping)


class ParityTests(unittest.TestCase):
    def test_only_custom_names_change_and_indices_remain_exact(self):
        raw = baseline()
        names, proof = recover.recover_names(raw, raw + names_section())
        self.assertEqual(names, {0: "entry", 1: "internal_crc"})
        self.assertTrue(proof["everyOrderedNoncustomSectionByteIdentical"])
        self.assertEqual(proof["functionCount"], 2)
        self.assertEqual(proof["noncustomSectionCount"], 4)

    def test_any_code_byte_change_forbids_symbol_attribution(self):
        raw = baseline()
        changed = bytearray(raw)
        changed[-1] = 1
        with self.assertRaisesRegex(ValueError, "Noncustom WASM sections differ"):
            recover.recover_names(raw, bytes(changed) + names_section())

    def test_noncustom_section_reordering_is_not_treated_as_equal(self):
        raw = baseline()
        sections = recover.sections(raw)
        changed = raw[:8] + b"".join(item["raw"] for item in reversed(sections)) + names_section()
        with self.assertRaisesRegex(ValueError, "Noncustom WASM sections differ"):
            recover.recover_names(raw, changed)

    def test_unrelated_custom_section_does_not_change_code_identity(self):
        raw = baseline()
        named = raw + section(0, name("producers") + b"diagnostic-only") + names_section()
        names, proof = recover.recover_names(raw, named)
        self.assertEqual(names[1], "internal_crc")
        self.assertEqual([item["name"] for item in proof["namedCustomSections"]], ["producers", "name"])

    def test_duplicate_out_of_range_or_missing_names_are_rejected(self):
        raw = baseline()
        cases = [raw, raw + names_section(((0, "x"), (0, "y"))),
                 raw + names_section(((2, "x"),)), raw + names_section() + names_section()]
        for item in cases:
            with self.subTest(length=len(item)), self.assertRaises(ValueError):
                recover.recover_names(raw, item)

    def test_truncated_sections_and_wrong_magic_are_rejected(self):
        raw = baseline()
        for item in (raw + names_section()[:-1], b"bad!" + raw[4:]):
            with self.assertRaises(ValueError):
                recover.recover_names(raw, item)

    def test_sample_counts_and_weights_are_only_relabelled_after_identity(self):
        row = {
            "samples": 7, "adjacentWallUs": 1234,
            "frame": {"leaf": {"function": "wasm-function[1]"},
                      "context": {"module": recover.PARSER_MODULE, "moduleSha256": "a" * 64,
                                  "functionIndex": 1, "nearestExportedAncestor": {"functionIndex": 0},
                                  "nearestJsAncestor": {"function": "inflate"}}}
        }
        original = copy.deepcopy(row)
        analysis = {"roles": {"parser": {"wasmContextRows": [row]}}}
        output = recover.symbolize(analysis, {1: "internal_crc"}, "a" * 64)
        self.assertEqual(output[0]["samples"], 7)
        self.assertEqual(output[0]["adjacentWallUs"], 1234)
        self.assertEqual(output[0]["recoveredName"], "internal_crc")
        self.assertEqual(row, original)
        with self.assertRaisesRegex(ValueError, "Sampled parser module identity differs"):
            recover.symbolize(analysis, {1: "internal_crc"}, "b" * 64)


if __name__ == "__main__":
    unittest.main()
