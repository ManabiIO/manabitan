"""
Reference MDX -> Yomitan converter for Manabitan's experimental MDX import flow.

This module intentionally mirrors the high-level behavior described in the local
deep-research report:
- Read `.mdx` entries with PyGlossary's MDict reader.
- Discover companion `.mdd` files using the common `FILE.mdd`, `FILE.1.mdd`,
  `FILE.2.mdd`, ... naming scheme.
- Preserve redirect terms emitted as `@@@LINK=...`.
- Emit a normal Yomitan archive (`index.json`, `term_bank_*.json`, assets).

The implementation is designed as a practical helper skeleton rather than a
turnkey production packager. Projects integrating it should review metadata
mapping, glossary rewriting, and asset path handling for their own datasets.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import re
import zipfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, List, Optional
from urllib.parse import quote, unquote_to_bytes

from pyglossary.plugin_lib.readmdict import MDD, MDX  # type: ignore


_RE_INTERNAL_LINK = re.compile(r'href=(["\'])(entry://|[dx]:)')
_RE_AUDIO_LINK = re.compile(
    r'<a (type="sound" )?([^<>]*? )?href="sound://([^<>"]+)"( .*?)?>(.*?)</a>',
)
_RE_RELATIVE_RESOURCE = re.compile(
    r'(?P<prefix>\b(?:src|href)=["\'])(?P<path>\.?/?[^"\']+)(?P<suffix>["\'])',
    re.IGNORECASE,
)
_RE_CSS_URL = re.compile(
    r'url\(\s*(?P<quote>["\']?)(?P<path>.*?)(?P=quote)\s*\)',
    re.IGNORECASE | re.DOTALL,
)
_RE_CSS_IDENTIFIER = re.compile(r"-?(?:[A-Za-z_]|[^\x00-\x7F])(?:[A-Za-z0-9_-]|[^\x00-\x7F])*")
_RE_CSS_ROOT_SELECTOR = re.compile(
    r"(?<![-\w])(?:html|body|:root)(?![-\w])",
    re.IGNORECASE,
)
_MDX_GLOSSARY_ROOT_CLASS = "mdict-yomitan-content"
_STRUCTURED_DATA_ATTR_PREFIX = "data-sc-"
_STRUCTURED_CLASS_ATTR = f"{_STRUCTURED_DATA_ATTR_PREFIX}class"
_STRUCTURED_ID_ATTR = f"{_STRUCTURED_DATA_ATTR_PREFIX}id"
_STRUCTURED_TAG_ATTR = f"{_STRUCTURED_DATA_ATTR_PREFIX}tag"
_STRUCTURED_ROOT_SELECTOR = f'[{_STRUCTURED_CLASS_ATTR}~="{_MDX_GLOSSARY_ROOT_CLASS}"]'

_SUPPORTED_STRUCTURED_TAGS = {
    "a",
    "br",
    "details",
    "div",
    "img",
    "li",
    "ol",
    "rp",
    "rt",
    "ruby",
    "span",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
}
_HTML_TAG_MAP = {
    "b": "span",
    "blockquote": "div",
    "center": "div",
    "cite": "span",
    "code": "span",
    "del": "span",
    "em": "span",
    "font": "span",
    "h1": "div",
    "h2": "div",
    "h3": "div",
    "h4": "div",
    "h5": "div",
    "h6": "div",
    "i": "span",
    "ins": "span",
    "kbd": "span",
    "mark": "span",
    "p": "div",
    "pre": "div",
    "s": "span",
    "samp": "span",
    "small": "span",
    "strike": "span",
    "strong": "span",
    "sub": "span",
    "sup": "span",
    "tt": "span",
    "u": "span",
    "var": "span",
}
_EMBEDDED_ASSET_EXTENSION_MAP = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "image/apng": ".apng",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
}


@dataclass(frozen=True)
class ConvertOptions:
    title_override: Optional[str] = None
    description_override: Optional[str] = None
    revision: str = "mdx import"
    term_bank_size: int = 10_000
    enable_audio: bool = False
    include_assets: bool = True
    asset_prefix: str = "mdict-media/"


_HTML_TAG_DEFAULT_STYLES = {
    "b": {"fontWeight": "bold"},
    "blockquote": {"marginLeft": "1em"},
    "center": {"textAlign": "center"},
    "code": {"fontFamily": "monospace"},
    "del": {"textDecorationLine": "line-through"},
    "em": {"fontStyle": "italic"},
    "h1": {"fontWeight": "bold", "fontSize": "2em"},
    "h2": {"fontWeight": "bold", "fontSize": "1.5em"},
    "h3": {"fontWeight": "bold", "fontSize": "1.17em"},
    "h4": {"fontWeight": "bold"},
    "h5": {"fontWeight": "bold"},
    "h6": {"fontWeight": "bold"},
    "i": {"fontStyle": "italic"},
    "ins": {"textDecorationLine": "underline"},
    "kbd": {"fontFamily": "monospace"},
    "mark": {"backgroundColor": "yellow"},
    "pre": {"whiteSpace": "pre-wrap"},
    "s": {"textDecorationLine": "line-through"},
    "samp": {"fontFamily": "monospace"},
    "small": {"fontSize": "0.875em"},
    "strike": {"textDecorationLine": "line-through"},
    "strong": {"fontWeight": "bold"},
    "sub": {"verticalAlign": "sub"},
    "sup": {"verticalAlign": "super"},
    "tt": {"fontFamily": "monospace"},
    "u": {"textDecorationLine": "underline"},
    "var": {"fontStyle": "italic"},
}
_INLINE_STYLE_PROPERTY_MAP = {
    "background": "background",
    "background-image": "background",
    "background-color": "backgroundColor",
    "border-color": "borderColor",
    "border-style": "borderStyle",
    "border-radius": "borderRadius",
    "border-width": "borderWidth",
    "clip-path": "clipPath",
    "color": "color",
    "cursor": "cursor",
    "font-family": "fontFamily",
    "font-size": "fontSize",
    "font-style": "fontStyle",
    "font-weight": "fontWeight",
    "list-style-type": "listStyleType",
    "margin": "margin",
    "margin-top": "marginTop",
    "margin-left": "marginLeft",
    "margin-right": "marginRight",
    "margin-bottom": "marginBottom",
    "padding": "padding",
    "padding-top": "paddingTop",
    "padding-left": "paddingLeft",
    "padding-right": "paddingRight",
    "padding-bottom": "paddingBottom",
    "text-align": "textAlign",
    "text-decoration-color": "textDecorationColor",
    "text-decoration-style": "textDecorationStyle",
    "text-emphasis": "textEmphasis",
    "text-shadow": "textShadow",
    "vertical-align": "verticalAlign",
    "white-space": "whiteSpace",
    "word-break": "wordBreak",
}


@dataclass
class _HtmlParseContext:
    tag: str
    mode: str
    container: List[object]
    element: Optional[dict[str, object]] = None
    fallback_text: Optional[str] = None
    text_parts: Optional[List[str]] = None


@dataclass
class _EmbeddedAssetCollector:
    asset_prefix: str
    assets: Dict[str, bytes]

    def register_data_url(self, data_url: str) -> Optional[str]:
        decoded = _decode_data_url(data_url)
        if decoded is None:
            return None
        media_type, data = decoded
        extension = _get_embedded_asset_extension(media_type)
        category = media_type.split("/", 1)[0].strip().lower() or "asset"
        digest = hashlib.sha1(data).hexdigest()
        archive_path = f"{self.asset_prefix}embedded/{category}/{digest}{extension}"
        self.assets.setdefault(archive_path, data)
        return archive_path


def _discover_mdds(mdx_path: Path) -> List[Path]:
    base = mdx_path.with_suffix("")
    results: List[Path] = []
    for candidate in (Path(f"{base}.mdd"), Path(f"{base}.1.mdd")):
        if candidate.is_file():
            results.append(candidate)

    index = 2
    while True:
        candidate = Path(f"{base}.{index}.mdd")
        if not candidate.is_file():
            break
        results.append(candidate)
        index += 1
    return results


def _build_redirect_map(mdx: MDX) -> Dict[str, List[str]]:
    redirects: Dict[str, List[str]] = {}
    for raw_term, raw_definition in mdx.items():
        term = raw_term.decode("utf-8", errors="ignore").strip()
        definition = raw_definition.decode("utf-8", errors="ignore").strip()
        if definition.startswith("@@@LINK="):
            redirects.setdefault(definition[8:], []).append(term)
    return redirects


def _normalize_asset_key(raw_key: str) -> str:
    key = raw_key.replace("\\", "/").lstrip("/")
    return key


def _extract_title(mdx: MDX, mdx_path: Path, override: Optional[str]) -> str:
    if override:
        return override.strip()

    try:
        title = mdx.header[b"Title"].decode("utf-8", errors="ignore").strip()
    except Exception:
        title = ""
    if not title or title == "Title (No HTML code allowed)":
        return mdx_path.stem
    return title


def _extract_description(mdx: MDX, override: Optional[str]) -> str:
    if override is not None:
        return override.strip()
    try:
        return mdx.header.get(b"Description", b"").decode("utf-8", errors="ignore").strip()
    except Exception:
        return ""


def _split_asset_reference_suffix(path: str) -> tuple[str, str]:
    for index, char in enumerate(path):
        if char in ("?", "#"):
            return path[:index], path[index:]
    return path, ""


def _collapse_posix_path(path: str) -> str:
    parts: List[str] = []
    for part in path.replace("\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def _normalize_relative_asset_path(
    path: str,
    source_asset_path: Optional[str] = None,
) -> Optional[str]:
    value = path.strip().replace("\\", "/")
    if not value:
        return None

    value, suffix = _split_asset_reference_suffix(value)
    lowered = value.lower()
    if lowered.startswith((
        "entry://",
        "bword://",
        "sound://",
        "http://",
        "https://",
        "data:",
        "javascript:",
        "about:",
        "#",
    )):
        return None
    if value.startswith("//"):
        return None
    if lowered.startswith("file://"):
        value = value[7:]

    value = value.lstrip("/")
    if source_asset_path is not None and value.startswith(("./", "../")):
        source_parent = PurePosixPath(source_asset_path).parent.as_posix()
        value = f"{source_parent}/{value}" if source_parent != "." else value
    value = _collapse_posix_path(value)
    return f"{value}{suffix}" if value else None


def _prefix_relative_asset_path(
    path: str,
    asset_prefix: str,
    source_asset_path: Optional[str] = None,
) -> Optional[str]:
    normalized_path = _normalize_relative_asset_path(path, source_asset_path)
    if normalized_path is None:
        return None
    if normalized_path.startswith(asset_prefix):
        return normalized_path
    return f"{asset_prefix}{normalized_path}"


def _decode_data_url(value: str) -> Optional[tuple[str, bytes]]:
    if not value.lower().startswith("data:"):
        return None
    header, separator, payload = value[5:].partition(",")
    if separator == "":
        return None
    parts = [part.strip() for part in header.split(";") if part.strip()]
    media_type = parts[0].lower() if parts else "text/plain"
    is_base64 = any(part.lower() == "base64" for part in parts[1:])
    try:
        data = base64.b64decode(payload, validate=False) if is_base64 else unquote_to_bytes(payload)
    except (binascii.Error, ValueError):
        return None
    return media_type, data


def _get_embedded_asset_extension(media_type: str) -> str:
    return _EMBEDDED_ASSET_EXTENSION_MAP.get(media_type.partition(";")[0].strip().lower(), ".bin")


def _resolve_html_asset_path(
    path: str,
    asset_prefix: str,
    *,
    embedded_assets: Optional[_EmbeddedAssetCollector] = None,
    source_asset_path: Optional[str] = None,
) -> Optional[str]:
    value = path.strip()
    if embedded_assets is not None and value.lower().startswith("data:"):
        embedded_path = embedded_assets.register_data_url(value)
        if embedded_path is not None:
            return embedded_path
    return _prefix_relative_asset_path(value, asset_prefix, source_asset_path)


def _rewrite_relative_resources(definition: str, asset_prefix: str) -> str:
    def replace(match: re.Match[str]) -> str:
        prefixed_path = _prefix_relative_asset_path(match.group("path"), asset_prefix)
        if prefixed_path is None:
            return match.group(0)
        return f"{match.group('prefix')}{prefixed_path}{match.group('suffix')}"

    return _RE_RELATIVE_RESOURCE.sub(replace, definition)


def _convert_definition_to_structured_content(
    definition: str,
    *,
    enable_audio: bool,
    asset_prefix: str,
) -> tuple[dict[str, object], List[str], Dict[str, bytes]]:
    value = _RE_INTERNAL_LINK.sub(r"href=\1bword://", definition)
    value = _rewrite_relative_resources(value, asset_prefix)
    embedded_assets: Dict[str, bytes] = {}
    parser = _MdxHtmlToStructuredContentParser(
        asset_prefix=asset_prefix,
        enable_audio=enable_audio,
        embedded_assets=_EmbeddedAssetCollector(asset_prefix=asset_prefix, assets=embedded_assets),
    )
    parser.feed(value)
    parser.close()
    return (
        {
            "type": "structured-content",
            "content": parser.get_structured_content(),
        },
        parser.get_inline_stylesheets(),
        embedded_assets,
    )


def _iter_assets(mdd_paths: Iterable[Path], asset_prefix: str) -> Dict[str, bytes]:
    assets: Dict[str, bytes] = {}
    for mdd_path in mdd_paths:
        mdd = MDD(str(mdd_path))
        for raw_key, raw_bytes in mdd.items():
            key = _normalize_asset_key(raw_key.decode("utf-8", errors="ignore"))
            if not key:
                continue
            archive_path = f"{asset_prefix}{key}"
            assets.setdefault(archive_path, bytes(raw_bytes))
    return assets


def _decode_stylesheet_asset(raw_bytes: bytes) -> Optional[str]:
    if not raw_bytes:
        return None

    for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be"):
        try:
            value = raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
        if "\x00" in value:
            continue
        value = value.strip()
        if value:
            return value
    return None


def _append_structured_content(container: List[object], value: object) -> None:
    if value in ("", None):
        return
    if isinstance(value, str) and container and isinstance(container[-1], str):
        container[-1] += value
        return
    container.append(value)


def _split_css_declarations(style_text: str) -> List[str]:
    declarations: List[str] = []
    quote_char = ""
    paren_depth = 0
    start_index = 0
    index = 0
    while index < len(style_text):
        char = style_text[index]
        if quote_char:
            if char == "\\":
                index += 2
                continue
            if char == quote_char:
                quote_char = ""
            index += 1
            continue
        if char in ("'", '"'):
            quote_char = char
            index += 1
            continue
        if char == "(":
            paren_depth += 1
        elif char == ")":
            paren_depth = max(0, paren_depth - 1)
        elif char == ";" and paren_depth == 0:
            declarations.append(style_text[start_index:index])
            start_index = index + 1
        index += 1
    declarations.append(style_text[start_index:])
    return declarations


def _parse_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    match = re.search(r"\d+", value)
    if match is None:
        return None
    try:
        return int(match.group(0))
    except ValueError:
        return None


def _normalize_css_class_list(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    class_names = [class_name for class_name in re.split(r"\s+", value.strip()) if class_name]
    return " ".join(class_names) if class_names else None


def _merge_structured_styles(*styles: Optional[dict[str, object]]) -> Optional[dict[str, object]]:
    merged: dict[str, object] = {}
    for style in styles:
        if not style:
            continue
        merged.update(style)
    return merged or None


def _convert_inline_style(style_text: Optional[str], asset_prefix: str) -> Optional[dict[str, object]]:
    if not style_text:
        return None

    style: dict[str, object] = {}
    for declaration in _split_css_declarations(style_text):
        property_name, separator, raw_value = declaration.partition(":")
        if separator == "":
            continue
        property_name = property_name.strip().lower()
        value = raw_value.strip()
        if not property_name or not value:
            continue
        if "url(" in value:
            value = _rewrite_css_asset_urls(value, asset_prefix, None)

        if property_name in {"text-decoration", "text-decoration-line"}:
            text_decoration_parts = [
                part
                for part in re.split(r"\s+", value)
                if part in {"underline", "overline", "line-through", "none"}
            ]
            if not text_decoration_parts:
                continue
            style["textDecorationLine"] = (
                text_decoration_parts[0]
                if len(text_decoration_parts) == 1
                else text_decoration_parts
            )
            continue

        structured_property_name = _INLINE_STYLE_PROPERTY_MAP.get(property_name)
        if structured_property_name is None:
            continue
        style[structured_property_name] = value

    return style or None


def _build_structured_data(original_tag: str, attrs: dict[str, str]) -> Optional[dict[str, str]]:
    data = {"tag": original_tag}
    class_name = _normalize_css_class_list(attrs.get("class"))
    if class_name:
        data["class"] = class_name
    element_id = attrs.get("id")
    if element_id:
        data["id"] = element_id.strip()
    return data


def _build_media_link_href(path: str) -> str:
    return f"media:{quote(path, safe='/')}"


def _convert_html_link_href(
    href: Optional[str],
    *,
    asset_prefix: str,
    enable_audio: bool,
    embedded_assets: Optional[_EmbeddedAssetCollector] = None,
) -> str:
    if not href:
        return "#"

    value = href.strip()
    lowered = value.lower()
    if lowered.startswith("entry://"):
        return f"?query={value[8:]}"
    if lowered.startswith("bword://"):
        return f"?query={value[8:]}"
    if lowered.startswith(("d:", "x:")):
        return f"?query={value[2:]}"
    if lowered.startswith("sound://"):
        sound_path = _prefix_relative_asset_path(value[8:], asset_prefix)
        if enable_audio and sound_path is not None:
            return _build_media_link_href(sound_path)
        return "#"
    if lowered.startswith(("http://", "https://", "mailto:", "tel:")):
        return value
    if lowered.startswith("data:"):
        embedded_path = embedded_assets.register_data_url(value) if embedded_assets is not None else None
        return _build_media_link_href(embedded_path) if embedded_path is not None else "#"
    if lowered.startswith(("javascript:", "about:")):
        return "#"
    if value.startswith("#"):
        return "#"

    asset_path = _prefix_relative_asset_path(value, asset_prefix)
    if asset_path is None:
        return "#"
    return _build_media_link_href(asset_path)


def _create_structured_image(
    attrs: dict[str, str],
    *,
    asset_prefix: str,
    embedded_assets: Optional[_EmbeddedAssetCollector],
) -> Optional[dict[str, object]]:
    src = attrs.get("src")
    path = _resolve_html_asset_path(src or "", asset_prefix, embedded_assets=embedded_assets)
    if path is None:
        return None

    image: dict[str, object] = {
        "tag": "img",
        "path": path,
    }
    data = _build_structured_data("img", attrs)
    if data is not None:
        image["data"] = data
    width = _parse_int(attrs.get("width"))
    if width is not None:
        image["width"] = width
    height = _parse_int(attrs.get("height"))
    if height is not None:
        image["height"] = height
    title = attrs.get("title")
    if title:
        image["title"] = title
    alt = attrs.get("alt")
    if alt:
        image["alt"] = alt
    return image


def _create_structured_element(
    original_tag: str,
    attrs: dict[str, str],
    *,
    asset_prefix: str,
    enable_audio: bool,
    embedded_assets: Optional[_EmbeddedAssetCollector],
) -> Optional[dict[str, object]]:
    normalized_tag = original_tag.lower()
    if normalized_tag in {"audio", "video"}:
        element: dict[str, object] = {
            "tag": "a",
            "href": _convert_html_link_href(
                attrs.get("src"),
                asset_prefix=asset_prefix,
                enable_audio=enable_audio,
                embedded_assets=embedded_assets,
            ),
        }
        data = _build_structured_data(normalized_tag, attrs)
        if data is not None:
            element["data"] = data
        style = _merge_structured_styles(
            _convert_inline_style(attrs.get("style"), asset_prefix),
        )
        if style is not None:
            element["style"] = style
        lang = attrs.get("lang")
        if lang:
            element["lang"] = lang
        title = attrs.get("title")
        if title:
            element["title"] = title
        return element
    mapped_tag = normalized_tag if normalized_tag in _SUPPORTED_STRUCTURED_TAGS else _HTML_TAG_MAP.get(normalized_tag)
    if mapped_tag is None:
        return None

    if mapped_tag == "img":
        return _create_structured_image(attrs, asset_prefix=asset_prefix, embedded_assets=embedded_assets)

    element: dict[str, object] = {"tag": mapped_tag}
    data = _build_structured_data(normalized_tag, attrs)
    if data is not None:
        element["data"] = data

    style = _merge_structured_styles(
        _HTML_TAG_DEFAULT_STYLES.get(normalized_tag),
        _convert_inline_style(attrs.get("style"), asset_prefix),
    )
    if style is not None and mapped_tag in {"a", "details", "div", "li", "ol", "span", "summary", "td", "th", "ul"}:
        element["style"] = style

    lang = attrs.get("lang")
    if lang:
        element["lang"] = lang

    title = attrs.get("title")
    if title:
        element["title"] = title

    if mapped_tag == "a":
        element["href"] = _convert_html_link_href(
            attrs.get("href"),
            asset_prefix=asset_prefix,
            enable_audio=enable_audio,
            embedded_assets=embedded_assets,
        )
    elif mapped_tag in {"td", "th"}:
        col_span = _parse_int(attrs.get("colspan"))
        if col_span is not None:
            element["colSpan"] = col_span
        row_span = _parse_int(attrs.get("rowspan"))
        if row_span is not None:
            element["rowSpan"] = row_span
    elif mapped_tag == "details":
        if normalized_tag == "details" and "open" in attrs:
            element["open"] = True
    elif normalized_tag == "font":
        font_color = attrs.get("color")
        font_size = attrs.get("size")
        font_face = attrs.get("face")
        extra_style: dict[str, object] = {}
        if font_color:
            extra_style["color"] = font_color
        if font_size:
            extra_style["fontSize"] = font_size
        if font_face:
            extra_style["fontFamily"] = font_face
        merged_style = _merge_structured_styles(element.get("style"), extra_style)
        if merged_style is not None:
            element["style"] = merged_style

    return element


class _MdxHtmlToStructuredContentParser(HTMLParser):
    def __init__(self, *, asset_prefix: str, enable_audio: bool, embedded_assets: _EmbeddedAssetCollector) -> None:
        super().__init__(convert_charrefs=True)
        self._asset_prefix = asset_prefix
        self._enable_audio = enable_audio
        self._embedded_assets = embedded_assets
        self._root_content: List[object] = []
        self._stack: List[_HtmlParseContext] = []
        self._inline_stylesheets: List[str] = []

    def get_structured_content(self) -> dict[str, object]:
        return {
            "tag": "div",
            "data": {
                "tag": "div",
                "class": _MDX_GLOSSARY_ROOT_CLASS,
            },
            "content": self._root_content,
        }

    def get_inline_stylesheets(self) -> List[str]:
        return [stylesheet for stylesheet in self._inline_stylesheets if stylesheet.strip()]

    def handle_starttag(self, tag: str, attrs: List[tuple[str, Optional[str]]]) -> None:
        self._handle_tag(tag, attrs, push_children=True)

    def handle_startendtag(self, tag: str, attrs: List[tuple[str, Optional[str]]]) -> None:
        self._handle_tag(tag, attrs, push_children=False)

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.lower()
        while self._stack:
            context = self._stack.pop()
            if context.mode == "style" and context.text_parts is not None:
                stylesheet = "".join(context.text_parts).strip()
                if stylesheet:
                    self._inline_stylesheets.append(stylesheet)
            if context.mode == "element" and context.fallback_text and not context.container:
                context.container.append(context.fallback_text)
            if context.tag == normalized_tag:
                break

    def handle_data(self, data: str) -> None:
        if not data:
            return
        if self._stack:
            context = self._stack[-1]
            if context.mode == "style" and context.text_parts is not None:
                context.text_parts.append(data)
                return
            if context.mode == "skip":
                return
        _append_structured_content(self._current_container(), data)

    def _current_container(self) -> List[object]:
        return self._stack[-1].container if self._stack else self._root_content

    def _handle_tag(self, tag: str, attrs: List[tuple[str, Optional[str]]], *, push_children: bool) -> None:
        normalized_tag = tag.lower()
        attrs_map = {name.lower(): (value or "") for name, value in attrs}
        if normalized_tag == "style":
            self._stack.append(_HtmlParseContext(normalized_tag, "style", self._current_container(), text_parts=[]))
            return
        if normalized_tag in {"script", "noscript"}:
            self._stack.append(_HtmlParseContext(normalized_tag, "skip", self._current_container()))
            return
        if normalized_tag == "link" and "stylesheet" in attrs_map.get("rel", "").lower():
            return
        if normalized_tag == "source" and self._stack:
            parent_context = self._stack[-1]
            if (
                parent_context.mode == "element" and
                parent_context.tag in {"audio", "video"} and
                parent_context.element is not None
            ):
                href = _convert_html_link_href(
                    attrs_map.get("src"),
                    asset_prefix=self._asset_prefix,
                    enable_audio=self._enable_audio,
                    embedded_assets=self._embedded_assets,
                )
                if href != "#":
                    parent_context.element["href"] = href
            return

        element = _create_structured_element(
            normalized_tag,
            attrs_map,
            asset_prefix=self._asset_prefix,
            enable_audio=self._enable_audio,
            embedded_assets=self._embedded_assets,
        )
        if element is None:
            if push_children:
                self._stack.append(_HtmlParseContext(normalized_tag, "transparent", self._current_container()))
            return

        _append_structured_content(self._current_container(), element)
        if push_children and normalized_tag not in {"br", "img", "link", "meta"}:
            content = element.get("content")
            if not isinstance(content, list):
                content = []
                element["content"] = content
            self._stack.append(
                _HtmlParseContext(
                    normalized_tag,
                    "element",
                    content,
                    element=element,
                    fallback_text=(normalized_tag if normalized_tag in {"audio", "video"} else None),
                ),
            )


def _split_css_selector_list(selector_text: str) -> List[str]:
    selectors: List[str] = []
    part_start = 0
    paren_depth = 0
    bracket_depth = 0
    quote_char = ""
    index = 0
    while index < len(selector_text):
        char = selector_text[index]
        if quote_char:
            if char == "\\":
                index += 2
                continue
            if char == quote_char:
                quote_char = ""
            index += 1
            continue
        if char in ("'", '"'):
            quote_char = char
            index += 1
            continue
        if char == "(":
            paren_depth += 1
        elif char == ")":
            paren_depth = max(0, paren_depth - 1)
        elif char == "[":
            bracket_depth += 1
        elif char == "]":
            bracket_depth = max(0, bracket_depth - 1)
        elif char == "," and paren_depth == 0 and bracket_depth == 0:
            selectors.append(selector_text[part_start:index])
            part_start = index + 1
        index += 1
    selectors.append(selector_text[part_start:])
    return selectors


def _split_selector_by_combinators(selector: str) -> List[str]:
    parts: List[str] = []
    start_index = 0
    quote_char = ""
    paren_depth = 0
    bracket_depth = 0
    index = 0
    while index < len(selector):
        char = selector[index]
        if quote_char:
            if char == "\\":
                index += 2
                continue
            if char == quote_char:
                quote_char = ""
            index += 1
            continue
        if char in ("'", '"'):
            quote_char = char
            index += 1
            continue
        if char == "(":
            paren_depth += 1
        elif char == ")":
            paren_depth = max(0, paren_depth - 1)
        elif char == "[":
            bracket_depth += 1
        elif char == "]":
            bracket_depth = max(0, bracket_depth - 1)
        elif paren_depth == 0 and bracket_depth == 0 and char in {">", "+", "~"}:
            if start_index < index:
                parts.append(selector[start_index:index])
            parts.append(char)
            start_index = index + 1
        elif paren_depth == 0 and bracket_depth == 0 and char.isspace():
            if start_index < index:
                parts.append(selector[start_index:index])
            whitespace_start = index
            while index < len(selector) and selector[index].isspace():
                index += 1
            parts.append(selector[whitespace_start:index])
            start_index = index
            continue
        index += 1
    if start_index < len(selector):
        parts.append(selector[start_index:])
    return parts


def _read_css_identifier(selector: str, start_index: int) -> tuple[Optional[str], int]:
    match = _RE_CSS_IDENTIFIER.match(selector, start_index)
    if match is None:
        return None, start_index
    return match.group(0), match.end()


def _rewrite_css_attribute_selector(attribute_selector: str) -> str:
    match = re.match(r"\[\s*(?P<name>[-\w]+)(?P<rest>.*)\]$", attribute_selector, re.DOTALL)
    if match is None:
        return attribute_selector
    name = match.group("name").lower()
    if name == "class":
        replacement_name = _STRUCTURED_CLASS_ATTR
    elif name == "id":
        replacement_name = _STRUCTURED_ID_ATTR
    else:
        return attribute_selector
    return f"[{replacement_name}{match.group('rest')}]"


def _migrate_css_selector_segment(selector: str, glossary_root_selector: str) -> str:
    if not selector:
        return selector

    parts: List[str] = []
    index = 0
    expect_tag_name = True
    while index < len(selector):
        char = selector[index]
        if char == ":" and selector.startswith(":root", index):
            parts.append(glossary_root_selector)
            index += 5
            expect_tag_name = False
            continue
        if char == ".":
            class_name, end_index = _read_css_identifier(selector, index + 1)
            if class_name is not None:
                parts.append(f'[{_STRUCTURED_CLASS_ATTR}~="{class_name}"]')
                index = end_index
                expect_tag_name = False
                continue
        if char == "#":
            element_id, end_index = _read_css_identifier(selector, index + 1)
            if element_id is not None:
                parts.append(f'[{_STRUCTURED_ID_ATTR}="{element_id}"]')
                index = end_index
                expect_tag_name = False
                continue
        if char == "[":
            end_index = index + 1
            quote_char = ""
            bracket_depth = 1
            while end_index < len(selector):
                inner_char = selector[end_index]
                if quote_char:
                    if inner_char == "\\":
                        end_index += 2
                        continue
                    if inner_char == quote_char:
                        quote_char = ""
                    end_index += 1
                    continue
                if inner_char in ("'", '"'):
                    quote_char = inner_char
                    end_index += 1
                    continue
                if inner_char == "[":
                    bracket_depth += 1
                elif inner_char == "]":
                    bracket_depth -= 1
                    if bracket_depth == 0:
                        end_index += 1
                        break
                end_index += 1
            parts.append(_rewrite_css_attribute_selector(selector[index:end_index]))
            index = end_index
            expect_tag_name = False
            continue
        if expect_tag_name:
            if char == "*":
                parts.append(char)
                index += 1
                expect_tag_name = False
                continue
            tag_name, end_index = _read_css_identifier(selector, index)
            if tag_name is not None:
                lowered_tag_name = tag_name.lower()
                if lowered_tag_name in {"html", "body"}:
                    parts.append(glossary_root_selector)
                else:
                    parts.append(f'[{_STRUCTURED_TAG_ATTR}="{lowered_tag_name}"]')
                index = end_index
                expect_tag_name = False
                continue
        parts.append(char)
        if not char.isspace():
            expect_tag_name = False
        index += 1
    return "".join(parts)


def _migrate_css_selector(selector: str, glossary_root_selector: str) -> str:
    selector = selector.strip()
    if not selector:
        return selector

    migrated_selector = "".join(
        (
            part
            if part.strip() == "" or part in {">", "+", "~"}
            else _migrate_css_selector_segment(part, glossary_root_selector)
        )
        for part in _split_selector_by_combinators(selector)
    )
    if not migrated_selector:
        return selector

    escaped_root_selector = re.escape(glossary_root_selector)
    repeated_root_pattern = re.compile(
        rf"{escaped_root_selector}(?:\s*(?:[>+~]|\s)\s*{escaped_root_selector})+",
    )
    while True:
        next_selector = repeated_root_pattern.sub(glossary_root_selector, migrated_selector)
        if next_selector == migrated_selector:
            break
        migrated_selector = next_selector
    return re.sub(r"\s+", " ", migrated_selector).strip()


def _find_matching_css_brace(stylesheet: str, block_start_index: int) -> int:
    depth = 0
    quote_char = ""
    index = block_start_index
    while index < len(stylesheet):
        char = stylesheet[index]
        if stylesheet.startswith("/*", index):
            comment_end = stylesheet.find("*/", index + 2)
            if comment_end < 0:
                return len(stylesheet) - 1
            index = comment_end + 2
            continue
        if quote_char:
            if char == "\\":
                index += 2
                continue
            if char == quote_char:
                quote_char = ""
            index += 1
            continue
        if char in ("'", '"'):
            quote_char = char
            index += 1
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return len(stylesheet) - 1


def _rewrite_css_rule_selectors(stylesheet: str, glossary_root_selector: str) -> str:
    parts: List[str] = []
    index = 0
    while index < len(stylesheet):
        prelude_start_index = index
        while prelude_start_index < len(stylesheet):
            if stylesheet.startswith("/*", prelude_start_index):
                comment_end = stylesheet.find("*/", prelude_start_index + 2)
                if comment_end < 0:
                    parts.append(stylesheet[index:])
                    return "".join(parts)
                prelude_start_index = comment_end + 2
                continue
            if stylesheet[prelude_start_index].isspace():
                prelude_start_index += 1
                continue
            break

        parts.append(stylesheet[index:prelude_start_index])
        if prelude_start_index >= len(stylesheet):
            break

        cursor = prelude_start_index
        quote_char = ""
        paren_depth = 0
        bracket_depth = 0
        while cursor < len(stylesheet):
            char = stylesheet[cursor]
            if stylesheet.startswith("/*", cursor):
                comment_end = stylesheet.find("*/", cursor + 2)
                if comment_end < 0:
                    parts.append(stylesheet[prelude_start_index:])
                    return "".join(parts)
                cursor = comment_end + 2
                continue
            if quote_char:
                if char == "\\":
                    cursor += 2
                    continue
                if char == quote_char:
                    quote_char = ""
                cursor += 1
                continue
            if char in ("'", '"'):
                quote_char = char
                cursor += 1
                continue
            if char == "(":
                paren_depth += 1
            elif char == ")":
                paren_depth = max(0, paren_depth - 1)
            elif char == "[":
                bracket_depth += 1
            elif char == "]":
                bracket_depth = max(0, bracket_depth - 1)
            elif char == ";" and paren_depth == 0 and bracket_depth == 0:
                parts.append(stylesheet[prelude_start_index:cursor + 1])
                index = cursor + 1
                break
            elif char == "{" and paren_depth == 0 and bracket_depth == 0:
                prelude = stylesheet[prelude_start_index:cursor]
                block_end_index = _find_matching_css_brace(stylesheet, cursor)
                body = stylesheet[cursor + 1:block_end_index]
                stripped_prelude = prelude.strip()
                if stripped_prelude.startswith("@"):
                    at_rule_name = stripped_prelude[1:].split(None, 1)[0].lower()
                    if at_rule_name in {"media", "supports", "layer", "container", "document"}:
                        body = _rewrite_css_rule_selectors(body, glossary_root_selector)
                    parts.append(f"{prelude}{{{body}}}")
                else:
                    migrated_selectors: List[str] = []
                    seen_selectors = set()
                    for selector in _split_css_selector_list(prelude):
                        migrated_selector = _migrate_css_selector(selector, glossary_root_selector)
                        if not migrated_selector or migrated_selector in seen_selectors:
                            continue
                        seen_selectors.add(migrated_selector)
                        migrated_selectors.append(migrated_selector)
                    if migrated_selectors:
                        parts.append(f"{', '.join(migrated_selectors)}{{{body}}}")
                    else:
                        parts.append(f"{prelude}{{{body}}}")

                index = block_end_index + 1
                break
            cursor += 1
        else:
            parts.append(stylesheet[prelude_start_index:])
            break
    return "".join(parts)


def _rewrite_css_asset_urls(
    stylesheet: str,
    asset_prefix: str,
    source_asset_path: Optional[str],
) -> str:
    def replace(match: re.Match[str]) -> str:
        raw_path = match.group("path").strip()
        prefixed_path = _prefix_relative_asset_path(raw_path, asset_prefix, source_asset_path)
        if prefixed_path is None:
            return match.group(0)
        return f'url("{prefixed_path}")'

    return _RE_CSS_URL.sub(replace, stylesheet)


def _migrate_stylesheet_for_yomitan(
    stylesheet: str,
    asset_prefix: str,
    source_asset_path: Optional[str],
) -> str:
    migrated = _rewrite_css_asset_urls(stylesheet, asset_prefix, source_asset_path)
    return _rewrite_css_rule_selectors(migrated, _STRUCTURED_ROOT_SELECTOR)


def _build_root_stylesheet(
    assets: Dict[str, bytes],
    asset_prefix: str,
    inline_stylesheets: Optional[List[tuple[str, str]]] = None,
) -> Optional[str]:
    css_sections: List[str] = []
    prefix_length = len(asset_prefix)
    for archive_path in sorted(assets):
        if not archive_path.lower().endswith(".css"):
            continue
        stylesheet = _decode_stylesheet_asset(assets[archive_path])
        if stylesheet is None:
            continue
        source_name = archive_path[prefix_length:] if archive_path.startswith(asset_prefix) else archive_path
        stylesheet = _migrate_stylesheet_for_yomitan(stylesheet, asset_prefix, source_name)
        css_sections.append(f"/* Source: {source_name} */\n{stylesheet}")

    for source_name, stylesheet in inline_stylesheets or []:
        migrated_stylesheet = _migrate_stylesheet_for_yomitan(stylesheet, asset_prefix, None)
        css_sections.append(f"/* Source: {source_name} */\n{migrated_stylesheet}")

    if not css_sections:
        return None

    return "\n\n".join(css_sections) + "\n"


def convert_mdx_to_yomitan_zip(
    mdx_path: Path,
    out_zip_path: Path,
    *,
    options: ConvertOptions,
    explicit_mdds: Optional[List[Path]] = None,
) -> Path:
    mdx = MDX(str(mdx_path), "", True)
    redirects = _build_redirect_map(mdx)

    title = _extract_title(mdx, mdx_path, options.title_override)
    description = _extract_description(mdx, options.description_override)
    mdd_paths = explicit_mdds if explicit_mdds is not None else _discover_mdds(mdx_path)
    assets = _iter_assets(mdd_paths, options.asset_prefix) if options.include_assets else {}
    inline_stylesheets: List[tuple[str, str]] = []

    sequence = 0
    bank_index = 1
    bank: List[list] = []

    with zipfile.ZipFile(out_zip_path, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        index = {
            "title": title,
            "revision": options.revision,
            "sequenced": True,
            "format": 3,
            "description": description,
        }
        archive.writestr("index.json", json.dumps(index, ensure_ascii=False))

        for raw_term, raw_definition in mdx.items():
            term = raw_term.decode("utf-8", errors="ignore").strip()
            definition = raw_definition.decode("utf-8", errors="ignore").strip()
            if not term or definition.startswith("@@@LINK="):
                continue

            fixed_definition, definition_inline_stylesheets, definition_assets = _convert_definition_to_structured_content(
                definition,
                enable_audio=options.enable_audio,
                asset_prefix=options.asset_prefix,
            )
            for archive_path, data in definition_assets.items():
                assets.setdefault(archive_path, data)
            for stylesheet_index, stylesheet in enumerate(definition_inline_stylesheets, 1):
                inline_stylesheets.append((f"inline/{term}-{stylesheet_index}.css", stylesheet))
            expressions = [term, *redirects.get(term, [])]
            for expression in expressions:
                bank.append([
                    expression,
                    "",
                    "",
                    "",
                    0,
                    [fixed_definition],
                    sequence,
                    "",
                ])
            sequence += 1

            if len(bank) >= options.term_bank_size:
                archive.writestr(
                    f"term_bank_{bank_index}.json",
                    json.dumps(bank, ensure_ascii=False),
                )
                bank.clear()
                bank_index += 1

        root_stylesheet = _build_root_stylesheet(assets, options.asset_prefix, inline_stylesheets)
        if bank:
            archive.writestr(
                f"term_bank_{bank_index}.json",
                json.dumps(bank, ensure_ascii=False),
            )

        if root_stylesheet is not None:
            archive.writestr("styles.css", root_stylesheet)

        for archive_path, data in assets.items():
            archive.writestr(archive_path, data)

    return out_zip_path


def _build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert an MDX dictionary into a Yomitan archive.")
    parser.add_argument("mdx", type=Path, help="Path to the source .mdx file")
    parser.add_argument("out_zip", type=Path, help="Path to the output .zip archive")
    parser.add_argument("--title-override", type=str, default=None, help="Override the output dictionary title")
    parser.add_argument("--description-override", type=str, default=None, help="Override the output dictionary description")
    parser.add_argument("--revision", type=str, default="mdx import", help="Revision string to write to index.json")
    parser.add_argument("--term-bank-size", type=int, default=10_000, help="Maximum rows per term bank file")
    parser.add_argument("--enable-audio", action="store_true", help="Convert sound:// links to <audio> elements")
    parser.add_argument("--skip-assets", action="store_true", help="Skip MDD resource extraction")
    parser.add_argument("--mdd", dest="mdds", action="append", type=Path, default=None, help="Explicit companion .mdd path (repeatable)")
    return parser


def main() -> int:
    parser = _build_argument_parser()
    args = parser.parse_args()
    options = ConvertOptions(
        title_override=args.title_override,
        description_override=args.description_override,
        revision=args.revision,
        term_bank_size=args.term_bank_size,
        enable_audio=args.enable_audio,
        include_assets=not args.skip_assets,
    )
    convert_mdx_to_yomitan_zip(
        args.mdx,
        args.out_zip,
        options=options,
        explicit_mdds=args.mdds,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
