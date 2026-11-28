"""Proof-parser tests only; no compiler, imports, or product edits are run."""

import pathlib
import subprocess
import unittest

import symbol_map


def u32(value):
    result = bytearray()
    while True:
        part, value = value & 127, value >> 7
        result.append(part | (128 if value else 0))
        if not value:
            return bytes(result)


def name(value):
    data = value.encode()
    return u32(len(data)) + data


def section(kind, payload):
    return bytes([kind]) + u32(len(payload)) + payload


def sample(names=((0, "run"),), body=b"\x00\x0b"):
    result = b"\x00asm\x01\x00\x00\x00"
    result += section(1, b"\x01\x60\x00\x00")
    result += section(3, b"\x01\x00")
    result += section(7, b"\x01" + name("run") + b"\x00\x00")
    result += section(10, b"\x01" + u32(len(body)) + body)
    if names is not None:
        payload = u32(len(names)) + b"".join(u32(index) + name(value) for index, value in names)
        result += section(0, name("name") + section(1, payload))
    return result


class SymbolMapTests(unittest.TestCase):
    def test_custom_names_map_to_unchanged_body_and_export(self):
        proof = symbol_map.prove_mapping(sample(names=None), sample())
        self.assertTrue(proof["noncustomSectionsEqual"])
        self.assertEqual(proof["functions"][0]["index"], 0)
        self.assertEqual(proof["functions"][0]["name"], "run")
        self.assertEqual(proof["functions"][0]["exports"], ["run"])
        self.assertEqual(proof["functions"][0]["bodySha256"], symbol_map.sha256(b"\x00\x0b"))
        self.assertNotEqual(proof["strippedSha256"], proof["namedSha256"])

    def test_unrelated_custom_sections_do_not_affect_proof(self):
        named = sample() + section(0, name("producers") + b"diagnostic metadata")
        self.assertTrue(symbol_map.prove_mapping(sample(names=None), named)["noncustomSectionsEqual"])

    def test_executable_change_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "sections differ"):
            symbol_map.prove_mapping(sample(names=None), sample(body=b"\x00\x01\x0b"))

    def test_missing_duplicate_and_out_of_range_names_are_rejected(self):
        for names in (None, (), ((0, "a"), (0, "b")), ((1, "outside"),)):
            with self.subTest(names=names), self.assertRaises(ValueError):
                symbol_map.prove_mapping(sample(names=None), sample(names=names))

    def test_truncated_and_overflowing_structures_are_rejected(self):
        for data in (b"", sample()[:-1], sample() + b"\x00\xff\xff\xff\xff\x10"):
            with self.subTest(data=data), self.assertRaises(ValueError):
                symbol_map.sections(data)

    def test_duplicate_noncustom_section_is_rejected(self):
        with self.assertRaises(ValueError):
            symbol_map.sections(sample() + section(3, b"\x01\x00"))

    def test_unexpected_function_import_is_rejected(self):
        imported = section(2, b"\x01" + name("env") + name("call") + b"\x00\x00")
        data = sample()
        with self.assertRaisesRegex(ValueError, "non-memory import"):
            symbol_map.function_metadata(data[:8] + imported + data[8:])

    def test_exact_frozen_modules_confirm_export_indices(self):
        root = pathlib.Path.cwd()
        expected = {"term-bank-parser.wasm": (36, "parse_and_encode_term_bank_token_binary_dedup"),
                    "term-content-canonical-scan-v1.wasm": (4, "scan_canonical")}
        for filename, (index, exported) in expected.items():
            data = subprocess.check_output(["git", "-C", str(root), "show",
                                            f"{symbol_map.BASE}:dev/data/dictionary-wasm/{filename}"])
            with self.subTest(filename=filename):
                self.assertEqual(symbol_map.sha256(data), symbol_map.MODULE_HASHES[filename])
                functions = symbol_map.function_metadata(data, require_names=False)
                self.assertIn(exported, functions[index]["exports"])
                self.assertTrue(all(row["name"] is None for row in functions))


if __name__ == "__main__":
    unittest.main()
