"""Verify downloaded GitHub ZIP bytes, then extract only safe regular files."""
from pathlib import Path, PurePosixPath, PureWindowsPath
import hashlib
import json
import shutil
import stat
import sys
import tempfile
import zipfile

source, destination = map(Path, sys.argv[1:3])
expected_sha, expected_size = sys.argv[3], int(sys.argv[4])
payload = source.read_bytes()
actual_sha = hashlib.sha256(payload).hexdigest()
assert len(payload) == expected_size and actual_sha == expected_sha
assert not destination.exists(), 'Destination must be fresh'
destination.parent.mkdir(parents=True, exist_ok=True)
temporary = Path(tempfile.mkdtemp(prefix=destination.name + '-extract-', dir=destination.parent))
try:
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        seen = set()
        assert len(entries) <= 1000
        assert sum(item.file_size for item in entries) <= 256 * 1024 * 1024
        for item in entries:
            name = item.filename
            assert name and '\\' not in name and '\x00' not in name
            assert not PurePosixPath(name).is_absolute() and not PureWindowsPath(name).drive
            assert all(part not in ('', '.', '..') for part in name.rstrip('/').split('/'))
            relative = PurePosixPath(name)
            assert relative not in seen
            seen.add(relative)
            mode = item.external_attr >> 16
            assert not stat.S_ISLNK(mode)
            assert stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)
            assert item.file_size <= 64 * 1024 * 1024 and not item.flag_bits & 1
        assert archive.testzip() is None
        for item in entries:
            target = temporary / item.filename
            assert target.resolve().is_relative_to(temporary.resolve())
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as output, archive.open(item) as content:
                    shutil.copyfileobj(content, output)
                assert target.stat().st_size == item.file_size
        temporary.rename(destination)
        print(json.dumps({'zip': str(source), 'destination': str(destination), 'sizeBytes': len(payload),
                          'sha256': actual_sha, 'files': sum(not item.is_dir() for item in entries),
                          'uncompressedBytes': sum(item.file_size for item in entries), 'crc': 'passed'}))
except BaseException:
    shutil.rmtree(temporary)
    raise
