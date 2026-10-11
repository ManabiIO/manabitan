"""
Direct tests for the MDX native helper and converter.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Tuple
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit


_MODULE_DIR = Path(__file__).resolve().parent
_MDX_REGISTRY: Dict[str, Dict[str, object]] = {}
_MDD_REGISTRY: Dict[str, List[Tuple[bytes, bytes]]] = {}


def _normalize_registry_key(path: str | Path) -> str:
    return str(Path(path))


def _install_pyglossary_stub() -> None:
    if "pyglossary.plugin_lib.readmdict" in sys.modules:
        return

    pyglossary_module = types.ModuleType("pyglossary")
    plugin_lib_module = types.ModuleType("pyglossary.plugin_lib")
    readmdict_module = types.ModuleType("pyglossary.plugin_lib.readmdict")

    class FakeMDX:
        def __init__(self, path: str, *_args: object) -> None:
            data = _MDX_REGISTRY[_normalize_registry_key(path)]
            self.header = dict(data.get("header", {}))
            self._items = list(data.get("items", []))

        def items(self) -> Iterator[Tuple[bytes, bytes]]:
            for term, definition in self._items:
                yield term.encode("utf-8"), definition.encode("utf-8")

    class FakeMDD:
        def __init__(self, path: str) -> None:
            self._items = list(_MDD_REGISTRY[_normalize_registry_key(path)])

        def items(self) -> Iterator[Tuple[bytes, bytes]]:
            yield from self._items

    readmdict_module.MDX = FakeMDX
    readmdict_module.MDD = FakeMDD
    plugin_lib_module.readmdict = readmdict_module
    pyglossary_module.plugin_lib = plugin_lib_module
    sys.modules["pyglossary"] = pyglossary_module
    sys.modules["pyglossary.plugin_lib"] = plugin_lib_module
    sys.modules["pyglossary.plugin_lib.readmdict"] = readmdict_module


def _load_module(module_name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load module {module_name} from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_install_pyglossary_stub()
mdx_to_yomitan = _load_module("mdx_to_yomitan", _MODULE_DIR / "mdx_to_yomitan.py")
native_host = _load_module("native_host_under_test", _MODULE_DIR / "native_host.py")


def _register_mdx(path: Path, *, header: Dict[bytes, bytes], items: Iterable[Tuple[str, str]]) -> None:
    _MDX_REGISTRY[_normalize_registry_key(path)] = {
        "header": header,
        "items": list(items),
    }


def _register_mdd(path: Path, items: Iterable[Tuple[bytes, bytes]]) -> None:
    _MDD_REGISTRY[_normalize_registry_key(path)] = list(items)


class MdxToYomitanTests(unittest.TestCase):

    def test_composed_inline_scope_font_hints_and_chained_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mdx = root / "combined.mdx"
            output = root / "combined.zip"
            mdx.write_bytes(b"mdx")
            _register_mdx(mdx, header={}, items=[
                ("main", '<style>.entry {color:blue}</style><font class="entry" size="+2" color="red" style="color:green">Japanese</font>'),
                ("direct", "@@@LINK=main"),
                ("chain", "@@@LINK=direct"),
                ("other", '<style>.entry {color:purple}</style><font class="entry" size="-1">Other</font>'),
            ])
            mdx_to_yomitan.convert_mdx_to_yomitan_zip(
                mdx, output, options=mdx_to_yomitan.ConvertOptions(), explicit_mdds=[],
            )
            with zipfile.ZipFile(output) as archive:
                entries = {row[0]: row for row in json.loads(archive.read("term_bank_1.json"))}
                css = archive.read("styles.css").decode()
            self.assertEqual(set(entries), {"main", "direct", "chain", "other"})
            for alias in ("direct", "chain"):
                self.assertEqual(entries[alias][5:7], entries["main"][5:7])
            main = entries["main"][5][0]["content"]
            other = entries["other"][5][0]["content"]
            self.assertNotEqual(main["data"]["class"], other["data"]["class"])
            self.assertEqual(main["content"][0]["style"], {"color": "green", "fontSize": "x-large"})
            self.assertEqual(other["content"][0]["style"]["fontSize"], "small")
            for sequence, color in ((0, "blue"), (1, "purple")):
                scope = f'[data-sc-class~="mdict-yomitan-entry-{sequence}"]'
                guard = f':where({scope}, {scope} *)'
                self.assertIn(f'[data-sc-class~="entry"]{guard}{{color:{color}}}', css)

    def test_convert_preserves_chained_redirect_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "redirects.mdx"
            output = root / "redirects.zip"
            source.write_bytes(b"MDX")
            _register_mdx(source, header={b"Title": b"Redirects"}, items=[
                ("main", "first definition"),
                ("main", "second definition"),
                ("direct", "@@@LINK=main"),
                ("chain", "@@@LINK=direct"),
                ("chain", "@@@LINK=direct"),
                ("deep", "@@@LINK=chain"),
                ("direct", "@@@LINK=deep"),
                ("cycle-a", "@@@LINK=cycle-b"),
                ("cycle-b", "@@@LINK=cycle-a"),
                ("missing", "@@@LINK=absent"),
                ("other", "other definition"),
            ])
            mdx_to_yomitan.convert_mdx_to_yomitan_zip(
                source, output, options=mdx_to_yomitan.ConvertOptions(include_assets=False)
            )
            with zipfile.ZipFile(output) as archive:
                rows = json.loads(archive.read("term_bank_1.json"))
            self.assertEqual([row[0] for row in rows],
                             ["main", "direct", "chain", "deep"] * 2 + ["other"])
            self.assertEqual([row[6] for row in rows], [0] * 4 + [1] * 4 + [2])
            for group in [rows[:4], rows[4:8]]:
                for row in group[1:]:
                    self.assertEqual(row[5], group[0][5])


    def test_nonempty_source_rejects_zero_usable_definitions(self) -> None:
        cases = [
            [("alias", "@@@LINK=missing")],
            [("a", "@@@LINK=b"), ("b", "@@@LINK=a")],
            [(" ", "definition")],
        ]
        for items in cases:
            with self.subTest(items=items), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source = root / "fixture.mdx"
                source.write_bytes(b"MDX")
                _register_mdx(source, header={b"Title": b"No definitions"}, items=items)
                with self.assertRaisesRegex(ValueError, "no usable non-redirect entries"):
                    mdx_to_yomitan.convert_mdx_to_yomitan_zip(
                        source, root / "fixture.zip",
                        options=mdx_to_yomitan.ConvertOptions(include_assets=False),
                    )


    def test_zero_usable_guard_preserves_empty_source_and_mixed_entries(self) -> None:
        cases = [([], []), (
            [("alias", "@@@LINK=missing"), (" ", "ignored"), ("healthy", "")],
            ["healthy"],
        )]
        for items, expressions in cases:
            with self.subTest(items=items), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source = root / "fixture.mdx"
                output = root / "fixture.zip"
                source.write_bytes(b"MDX")
                _register_mdx(source, header={b"Title": b"Control"}, items=items)
                mdx_to_yomitan.convert_mdx_to_yomitan_zip(
                    source, output, options=mdx_to_yomitan.ConvertOptions(include_assets=False),
                )
                with zipfile.ZipFile(output) as archive:
                    rows = json.loads(archive.read("term_bank_1.json")) if expressions else []
                    self.assertEqual([row[0] for row in rows], expressions)
                    self.assertIn("index.json", archive.namelist())


    def test_data_url_decoding_preserves_omitted_type_and_escaped_base64(self) -> None:
        for value, media_type, expected in [
            ("data:;base64,UE5H", "text/plain", b"PNG"),
            ("data:;charset=utf-8;base64,UE5H", "text/plain", b"PNG"),
            ("data:image/png;base64,%2B%2F8%3D", "image/png", b"\xfb\xff"),
            ("data:image/png;base64,UE5H", "image/png", b"PNG"),
            ("data:,hello%20world", "text/plain", b"hello world"),
        ]:
            with self.subTest(value=value):
                self.assertEqual(mdx_to_yomitan._decode_data_url(value), (media_type, expected))


    def test_escaped_base64_image_keeps_exact_archive_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "image.mdx"
            output = root / "image.zip"
            source.write_bytes(b"MDX")
            _register_mdx(source, header={b"Title": b"Image"}, items=[
                ("image", '<img src="data:image/png;base64,%2B%2F8%3D">'),
            ])
            mdx_to_yomitan.convert_mdx_to_yomitan_zip(
                source, output, options=mdx_to_yomitan.ConvertOptions(include_assets=False),
            )
            with zipfile.ZipFile(output) as archive:
                rows = json.loads(archive.read("term_bank_1.json"))
                image = rows[0][5][0]["content"]["content"][0]
                self.assertEqual(image["tag"], "img")
                self.assertEqual(archive.read(image["path"]), b"\xfb\xff")


    def test_stylesheet_encoding_preserves_declared_and_utf16_text(self) -> None:
        css = '.entry { font-family: "日本語"; }'
        for raw in [
            ('@charset "shift_jis";\n' + css).encode("shift_jis"),
            css.encode("utf-16-be"),
            css.encode("utf-16-le"),
            css.encode("utf-8-sig"),
            css.encode("utf-16"),
            ('@charset "shift_jis";\n' + css).encode("utf-8-sig"),
            b"\xfe\xff" + ('@charset "utf-8";\n' + css).encode("utf-16-be"),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(mdx_to_yomitan._decode_stylesheet_asset(raw), css)


    def test_stylesheet_encoding_rejects_unknown_or_mismatched_declaration(self) -> None:
        for raw in [b'@charset "unknown-codec"; body { color: red; }',
                    b'@charset "utf-8"; body { content: "\xff"; }']:
            with self.subTest(raw=raw):
                self.assertIsNone(mdx_to_yomitan._decode_stylesheet_asset(raw))


    def test_declared_stylesheet_survives_archive_migration(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "fixture.mdx"
            companion = root / "fixture.mdd"
            output = root / "fixture.zip"
            source.write_bytes(b"MDX")
            companion.write_bytes(b"MDD")
            raw_css = '@charset "shift_jis";\nbody { font-family: "日本語"; background: url(../image.png); }'.encode("shift_jis")
            _register_mdx(source, header={b"Title": b"CSS"}, items=[("entry", "definition")])
            _register_mdd(companion, [(b"styles/main.css", raw_css), (b"image.png", b"IMAGE")])
            mdx_to_yomitan.convert_mdx_to_yomitan_zip(source, output, options=mdx_to_yomitan.ConvertOptions())
            with zipfile.ZipFile(output) as archive:
                stylesheet = archive.read("styles.css").decode("utf-8")
                self.assertIn('font-family: "日本語"', stylesheet)
                self.assertIn('url("mdict-media/image.png")', stylesheet)
                self.assertNotIn("@charset", stylesheet)
                self.assertEqual(archive.read("mdict-media/styles/main.css"), raw_css)
                self.assertEqual(archive.read("mdict-media/image.png"), b"IMAGE")


    def test_css_url_rewrite_preserves_literals_and_identifier_boundaries(self) -> None:
        for literal in [
            'content: "url(example.png)"',
            r'''content: 'say \'url(example.png)\''; /* url(comment.png) */''',
            'custom: myurl(example.png); custom: 変url(example.png)',
        ]:
            with self.subTest(literal=literal):
                css = literal + "; background: URL(images/real.png)"
                expected = literal + '; background: url("mdict-media/images/real.png")'
                self.assertEqual(mdx_to_yomitan._rewrite_css_asset_urls(css, "mdict-media/", None), expected)


    def test_css_url_rewrite_preserves_unterminated_literal_regions(self) -> None:
        for css in ['/* url(comment.png)', 'content: "url(literal.png)']:
            with self.subTest(css=css):
                self.assertEqual(mdx_to_yomitan._rewrite_css_asset_urls(css, "mdict-media/", None), css)


    def test_embedded_assets_preserve_source_collisions_and_deduplicate(self) -> None:
        data = b"PNG"
        digest = mdx_to_yomitan.hashlib.sha1(data).hexdigest()
        key = f"embedded/image/{digest}.png"
        for source_key in [key, key.upper()]:
            with self.subTest(source_key=source_key), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source = root / "fixture.mdx"
                companion = root / "fixture.mdd"
                output = root / "fixture.zip"
                source.write_bytes(b"MDX")
                companion.write_bytes(b"MDD")
                definition = '<img src="data:image/png;base64,UE5H">'
                _register_mdx(source, header={b"Title": b"Collision"}, items=[
                    ("one", definition), ("two", definition),
                ])
                _register_mdd(companion, [(source_key.encode(), b"SOURCE"),
                                          ((key[:-4] + "-1.png").encode(), b"SECOND SOURCE")])
                mdx_to_yomitan.convert_mdx_to_yomitan_zip(source, output, options=mdx_to_yomitan.ConvertOptions())
                with zipfile.ZipFile(output) as archive:
                    rows = json.loads(archive.read("term_bank_1.json"))
                    paths = [row[5][0]["content"]["content"][0]["path"] for row in rows]
                    self.assertEqual(paths[0], paths[1])
                    self.assertEqual(archive.read(paths[0]), data)
                    self.assertNotEqual(paths[0].casefold(), ("mdict-media/" + source_key).casefold())
                    self.assertEqual(archive.read("mdict-media/" + source_key), b"SOURCE")
                    self.assertEqual(archive.read("mdict-media/" + key[:-4] + "-1.png"), b"SECOND SOURCE")
                    self.assertEqual(sum(name == paths[0] for name in archive.namelist()), 1)


    def test_reference_html_nesting_survives_unmatched_endtags(self) -> None:
        glossary, _, _ = mdx_to_yomitan._convert_definition_to_structured_content(
            '<div class="outer"><span class="inner">one</ghost>two</span>three</div>',
            enable_audio=False, asset_prefix="mdict-media/",
        )
        content = glossary["content"]["content"]
        self.assertEqual(len(content), 1)
        outer = content[0]
        inner = outer["content"][0]
        self.assertEqual(outer["data"]["class"], "outer")
        self.assertEqual(inner["data"]["class"], "inner")
        self.assertEqual(inner["content"], ["onetwo"])
        self.assertEqual(outer["content"][1], "three")


    def test_reference_html_ancestor_close_and_transparent_tags_keep_behavior(self) -> None:
        glossary, _, _ = mdx_to_yomitan._convert_definition_to_structured_content(
            '<div><custom><span>one</div>two', enable_audio=False, asset_prefix="mdict-media/",
        )
        content = glossary["content"]["content"]
        self.assertEqual(content[0]["content"][0]["content"], ["one"])
        self.assertEqual(content[1], "two")


    def test_search_references_preserve_exact_headword(self) -> None:
        for prefix in ["entry://", "bword://", "d:", "x:"]:
            for raw, expected in [("A&B#C?D+E", "A&B#C?D+E"),
                                  ("日本 語", "日本 語"), ("A%26B", "A&B"),
                                  ("A%2BB%2526C", "A+B%26C")]:
                with self.subTest(prefix=prefix, raw=raw):
                    glossary, _, _ = mdx_to_yomitan._convert_definition_to_structured_content(
                        f'<a href="{prefix}{raw}">jump</a>', enable_audio=False, asset_prefix="mdict-media/",
                    )
                    href = glossary["content"]["content"][0]["href"]
                    parsed = urlsplit(href)
                    self.assertEqual(parse_qs(parsed.query), {"query": [expected]})
                    self.assertEqual(parsed.fragment, "")


    def test_stylesheet_relative_references_preserve_root_and_prefix_controls(self) -> None:
        for raw, expected in [
            ("images/a.png", "styles/images/a.png"),
            ("./images/a.png", "styles/images/a.png"),
            ("../images/a.png", "images/a.png"),
            ("/images/a.png", "images/a.png"),
            ("file://images/a.png", "images/a.png"),
            ("mdict-media/images/a.png", "images/a.png"),
            ("画像.png", "styles/画像.png"),
            ("images/a.png?cache=1#part", "styles/images/a.png?cache=1#part"),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(
                    mdx_to_yomitan._rewrite_css_asset_urls(f"url({raw})", "mdict-media/", "styles/main.css"),
                    f'url("mdict-media/{expected}")',
                )


    def test_inline_reference_rewrite_accepts_css_function_case(self) -> None:
        for function in ["url", "URL", "uRl"]:
            with self.subTest(function=function):
                glossary, _, _ = mdx_to_yomitan._convert_definition_to_structured_content(
                    f'<div style="background-image: {function}(images/a.png)">text</div>',
                    enable_audio=False, asset_prefix="mdict-media/",
                )
                node = glossary["content"]["content"][0]
                self.assertEqual(node["style"]["background"], 'url("mdict-media/images/a.png")')


    def test_reference_archive_uses_stylesheet_sibling_asset_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "fixture.mdx"
            companion = root / "fixture.mdd"
            output = root / "fixture.zip"
            source.write_bytes(b"MDX")
            companion.write_bytes(b"MDD")
            _register_mdx(source, header={b"Title": b"References"}, items=[
                ("entry", '<a href="entry://A%26B">jump</a>'),
            ])
            css = b'body { background: url(images/a.png); }'
            _register_mdd(companion, [(b"styles/main.css", css),
                                      (b"styles/images/a.png", b"SIBLING"), (b"images/a.png", b"ROOT")])
            mdx_to_yomitan.convert_mdx_to_yomitan_zip(source, output, options=mdx_to_yomitan.ConvertOptions())
            with zipfile.ZipFile(output) as archive:
                stylesheet = archive.read("styles.css").decode()
                self.assertIn('url("mdict-media/styles/images/a.png")', stylesheet)
                self.assertEqual(archive.read("mdict-media/styles/images/a.png"), b"SIBLING")
                self.assertEqual(archive.read("mdict-media/images/a.png"), b"ROOT")
                self.assertEqual(archive.read("mdict-media/styles/main.css"), css)
                row = json.loads(archive.read("term_bank_1.json"))[0]
                href = row[5][0]["content"]["content"][0]["href"]
                self.assertEqual(parse_qs(urlsplit(href).query), {"query": ["A&B"]})


    def test_inline_stylesheets_are_scoped_to_exported_definitions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mdx = root / "scopes.mdx"
            mdd = root / "scopes.mdd"
            output = root / "scopes.zip"
            mdx.write_bytes(b"mdx")
            mdd.write_bytes(b"mdd")
            _register_mdx(mdx, header={}, items=[
                ("first", '<style>.shared {color:red} @media screen {body .shared::before {content:"first"}}</style><div class="shared">first</div>'),
                ("alias", "@@@LINK=first"),
                ("second", '<style>.shared {color:blue} :root {color:blue}</style><div class="shared">second</div>'),
                ("unstyled", '<div class="shared">unstyled</div>'),
            ])
            external = b".shared {font-weight:bold}"
            _register_mdd(mdd, [(b"styles/global.css", external)])
            mdx_to_yomitan.convert_mdx_to_yomitan_zip(
                mdx, output, options=mdx_to_yomitan.ConvertOptions(), explicit_mdds=[mdd],
            )
            with zipfile.ZipFile(output) as archive:
                entries = {row[0]: row for row in json.loads(archive.read("term_bank_1.json"))}
                css = archive.read("styles.css").decode()
                self.assertEqual(archive.read("mdict-media/styles/global.css"), external)
            for term, sequence in (("first", 0), ("second", 1)):
                with self.subTest(term=term):
                    scope = f'mdict-yomitan-entry-{sequence}'
                    selector = f'[data-sc-class~="{scope}"]'
                    guard = f':where({selector}, {selector} *)'
                    self.assertEqual(entries[term][5][0]["content"]["data"]["class"],
                                     f"mdict-yomitan-content {scope}")
                    color = "red" if sequence == 0 else "blue"
                    self.assertIn(f'[data-sc-class~="shared"]{guard}{{color:{color}}}', css)
            first = '[data-sc-class~="mdict-yomitan-entry-0"]'
            first_guard = f':where({first}, {first} *)'
            self.assertIn(f'@media screen {{{first} [data-sc-class~="shared"]{first_guard}::before{{content:"first"}}}}', css)
            second = '[data-sc-class~="mdict-yomitan-entry-1"]'
            self.assertIn(f'{second}:where({second}, {second} *){{color:blue}}', css)
            self.assertEqual(entries["alias"][5], entries["first"][5])
            self.assertEqual(entries["alias"][6], entries["first"][6])
            self.assertEqual(entries["unstyled"][5][0]["content"]["data"]["class"], "mdict-yomitan-content")
            self.assertIn('[data-sc-class~="shared"]{font-weight:bold}', css)


    def test_inline_scope_guards_subject_before_pseudo_elements(self) -> None:
        def export_css(stylesheet: str) -> str:
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                mdx = root / "scope.mdx"
                output = root / "scope.zip"
                mdx.write_bytes(b"mdx")
                _register_mdx(mdx, header={}, items=[("term", f'<style>{stylesheet}</style><div>text</div>')])
                mdx_to_yomitan.convert_mdx_to_yomitan_zip(mdx, output, options=mdx_to_yomitan.ConvertOptions(), explicit_mdds=[])
                with zipfile.ZipFile(output) as archive:
                    return archive.read("styles.css").decode()

        scope = '[data-sc-class~="mdict-yomitan-entry-0"]'
        guard = f':where({scope}, {scope} *)'
        for selector, migrated in (
            ("body + .outside::after", f'{scope} + [data-sc-class~="outside"]{guard}::after'),
            ("body ~ .outside:before", f'{scope} ~ [data-sc-class~="outside"]{guard}:before'),
            ('.shared:hover', f'[data-sc-class~="shared"]:hover{guard}'),
            ('[title="::before"]:not(.x)::first-letter', f'[title="::before"]:not([data-sc-class~="x"]){guard}::first-letter'),
            ('.shared:first-line', f'[data-sc-class~="shared"]{guard}:first-line'),
            ('.shared:after', f'[data-sc-class~="shared"]{guard}:after'),
        ):
            with self.subTest(selector=selector):
                css = export_css(selector + " {color:red}")
                self.assertIn(migrated + "{color:red}", css)
        css = export_css('@font-face {font-family:test} @keyframes spin {from {opacity:0} to {opacity:1}}')
        self.assertIn('@font-face {font-family:test}', css)
        self.assertIn('@keyframes spin {from {opacity:0} to {opacity:1}}', css)
        self.assertNotIn(':where(', css)
        for grouping in ('@media screen', '@supports (display: grid)', '@layer entries', '@container entry', '@document url-prefix("https://example.com/")'):
            with self.subTest(grouping=grouping):
                css = export_css(grouping + ' { .shared {color:red} }')
                self.assertIn(f'{grouping} {{ [data-sc-class~="shared"]{guard}{{color:red}} }}', css)


    def test_legacy_font_sizes_become_css_keywords(self) -> None:
        for value, expected in (
            ("1", "x-small"), ("2", "small"), ("3", "medium"),
            ("4", "large"), ("5", "x-large"), ("6", "xx-large"), ("7", "xxx-large"),
            ("0", "x-small"), ("9", "xxx-large"),
            ("+1", "large"), ("+0", "medium"), ("+9", "xxx-large"),
            ("-1", "small"), ("-0", "medium"), ("-9", "x-small"),
            (" \t4trailing", "large"), ("003", "medium"), ("+0002", "x-large"),
            ("9" * 100, "xxx-large"), ("-" + "9" * 100, "x-small"),
            ("invalid", None), ("+", None), ("+ 2", None), ("４", None),
        ):
            with self.subTest(value=value):
                result, styles, assets = mdx_to_yomitan._convert_definition_to_structured_content(
                    f'<font size="{value}">text</font>', enable_audio=False, asset_prefix="mdict-media/",
                )
                font = result["content"]["content"][0]
                self.assertEqual(font.get("style", {}).get("fontSize"), expected)
                self.assertEqual(font["content"], ["text"])
                self.assertEqual(styles, [])
                self.assertEqual(assets, {})


    def test_legacy_font_hints_yield_to_inline_styles(self) -> None:
        for inline, expected in (
            ("", {"color": "red", "fontSize": "large", "fontFamily": "Legacy Serif"}),
            ("color: blue", {"color": "blue", "fontSize": "large", "fontFamily": "Legacy Serif"}),
            ("font-size: 18px", {"color": "red", "fontSize": "18px", "fontFamily": "Legacy Serif"}),
            ("font-family: Modern Serif", {"color": "red", "fontSize": "large", "fontFamily": "Modern Serif"}),
            ("color: blue; font-size: 120%; font-family: Modern Serif; font-weight: bold",
             {"color": "blue", "fontSize": "120%", "fontFamily": "Modern Serif", "fontWeight": "bold"}),
        ):
            with self.subTest(inline=inline):
                result, _, _ = mdx_to_yomitan._convert_definition_to_structured_content(
                    f'<font color="red" size="4" face="Legacy Serif" style="{inline}">outer<font size="-1">inner</font></font>',
                    enable_audio=False, asset_prefix="mdict-media/",
                )
                outer = result["content"]["content"][0]
                self.assertEqual(outer["style"], expected)
                self.assertEqual(outer["content"][1]["style"], {"fontSize": "small"})


    def test_legacy_font_hints_survive_archive_export_and_aliases(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            mdx = root / "font.mdx"
            output = root / "font.zip"
            mdx.write_bytes(b"mdx")
            _register_mdx(mdx, header={}, items=[
                ("main", '<font color="red" size="+2" face="Legacy" style="color: blue; font-family: Modern">text</font>'),
                ("alias", "@@@LINK=main"),
                ("plain", '<font size="invalid" style="font-size: 16px">plain</font>'),
            ])
            mdx_to_yomitan.convert_mdx_to_yomitan_zip(mdx, output, options=mdx_to_yomitan.ConvertOptions(), explicit_mdds=[])
            with zipfile.ZipFile(output) as archive:
                entries = {row[0]: row for row in json.loads(archive.read("term_bank_1.json"))}
                self.assertNotIn("styles.css", archive.namelist())
            font = entries["main"][5][0]["content"]["content"][0]
            self.assertEqual(font["tag"], "span")
            self.assertEqual(font["data"]["tag"], "font")
            self.assertEqual(font["style"], {"color": "blue", "fontSize": "x-large", "fontFamily": "Modern"})
            self.assertEqual(font["content"], ["text"])
            self.assertEqual(entries["alias"][5], entries["main"][5])
            self.assertEqual(entries["alias"][6], entries["main"][6])
            self.assertEqual(entries["plain"][5][0]["content"]["content"][0]["style"], {"fontSize": "16px"})


    def test_discover_mdds_uses_numbered_suffixes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            mdx_path = temp_path / "fixture.mdx"
            mdx_path.write_bytes(b"mdx")
            (temp_path / "fixture.mdd").write_bytes(b"0")
            (temp_path / "fixture.1.mdd").write_bytes(b"1")
            (temp_path / "fixture.2.mdd").write_bytes(b"2")

            result = mdx_to_yomitan._discover_mdds(mdx_path)

            self.assertEqual(
                result,
                [
                    temp_path / "fixture.mdd",
                    temp_path / "fixture.1.mdd",
                    temp_path / "fixture.2.mdd",
                ],
            )

    def test_migrate_stylesheet_for_yomitan_rewrites_root_selectors_and_asset_urls(self) -> None:
        stylesheet = (
            "/* lead */\n"
            ":root, body, div.entry #hero a.jump {"
            ' background-image: url("../images/cover.jpg?cache=1#top");'
            " }\n"
            '@media screen { table.tbl td.cell, img.icon {'
            ' background-image: url("./icons/icon.png");'
            " } }\n"
            '@font-face { src: url("../fonts/test.woff2"); }'
        )

        migrated = mdx_to_yomitan._migrate_stylesheet_for_yomitan(
            stylesheet,
            "mdict-media/",
            "styles/main.css",
        )

        self.assertIn(
            "/* lead */",
            migrated,
        )
        self.assertIn(
            '[data-sc-class~="mdict-yomitan-content"], [data-sc-tag="div"][data-sc-class~="entry"] [data-sc-id="hero"] [data-sc-tag="a"][data-sc-class~="jump"]{ background-image: url("mdict-media/images/cover.jpg?cache=1#top"); }',
            migrated,
        )
        self.assertIn(
            '@media screen { [data-sc-tag="table"][data-sc-class~="tbl"] [data-sc-tag="td"][data-sc-class~="cell"], [data-sc-tag="img"][data-sc-class~="icon"]{ background-image: url("mdict-media/styles/icons/icon.png"); } }',
            migrated,
        )
        self.assertIn(
            '@font-face { src: url("mdict-media/fonts/test.woff2"); }',
            migrated,
        )

    def test_convert_definition_to_structured_content_maps_common_html_tags(self) -> None:
        glossary, inline_stylesheets, embedded_assets = mdx_to_yomitan._convert_definition_to_structured_content(
            '<p class="lead" style="font-weight: bold; text-decoration: underline;">hello <em>world</em><br><sup>2</sup><link rel="stylesheet" href="styles/main.css"></p>',
            enable_audio=False,
            asset_prefix="mdict-media/",
        )

        self.assertEqual(inline_stylesheets, [])
        self.assertEqual(embedded_assets, {})
        root = glossary["content"]
        paragraph = root["content"][0]
        self.assertEqual(paragraph["tag"], "div")
        self.assertEqual(paragraph["data"]["tag"], "p")
        self.assertEqual(paragraph["data"]["class"], "lead")
        self.assertEqual(paragraph["style"]["fontWeight"], "bold")
        self.assertEqual(paragraph["style"]["textDecorationLine"], "underline")
        self.assertEqual(paragraph["content"][0], "hello ")
        emphasis = paragraph["content"][1]
        self.assertEqual(emphasis["tag"], "span")
        self.assertEqual(emphasis["data"]["tag"], "em")
        self.assertEqual(emphasis["style"]["fontStyle"], "italic")
        self.assertEqual(paragraph["content"][2]["tag"], "br")
        superscript = paragraph["content"][3]
        self.assertEqual(superscript["data"]["tag"], "sup")
        self.assertEqual(superscript["style"]["verticalAlign"], "super")

    def test_convert_definition_to_structured_content_rewrites_inline_urls_and_embeds_data_assets(self) -> None:
        glossary, inline_stylesheets, embedded_assets = mdx_to_yomitan._convert_definition_to_structured_content(
            '<div class="hero" style="background-image: url(images/bg.png); font-family: Example Serif;">hero</div>'
            '<img class="inline" src="data:image/png;base64,UE5H" alt="Inline">'
            '<audio title="Sample" src="data:audio/mpeg;base64,TVAz">listen</audio>',
            enable_audio=True,
            asset_prefix="mdict-media/",
        )

        self.assertEqual(inline_stylesheets, [])
        self.assertEqual(len(embedded_assets), 2)
        root = glossary["content"]
        hero = root["content"][0]
        self.assertEqual(hero["tag"], "div")
        self.assertEqual(hero["style"]["background"], 'url("mdict-media/images/bg.png")')
        self.assertEqual(hero["style"]["fontFamily"], "Example Serif")
        image = root["content"][1]
        self.assertEqual(image["tag"], "img")
        self.assertTrue(image["path"].startswith("mdict-media/embedded/image/"))
        self.assertEqual(embedded_assets[image["path"]], b"PNG")
        audio = root["content"][2]
        self.assertEqual(audio["tag"], "a")
        self.assertEqual(audio["data"]["tag"], "audio")
        self.assertEqual(audio["title"], "Sample")
        self.assertEqual(audio["content"], ["listen"])
        self.assertTrue(audio["href"].startswith("media:mdict-media/embedded/audio/"))
        self.assertEqual(embedded_assets[unquote(audio["href"][6:])], b"MP3")

    def test_convert_writes_redirects_assets_styles_and_description_override(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            mdx_path = temp_path / "fixture.mdx"
            mdd_path = temp_path / "fixture.mdd"
            out_zip_path = temp_path / "fixture.zip"
            mdx_path.write_bytes(b"mdx")
            mdd_path.write_bytes(b"mdd")
            _register_mdx(
                mdx_path,
                header={
                    b"Title": b"Source Title",
                    b"Description": b"Source Description",
                },
                items=[
                    (
                        "main",
                        '<div id="entry" class="entry main">'
                        '<a class="jump" href="entry://target"><span>jump</span></a>'
                        '<img class="icon" src="file://images\\\\cover.jpg" width="64" height="32" alt="Cover">'
                        '<a class="sound" href="sound://audio\\\\ping.mp3">play</a>'
                        '<table class="tbl"><tr><td class="cell" colspan="2">Cell</td></tr></table>'
                        '<ruby>漢<rt>かん</rt></ruby>'
                        '<style>.entry .jump { color: blue; } #entry img.icon { border-width: 1px; } table.tbl td.cell { padding: 2px; }</style>'
                        '<script>alert(1)</script>'
                        "</div>",
                    ),
                    ("alias", "@@@LINK=main"),
                ],
            )
            _register_mdd(
                mdd_path,
                [
                    (
                        b"styles\\main.css",
                        (
                            b'body, html, :root { background-image: url("../images\\\\cover.jpg?cache=1#top"); }\n'
                            b'@media screen { body .nested { background-image: url("./icons\\\\icon.png"); } }\n'
                            b'@font-face { src: url("../fonts/test.woff2"); }\n'
                            b".entry { color: red; }"
                        ),
                    ),
                    (b"images\\cover.jpg", b"JPEG"),
                    (b"audio\\ping.mp3", b"MP3"),
                    (b"styles\\icons\\icon.png", b"ICON"),
                    (b"fonts\\test.woff2", b"FONT"),
                ],
            )

            mdx_to_yomitan.convert_mdx_to_yomitan_zip(
                mdx_path,
                out_zip_path,
                options=mdx_to_yomitan.ConvertOptions(
                    title_override="Override Title",
                    description_override="Override Description",
                    revision="2026.03.17",
                    enable_audio=True,
                ),
            )

            with zipfile.ZipFile(out_zip_path) as archive:
                index = json.loads(archive.read("index.json"))
                terms = json.loads(archive.read("term_bank_1.json"))
                stylesheet = archive.read("styles.css").decode("utf-8")
                image_bytes = archive.read("mdict-media/images/cover.jpg")
                audio_bytes = archive.read("mdict-media/audio/ping.mp3")

            self.assertEqual(index["title"], "Override Title")
            self.assertEqual(index["description"], "Override Description")
            self.assertEqual(index["revision"], "2026.03.17")
            self.assertEqual({entry[0] for entry in terms}, {"main", "alias"})
            self.assertEqual(terms[0][6], 0)
            self.assertEqual(terms[1][6], 0)
            glossary = terms[0][5][0]
            self.assertEqual(glossary["type"], "structured-content")
            root = glossary["content"]
            self.assertEqual(root["tag"], "div")
            self.assertEqual(root["data"]["class"], "mdict-yomitan-content mdict-yomitan-entry-0")
            entry = root["content"][0]
            self.assertEqual(entry["tag"], "div")
            self.assertEqual(entry["data"]["id"], "entry")
            self.assertEqual(entry["data"]["class"], "entry main")
            jump_link = entry["content"][0]
            self.assertEqual(jump_link["tag"], "a")
            self.assertEqual(jump_link["href"], "?query=target")
            self.assertEqual(jump_link["data"]["class"], "jump")
            image = entry["content"][1]
            self.assertEqual(image["tag"], "img")
            self.assertEqual(image["path"], "mdict-media/images/cover.jpg")
            self.assertEqual(image["data"]["class"], "icon")
            self.assertEqual(image["width"], 64)
            self.assertEqual(image["height"], 32)
            sound_link = entry["content"][2]
            self.assertEqual(sound_link["href"], "media:mdict-media/audio/ping.mp3")
            table = entry["content"][3]
            self.assertEqual(table["tag"], "table")
            self.assertEqual(table["data"]["class"], "tbl")
            cell = table["content"][0]["content"][0]
            self.assertEqual(cell["tag"], "td")
            self.assertEqual(cell["colSpan"], 2)
            self.assertEqual(cell["data"]["class"], "cell")
            self.assertNotIn("alert(1)", json.dumps(glossary, ensure_ascii=False))
            self.assertIn("Source: styles/main.css", stylesheet)
            self.assertIn(
                '[data-sc-class~="mdict-yomitan-content"]{ background-image: url("mdict-media/images/cover.jpg?cache=1#top"); }',
                stylesheet,
            )
            self.assertIn(
                '@media screen { [data-sc-class~="mdict-yomitan-content"] [data-sc-class~="nested"]{ background-image: url("mdict-media/styles/icons/icon.png"); } }',
                stylesheet,
            )
            self.assertIn(
                '@font-face { src: url("mdict-media/fonts/test.woff2"); }',
                stylesheet,
            )
            scope = '[data-sc-class~="mdict-yomitan-entry-0"]'
            guard = f':where({scope}, {scope} *)'
            self.assertIn(f'[data-sc-class~="entry"] [data-sc-class~="jump"]{guard}{{ color: blue; }}', stylesheet)
            self.assertIn(f'[data-sc-id="entry"] [data-sc-tag="img"][data-sc-class~="icon"]{guard}{{ border-width: 1px; }}', stylesheet)
            self.assertIn(f'[data-sc-tag="table"][data-sc-class~="tbl"] [data-sc-tag="td"][data-sc-class~="cell"]{guard}{{ padding: 2px; }}', stylesheet)
            self.assertIn('[data-sc-class~="entry"]{ color: red; }', stylesheet)
            self.assertEqual(image_bytes, b"JPEG")
            self.assertEqual(audio_bytes, b"MP3")

    def test_convert_writes_embedded_data_assets_into_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            mdx_path = temp_path / "embedded.mdx"
            mdd_path = temp_path / "embedded.mdd"
            out_zip_path = temp_path / "embedded.zip"
            mdx_path.write_bytes(b"mdx")
            mdd_path.write_bytes(b"mdd")
            _register_mdx(
                mdx_path,
                header={b"Title": b"Embedded"},
                items=[
                    (
                        "main",
                        '<div class="hero" style="background-image: url(images/bg.png); font-family: Example Serif;">hero</div>'
                        '<img src="data:image/png;base64,UE5H" alt="Inline">'
                        '<audio src="data:audio/mpeg;base64,TVAz">listen</audio>',
                    ),
                ],
            )
            _register_mdd(
                mdd_path,
                [
                    (b"images\\bg.png", b"BG"),
                ],
            )

            mdx_to_yomitan.convert_mdx_to_yomitan_zip(
                mdx_path,
                out_zip_path,
                options=mdx_to_yomitan.ConvertOptions(
                    revision="2026.03.17",
                    enable_audio=True,
                ),
            )

            with zipfile.ZipFile(out_zip_path) as archive:
                terms = json.loads(archive.read("term_bank_1.json"))

                glossary = terms[0][5][0]
                root = glossary["content"]
                hero = root["content"][0]
                image = root["content"][1]
                audio = root["content"][2]

                self.assertEqual(hero["style"]["background"], 'url("mdict-media/images/bg.png")')
                self.assertEqual(hero["style"]["fontFamily"], "Example Serif")
                self.assertEqual(archive.read("mdict-media/images/bg.png"), b"BG")
                self.assertTrue(image["path"].startswith("mdict-media/embedded/image/"))
                self.assertEqual(archive.read(image["path"]), b"PNG")
                self.assertTrue(audio["href"].startswith("media:mdict-media/embedded/audio/"))
                self.assertEqual(archive.read(unquote(audio["href"][6:])), b"MP3")


class NativeHostTests(unittest.TestCase):

    def test_upload_rejects_a_gap_without_creating_sparse_dictionary_bytes(self) -> None:
        state = native_host.HostState()
        try:
            upload_id = state.begin_upload("fixture.mdx", 4)["uploadId"]
            with self.assertRaisesRegex(ValueError, "offset"):
                state.upload_chunk(upload_id, 3, base64.b64encode(b"D").decode("ascii"))
            self.assertEqual(state._uploads[upload_id].path.read_bytes(), b"")
            with self.assertRaisesRegex(ValueError, "incomplete"):
                state.finish_upload(upload_id)
            state.upload_chunk(upload_id, 0, base64.b64encode(b"AB").decode("ascii"))
            state.upload_chunk(upload_id, 2, base64.b64encode(b"CD").decode("ascii"))
            self.assertTrue(state.finish_upload(upload_id))
            self.assertEqual(state._uploads[upload_id].path.read_bytes(), b"ABCD")
        finally:
            state.cleanup()


    def test_upload_rejects_overruns_and_replayed_chunks_before_writing(self) -> None:
        state = native_host.HostState()
        try:
            upload_id = state.begin_upload("fixture.mdx", 4)["uploadId"]
            with self.assertRaisesRegex(ValueError, "size"):
                state.upload_chunk(upload_id, 0, base64.b64encode(b"ABCDE").decode("ascii"))
            state.upload_chunk(upload_id, 0, base64.b64encode(b"AB").decode("ascii"))
            with self.assertRaisesRegex(ValueError, "offset"):
                state.upload_chunk(upload_id, 0, base64.b64encode(b"XX").decode("ascii"))
            self.assertEqual(state._uploads[upload_id].path.read_bytes(), b"AB")
            self.assertEqual(state._uploads[upload_id].received_bytes, 2)
        finally:
            state.cleanup()


    def test_upload_rejects_invalid_base64_before_advancing_progress(self) -> None:
        state = native_host.HostState()
        try:
            upload_id = state.begin_upload("fixture.mdx", 1)["uploadId"]
            with self.assertRaises(ValueError):
                state.upload_chunk(upload_id, 0, "QQ==!")
            self.assertEqual(state._uploads[upload_id].path.read_bytes(), b"")
            self.assertEqual(state._uploads[upload_id].received_bytes, 0)
        finally:
            state.cleanup()


    def test_convert_preserves_explicit_noncontiguous_mdd_selection(self) -> None:
        state = native_host.HostState()
        original_convert = native_host.convert_mdx_to_yomitan_zip
        try:
            mdx_id = state.begin_upload("fixture.mdx", 3)["uploadId"]
            first_id = state.begin_upload("fixture.1.mdd", 1)["uploadId"]
            third_id = state.begin_upload("fixture.3.mdd", 1)["uploadId"]
            for upload_id, data in [(mdx_id, b"MDX"), (first_id, b"1"), (third_id, b"3")]:
                state.upload_chunk(upload_id, 0, base64.b64encode(data).decode("ascii"))
                state.finish_upload(upload_id)

            def register_staged_readers(mdx_path: Path, out_zip_path: Path, *, options: object, explicit_mdds: object = None) -> Path:
                _register_mdx(mdx_path, header={b"Title": b"Selected resources"}, items=[("entry", "definition")])
                for volume in [1, 3]:
                    _register_mdd(mdx_path.parent / f"fixture.{volume}.mdd", [(f"volume-{volume}.bin".encode(), bytes([volume]))])
                return original_convert(mdx_path, out_zip_path, options=options, explicit_mdds=explicit_mdds)

            native_host.convert_mdx_to_yomitan_zip = register_staged_readers
            job_id = state.convert(mdx_id, [third_id, first_id], {})
            with zipfile.ZipFile(state._jobs[job_id].archive_path) as archive:
                self.assertEqual(archive.read("mdict-media/volume-1.bin"), bytes([1]))
                self.assertEqual(archive.read("mdict-media/volume-3.bin"), bytes([3]))
        finally:
            native_host.convert_mdx_to_yomitan_zip = original_convert
            state.cleanup()


    def test_framed_read_preserves_fragmented_message(self) -> None:
        message = {"sequence": 3, "action": "get_version", "params": {}}
        payload = json.dumps(message).encode("utf-8")
        frame = native_host.struct.pack("<I", len(payload)) + payload
        position = 0

        def short_read(fd: int, length: int) -> bytes:
            nonlocal position
            self.assertEqual(fd, 0)
            chunk = frame[position:position + min(length, 2)]
            position += len(chunk)
            return chunk

        with patch.object(native_host.os, "read", side_effect=short_read):
            self.assertEqual(native_host.read_message(), message)
        self.assertEqual(position, len(frame))


    def test_framed_read_rejects_truncated_frame(self) -> None:
        for chunks in [[b"\x01", b""], [native_host.struct.pack("<I", 2), b"{", b""]]:
            with self.subTest(chunks=chunks), patch.object(native_host.os, "read", side_effect=chunks):
                with self.assertRaises(EOFError):
                    native_host.read_message()


    def test_framed_write_preserves_short_writes(self) -> None:
        message = {"sequence": 7, "data": {"text": "辞書"}}
        output = bytearray()

        def short_write(fd: int, data: bytes) -> int:
            self.assertEqual(fd, 1)
            count = min(2, len(data))
            output.extend(data[:count])
            return count

        with patch.object(native_host.os, "write", side_effect=short_write):
            native_host.write_message(message)
        length = native_host.struct.unpack("<I", output[:4])[0]
        self.assertEqual(length, len(output) - 4)
        self.assertEqual(json.loads(output[4:]), message)


    def test_framed_write_stops_on_disconnect(self) -> None:
        for outcome in [0, BrokenPipeError("disconnected")]:
            with self.subTest(outcome=outcome):
                writer = {"return_value": outcome} if outcome == 0 else {"side_effect": outcome}
                with patch.object(native_host.os, "write", **writer) as write:
                    with self.assertRaises((BrokenPipeError, EOFError)):
                        native_host.write_message({"sequence": 1, "data": True})
                    self.assertEqual(write.call_count, 1)


    def test_framed_write_disconnect_cleans_host_state(self) -> None:
        state = native_host.HostState()
        with patch.object(native_host, "HostState", return_value=state), patch.object(
            native_host, "read_message", return_value={"sequence": 1, "action": "get_version", "params": {}}
        ), patch.object(native_host.os, "write", side_effect=BrokenPipeError("disconnected")):
            with self.assertRaises(BrokenPipeError):
                native_host.main()
        self.assertFalse(state._tmpdir.exists())


    def test_failed_job_cleanup_preserves_uploads_and_retry(self) -> None:
        for failure_phase in ["staging", "options", "conversion", "archive-stat"]:
            with self.subTest(phase=failure_phase):
                state = native_host.HostState()
                try:
                    existing_archive = state._tmpdir / "jobs" / "existing" / "archive.zip"
                    existing_archive.parent.mkdir(parents=True)
                    existing_archive.write_bytes(b"existing archive")
                    existing_job = native_host.Job(existing_archive, "archive.zip", 16)
                    state._jobs["existing"] = existing_job
                    upload_id = state.begin_upload("fixture.mdx", 3)["uploadId"]
                    state.upload_chunk(upload_id, 0, base64.b64encode(b"MDX").decode("ascii"))
                    upload_path = state._uploads[upload_id].path
                    real_copy = native_host.shutil.copyfile

                    def copy_then_fail(source: Path, target: Path) -> None:
                        real_copy(source, target)
                        if failure_phase == "staging":
                            raise OSError("staging failed")

                    def failed_convert(mdx: Path, archive: Path, **_kwargs: object) -> None:
                        if failure_phase == "archive-stat":
                            return
                        archive.write_bytes(b"partial archive")
                        raise RuntimeError("conversion failed")

                    options = {"termBankSize": "invalid"} if failure_phase == "options" else {}
                    expected_error = {"staging": OSError, "options": ValueError,
                                      "conversion": RuntimeError, "archive-stat": FileNotFoundError}[failure_phase]
                    with patch.object(native_host.shutil, "copyfile", side_effect=copy_then_fail), patch.object(
                        native_host, "convert_mdx_to_yomitan_zip", side_effect=failed_convert
                    ):
                        with self.assertRaises(expected_error):
                            state.convert(upload_id, [], options)
                    self.assertFalse((state._tmpdir / "jobs" / "j1").exists())
                    self.assertEqual(state._jobs, {"existing": existing_job})
                    self.assertEqual(existing_archive.read_bytes(), b"existing archive")
                    self.assertEqual(upload_path.read_bytes(), b"MDX")

                    def successful_convert(mdx: Path, archive: Path, **_kwargs: object) -> None:
                        self.assertEqual(mdx.read_bytes(), b"MDX")
                        archive.write_bytes(b"healthy archive")

                    with patch.object(native_host, "convert_mdx_to_yomitan_zip", side_effect=successful_convert):
                        job_id = state.convert(upload_id, [], {})
                    self.assertEqual(job_id, "j2")
                    self.assertEqual(state._jobs[job_id].archive_path.read_bytes(), b"healthy archive")
                    self.assertTrue(state.download_end(job_id))
                finally:
                    state.cleanup()


    def test_staging_rejects_colliding_selected_basenames_before_copy(self) -> None:
        for names in [
            ["first/fixture.mdd", "second/fixture.mdd"],
            ["first/Fixture.mdd", "second/fixture.mdd"],
            ["other/fixture.mdx"],
        ]:
            with self.subTest(names=names):
                state = native_host.HostState()
                try:
                    mdx_id = state.begin_upload("fixture.mdx", 3)["uploadId"]
                    state.upload_chunk(mdx_id, 0, base64.b64encode(b"MDX").decode("ascii"))
                    selected = []
                    for name in names:
                        upload_id = state.begin_upload(name, 3)["uploadId"]
                        state.upload_chunk(upload_id, 0, base64.b64encode(b"MDD").decode("ascii"))
                        selected.append(upload_id)
                    def fake_convert(_mdx: Path, archive: Path, **_kwargs: object) -> None:
                        archive.write_bytes(b"archive")

                    with patch.object(native_host.shutil, "copyfile", wraps=native_host.shutil.copyfile) as copy, patch.object(
                        native_host, "convert_mdx_to_yomitan_zip", side_effect=fake_convert
                    ) as convert:
                        with self.assertRaisesRegex(ValueError, "colliding.*file name"):
                            state.convert(mdx_id, selected, {})
                        copy.assert_not_called()
                        convert.assert_not_called()
                    self.assertFalse((state._tmpdir / "jobs" / "j1").exists())
                    self.assertEqual(state._uploads[mdx_id].path.read_bytes(), b"MDX")
                    for upload_id in selected:
                        self.assertEqual(state._uploads[upload_id].path.read_bytes(), b"MDD")
                finally:
                    state.cleanup()


    def test_zero_usable_conversion_does_not_publish_native_job(self) -> None:
        state = native_host.HostState()
        original_convert = native_host.convert_mdx_to_yomitan_zip
        try:
            upload_id = state.begin_upload("fixture.mdx", 3)["uploadId"]
            state.upload_chunk(upload_id, 0, base64.b64encode(b"MDX").decode("ascii"))

            def register_staged_source(source: Path, output: Path, **kwargs: object) -> Path:
                _register_mdx(source, header={b"Title": b"Dangling"}, items=[("alias", "@@@LINK=missing")])
                return original_convert(source, output, **kwargs)

            with patch.object(native_host, "convert_mdx_to_yomitan_zip", side_effect=register_staged_source):
                with self.assertRaisesRegex(ValueError, "no usable non-redirect entries"):
                    state.convert(upload_id, [], {"includeAssets": False})
            self.assertEqual(state._jobs, {})
            self.assertEqual(state._uploads[upload_id].path.read_bytes(), b"MDX")
        finally:
            state.cleanup()


    def test_conversion_rejects_incomplete_selected_uploads_and_allows_retry(self) -> None:
        for incomplete_source in ["mdx", "explicit-mdd", "automatic-mdd"]:
            with self.subTest(source=incomplete_source):
                state = native_host.HostState()
                try:
                    mdx_id = state.begin_upload("fixture.mdx", 3)["uploadId"]
                    mdd_id = state.begin_upload("fixture.mdd", 3)["uploadId"]
                    pending_id = mdx_id if incomplete_source == "mdx" else mdd_id
                    for upload_id in [mdx_id, mdd_id]:
                        data = b"AB" if upload_id == pending_id else b"ABC"
                        state.upload_chunk(upload_id, 0, base64.b64encode(data).decode("ascii"))
                    selected = [] if incomplete_source == "automatic-mdd" else [mdd_id]

                    def fake_convert(source: Path, archive: Path, **_kwargs: object) -> None:
                        archive.write_bytes(b"archive")

                    with patch.object(native_host.shutil, "copyfile", wraps=native_host.shutil.copyfile) as copy, patch.object(
                        native_host, "convert_mdx_to_yomitan_zip", side_effect=fake_convert
                    ) as convert:
                        with self.assertRaisesRegex(ValueError, "incomplete"):
                            state.convert(mdx_id, selected, {})
                        copy.assert_not_called()
                        convert.assert_not_called()
                    self.assertFalse((state._tmpdir / "jobs").exists())
                    self.assertEqual(state._jobs, {})
                    state.upload_chunk(pending_id, 2, base64.b64encode(b"C").decode("ascii"))
                    with patch.object(native_host, "convert_mdx_to_yomitan_zip", side_effect=fake_convert):
                        job_id = state.convert(mdx_id, selected, {})
                    self.assertEqual(job_id, "j1")
                    self.assertEqual((state._jobs[job_id].archive_path.parent / "fixture.mdx").read_bytes(), b"ABC")
                    self.assertEqual((state._jobs[job_id].archive_path.parent / "fixture.mdd").read_bytes(), b"ABC")
                finally:
                    state.cleanup()


    def test_download_rejects_invalid_ranges_before_open(self) -> None:
        state = native_host.HostState()
        try:
            archive = state._tmpdir / "archive.zip"
            archive.write_bytes(b"ARCHIVE")
            job = native_host.Job(archive, "archive.zip", 7)
            state._jobs["j1"] = job
            for offset, size in [(0, -1), (0, 0), (-1, 2), (8, 2)]:
                with self.subTest(offset=offset, size=size), patch.object(
                    Path, "open", autospec=True, side_effect=Path.open
                ) as open_file:
                    with self.assertRaises(ValueError):
                        state.download_chunk("j1", offset, size)
                    open_file.assert_not_called()
            self.assertIs(state._jobs["j1"], job)
            self.assertEqual(archive.read_bytes(), b"ARCHIVE")
        finally:
            state.cleanup()


    def test_download_ranges_preserve_chunk_bytes_and_clip_to_remaining(self) -> None:
        state = native_host.HostState()
        try:
            archive = state._tmpdir / "archive.zip"
            archive.write_bytes(b"ARCHIVE")
            state._jobs["j1"] = native_host.Job(archive, "archive.zip", 7)
            for offset, size, expected in [(0, 3, b"ARC"), (3, 3, b"HIV"),
                                           (6, 3, b"E"), (7, 3, b""),
                                           (3, sys.maxsize + 1, b"HIVE")]:
                with self.subTest(offset=offset, size=size):
                    result = state.download_chunk("j1", offset, size)
                    self.assertEqual(base64.b64decode(result["data"]), expected)
        finally:
            state.cleanup()


    def test_classify_conversion_errors_returns_structured_codes(self) -> None:
        encrypted = native_host._classify_conversion_error(RuntimeError("encrypted mdx payload"))
        unsupported = native_host._classify_conversion_error(RuntimeError("unsupported compression: lzo"))
        invalid_data = native_host._classify_conversion_error(RuntimeError("checksum mismatch in corrupt archive"))

        self.assertEqual(encrypted["code"], "mdx-encrypted")
        self.assertEqual(unsupported["code"], "mdx-unsupported-compression")
        self.assertEqual(invalid_data["code"], "mdx-invalid-data")

    def test_companion_upload_matching_sorts_numbered_mdds(self) -> None:
        state = native_host.HostState()
        try:
            mdx_upload = state.begin_upload("fixture.mdx", 1)["uploadId"]
            first_mdd = state.begin_upload("fixture.1.mdd", 1)["uploadId"]
            base_mdd = state.begin_upload("fixture.mdd", 1)["uploadId"]
            state.begin_upload("other.mdd", 1)

            uploads = state._get_companion_mdd_uploads(mdx_upload, [])

            self.assertEqual([upload.file_name for upload in uploads], ["fixture.mdd", "fixture.1.mdd"])
            self.assertEqual([upload.path.name for upload in uploads], ["fixture.mdd", "fixture.1.mdd"])
            self.assertIn(first_mdd, state._uploads)
            self.assertIn(base_mdd, state._uploads)
        finally:
            state.cleanup()

    def test_convert_stages_workspace_and_passes_description_override(self) -> None:
        state = native_host.HostState()
        calls: List[Dict[str, object]] = []
        original_convert = native_host.convert_mdx_to_yomitan_zip
        try:
            mdx_upload_id = state.begin_upload("nested/fixture.mdx", 3)["uploadId"]
            mdd_upload_id = state.begin_upload("fixture.mdd", 4)["uploadId"]
            state.upload_chunk(mdx_upload_id, 0, base64.b64encode(b"MDX").decode("ascii"))
            state.upload_chunk(mdd_upload_id, 0, base64.b64encode(b"MDD!").decode("ascii"))
            state.finish_upload(mdx_upload_id)
            state.finish_upload(mdd_upload_id)

            def fake_convert(mdx_path: Path, out_zip_path: Path, *, options: object, explicit_mdds: object = None) -> Path:
                calls.append(
                    {
                        "mdx_path": mdx_path,
                        "out_zip_path": out_zip_path,
                        "options": options,
                        "explicit_mdds": explicit_mdds,
                        "workspace_files": sorted(path.name for path in mdx_path.parent.iterdir()),
                        "mdx_bytes": mdx_path.read_bytes(),
                        "mdd_bytes": (mdx_path.parent / "fixture.mdd").read_bytes(),
                    },
                )
                with zipfile.ZipFile(out_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr("index.json", "{}")
                return out_zip_path

            native_host.convert_mdx_to_yomitan_zip = fake_convert

            job_id = state.convert(
                mdx_upload_id,
                [],
                {
                    "titleOverride": "Title",
                    "descriptionOverride": "Description",
                    "revision": "rev-1",
                    "enableAudio": True,
                },
            )

            self.assertEqual(job_id, "j1")
            self.assertEqual(len(calls), 1)
            call = calls[0]
            options = call["options"]
            self.assertEqual(call["explicit_mdds"], [call["mdx_path"].parent / "fixture.mdd"])
            self.assertEqual(call["workspace_files"], ["fixture.mdd", "fixture.mdx"])
            self.assertEqual(call["mdx_bytes"], b"MDX")
            self.assertEqual(call["mdd_bytes"], b"MDD!")
            self.assertEqual(options.title_override, "Title")
            self.assertEqual(options.description_override, "Description")
            self.assertEqual(options.revision, "rev-1")
            self.assertTrue(options.enable_audio)
            download_info = state.download_begin(job_id, 128 * 1024)
            self.assertEqual(download_info["archiveFileName"], "fixture.zip")
            self.assertGreater(download_info["totalBytes"], 0)
            self.assertTrue(state.download_end(job_id))
            self.assertFalse((state._tmpdir / "jobs" / "j1").exists())
        finally:
            native_host.convert_mdx_to_yomitan_zip = original_convert
            state.cleanup()


if __name__ == "__main__":
    unittest.main()

