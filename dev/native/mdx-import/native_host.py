"""
Native messaging host for Manabitan's experimental MDX import flow.

The browser-side client speaks a simple request/response protocol over a
long-lived `chrome.runtime.connectNative(...)` port. Each message contains:

    {
        "action": "<string>",
        "params": {...},
        "sequence": <number>
    }

Replies mirror the same sequence:

    {
        "sequence": <number>,
        "data": <json-serializable payload>
    }

Large file content is transferred in base64-encoded chunks using the
`begin_upload` / `upload_chunk` / `finish_upload` and
`download_begin` / `download_chunk` / `download_end` actions.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

from mdx_to_yomitan import ConvertOptions, convert_mdx_to_yomitan_zip


PROTOCOL_VERSION = 1
_MDD_FILE_NAME_RE = re.compile(r"^(?P<base>.*?)(?:\.(?P<index>\d+))?\.mdd$", re.IGNORECASE)


def _normalize_logical_file_name(file_name: str) -> str:
    value = file_name.replace("\\", "/").strip()
    value = value.lstrip("/")
    return value or "upload.bin"


def _get_logical_base_name(file_name: str) -> str:
    normalized_name = Path(_normalize_logical_file_name(file_name)).name
    lower_name = normalized_name.lower()
    if lower_name.endswith(".mdx"):
        return lower_name[:-4]
    match = _MDD_FILE_NAME_RE.match(lower_name)
    if match is not None:
        return match.group("base")
    return lower_name


def _get_mdd_sort_key(file_name: str) -> tuple[int, str]:
    normalized_name = Path(_normalize_logical_file_name(file_name)).name
    match = _MDD_FILE_NAME_RE.match(normalized_name)
    if match is None:
        return (0, normalized_name.lower())
    index_text = match.group("index")
    index = int(index_text) if index_text is not None else 0
    return (index, normalized_name.lower())


def _classify_conversion_error(error: Exception) -> Dict[str, Any]:
    message = str(error).strip() or "MDX conversion failed."
    lowered = message.lower()
    if any(token in lowered for token in ("encrypted", "password", "decrypt")):
        code = "mdx-encrypted"
        user_message = (
            "This MDX dictionary appears to be encrypted or password-protected. "
            "The experimental helper cannot convert protected MDX files automatically."
        )
    elif any(token in lowered for token in ("lzo", "xxhash", "unsupported compression", "compression not supported")):
        code = "mdx-unsupported-compression"
        user_message = (
            "This MDX dictionary uses a compression variant the current helper cannot decode. "
            "Try a newer helper build or convert it externally first."
        )
    elif any(token in lowered for token in ("unsupported", "unknown version", "invalid format", "not a valid mdict")):
        code = "mdx-unsupported-variant"
        user_message = (
            "This MDX dictionary uses an unsupported MDict variant. "
            "Try a newer helper build or convert it externally first."
        )
    elif any(token in lowered for token in ("corrupt", "malformed", "truncated", "checksum")):
        code = "mdx-invalid-data"
        user_message = (
            "This MDX dictionary appears to be corrupt or incomplete, so the helper could not convert it."
        )
    else:
        code = "mdx-convert-failed"
        user_message = message
    return {
        "message": user_message,
        "type": error.__class__.__name__,
        "code": code,
        "details": message,
    }


def _read_exact(length: int) -> bytes:
    data = b""
    while len(data) < length:
        chunk = os.read(0, length - len(data))
        if not chunk:
            raise EOFError("native messaging pipe closed")
        data += chunk
    return data


def read_message() -> Dict[str, Any]:
    raw_length = _read_exact(4)
    (length,) = struct.unpack("<I", raw_length)
    payload = _read_exact(length)
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected object message")
    return value


def write_message(message: Dict[str, Any]) -> None:
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    os.write(1, struct.pack("<I", len(payload)))
    os.write(1, payload)


@dataclass
class Upload:
    path: Path
    file_name: str
    total_bytes: int
    received_bytes: int = 0


@dataclass
class Job:
    archive_path: Path
    archive_file_name: str
    total_bytes: int


class HostState:
    def __init__(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="manabitan-mdx-"))
        self._uploads: Dict[str, Upload] = {}
        self._jobs: Dict[str, Job] = {}
        self._next_upload_id = 1
        self._next_job_id = 1

    def cleanup(self) -> None:
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def begin_upload(self, file_name: str, total_bytes: int) -> Dict[str, Any]:
        upload_id = f"u{self._next_upload_id}"
        self._next_upload_id += 1
        safe_name = Path(_normalize_logical_file_name(file_name)).name or f"{upload_id}.bin"
        path = self._tmpdir / "uploads" / upload_id / safe_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
        self._uploads[upload_id] = Upload(
            path=path,
            file_name=file_name,
            total_bytes=int(total_bytes),
        )
        return {"uploadId": upload_id}

    def upload_chunk(self, upload_id: str, offset: int, data_b64: str) -> bool:
        upload = self._uploads[upload_id]
        data = base64.b64decode(data_b64.encode("ascii"))
        with upload.path.open("r+b") as handle:
            handle.seek(int(offset))
            handle.write(data)
        upload.received_bytes = max(upload.received_bytes, int(offset) + len(data))
        return True

    def finish_upload(self, upload_id: str) -> bool:
        upload = self._uploads[upload_id]
        if upload.received_bytes != upload.total_bytes:
            raise ValueError(
                f"upload {upload_id} incomplete: "
                f"{upload.received_bytes}/{upload.total_bytes}",
            )
        return True

    def _get_companion_mdd_uploads(self, mdx_upload_id: str, requested_upload_ids: List[str]) -> List[Upload]:
        if requested_upload_ids:
            companion_uploads = [self._uploads[upload_id] for upload_id in requested_upload_ids]
        else:
            mdx_upload = self._uploads[mdx_upload_id]
            target_base = _get_logical_base_name(mdx_upload.file_name)
            companion_uploads = []
            for upload_id, upload in self._uploads.items():
                if upload_id == mdx_upload_id:
                    continue
                lower_name = Path(_normalize_logical_file_name(upload.file_name)).name.lower()
                if _MDD_FILE_NAME_RE.match(lower_name) is None:
                    continue
                if _get_logical_base_name(upload.file_name) != target_base:
                    continue
                companion_uploads.append(upload)
        companion_uploads.sort(key=lambda upload: _get_mdd_sort_key(upload.file_name))
        return companion_uploads

    def _prepare_conversion_workspace(self, job_id: str, mdx_upload: Upload, companion_uploads: List[Upload]) -> Path:
        workspace = self._tmpdir / "jobs" / job_id
        workspace.mkdir(parents=True, exist_ok=True)
        mdx_name = Path(_normalize_logical_file_name(mdx_upload.file_name)).name
        staged_mdx_path = workspace / mdx_name
        shutil.copyfile(mdx_upload.path, staged_mdx_path)
        for upload in companion_uploads:
            companion_name = Path(_normalize_logical_file_name(upload.file_name)).name
            staged_companion_path = workspace / companion_name
            shutil.copyfile(upload.path, staged_companion_path)
        return staged_mdx_path

    def convert(self, mdx_upload_id: str, mdd_upload_ids: List[str], options: Dict[str, Any]) -> str:
        mdx_upload = self._uploads[mdx_upload_id]
        companion_uploads = self._get_companion_mdd_uploads(mdx_upload_id, mdd_upload_ids)
        job_id = f"j{self._next_job_id}"
        self._next_job_id += 1
        staged_mdx_path = self._prepare_conversion_workspace(job_id, mdx_upload, companion_uploads)
        archive_file_name = f"{staged_mdx_path.stem}.zip"
        archive_path = self._tmpdir / "jobs" / job_id / archive_file_name
        convert_options = ConvertOptions(
            title_override=options.get("titleOverride") or None,
            description_override=options.get("descriptionOverride") or None,
            revision=options.get("revision") or "mdx import",
            term_bank_size=int(options.get("termBankSize") or 10_000),
            enable_audio=bool(options.get("enableAudio")),
            include_assets=bool(options.get("includeAssets", True)),
        )
        convert_mdx_to_yomitan_zip(
            staged_mdx_path,
            archive_path,
            options=convert_options,
            explicit_mdds=None,
        )
        self._jobs[job_id] = Job(
            archive_path=archive_path,
            archive_file_name=archive_file_name,
            total_bytes=archive_path.stat().st_size,
        )
        return job_id

    def download_begin(self, job_id: str, _chunk_bytes: int) -> Dict[str, Any]:
        job = self._jobs[job_id]
        return {
            "totalBytes": job.total_bytes,
            "archiveFileName": job.archive_file_name,
        }

    def download_chunk(self, job_id: str, offset: int, chunk_bytes: int) -> Dict[str, Any]:
        job = self._jobs[job_id]
        with job.archive_path.open("rb") as handle:
            handle.seek(int(offset))
            chunk = handle.read(int(chunk_bytes))
        return {"data": base64.b64encode(chunk).decode("ascii")}

    def download_end(self, job_id: str) -> bool:
        job = self._jobs.pop(job_id)
        shutil.rmtree(job.archive_path.parent, ignore_errors=True)
        return True


def handle_message(state: HostState, message: Dict[str, Any]) -> Dict[str, Any]:
    sequence = message.get("sequence")
    action = message.get("action")
    params = message.get("params")
    if not isinstance(sequence, int):
        raise ValueError("message missing integer sequence")
    if not isinstance(action, str):
        raise ValueError("message missing action")
    if not isinstance(params, dict):
        raise ValueError("message missing params object")

    if action == "get_version":
        data: Any = PROTOCOL_VERSION
    elif action == "begin_upload":
        data = state.begin_upload(
            file_name=str(params.get("fileName", "")),
            total_bytes=int(params.get("totalBytes", 0)),
        )
    elif action == "upload_chunk":
        data = state.upload_chunk(
            upload_id=str(params["uploadId"]),
            offset=int(params.get("offset", 0)),
            data_b64=str(params.get("data", "")),
        )
    elif action == "finish_upload":
        data = state.finish_upload(str(params["uploadId"]))
    elif action == "convert":
        data = state.convert(
            mdx_upload_id=str(params["mdxUploadId"]),
            mdd_upload_ids=[str(value) for value in params.get("mddUploadIds", [])],
            options=dict(params.get("options", {})),
        )
    elif action == "download_begin":
        data = state.download_begin(
            job_id=str(params["jobId"]),
            _chunk_bytes=int(params.get("chunkBytes", 0)),
        )
    elif action == "download_chunk":
        data = state.download_chunk(
            job_id=str(params["jobId"]),
            offset=int(params.get("offset", 0)),
            chunk_bytes=int(params.get("chunkBytes", 0)),
        )
    elif action == "download_end":
        data = state.download_end(str(params["jobId"]))
    else:
        raise ValueError(f"unsupported action: {action}")

    return {"sequence": sequence, "data": data}


def main() -> int:
    state = HostState()
    try:
        while True:
            try:
                message = read_message()
            except EOFError:
                break
            try:
                response = handle_message(state, message)
            except Exception as error:  # pragma: no cover - defensive host boundary
                action = message.get("action")
                serialized_error = (
                    _classify_conversion_error(error)
                    if action == "convert" and isinstance(error, Exception)
                    else {
                        "message": str(error),
                        "type": error.__class__.__name__,
                    }
                )
                response = {
                    "sequence": message.get("sequence"),
                    "data": {
                        "error": serialized_error,
                    },
                }
            write_message(response)
    finally:
        state.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
