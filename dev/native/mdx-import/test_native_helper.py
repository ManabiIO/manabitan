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
from urllib.parse import unquote


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
            self.assertEqual(root["data"]["class"], "mdict-yomitan-content")
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
            self.assertIn('[data-sc-class~="entry"] [data-sc-class~="jump"]{ color: blue; }', stylesheet)
            self.assertIn('[data-sc-id="entry"] [data-sc-tag="img"][data-sc-class~="icon"]{ border-width: 1px; }', stylesheet)
            self.assertIn('[data-sc-tag="table"][data-sc-class~="tbl"] [data-sc-tag="td"][data-sc-class~="cell"]{ padding: 2px; }', stylesheet)
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
            self.assertEqual(call["explicit_mdds"], None)
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
