#!/usr/bin/env python3
"""Install identical, JMdict-only post-restart byte audits in verification roots.

This instrumentation is for separate correctness observations only. Never use
its runs as timing or memory observations. Release packages are unchanged.
Copyright (C) 2026 Manabitan authors
SPDX-License-Identifier: GPL-3.0-or-later
"""

import argparse
import hashlib
import json
from pathlib import Path


HARNESS_PATH = "test/chromium/extension-two-dictionary-import.e2e.js"
SOURCE_SHA256 = "d0ae122bd22f7b460cedb11f06d2cb018224674abf9669e0fed567b5f3a870cf"
LOCK_PATH = "test/perf/dictionaries.lock.json"
AUDIT_KIND = "OPFS complete raw and generation-normalized byte audit after restart; separate JMdict correctness observation v1"
ALGORITHM = "SHA-256 per consecutive 4 MiB chunk; generation normalization v1"
NORMALIZATION = [
    {"format": "MBTRD16X", "offset": 8, "bytes": 16},
    {"format": "MBTIDX11", "offset": 24, "bytes": 16},
]
OLD_VISIT = """                            if (handle.kind === 'directory') { await visit(handle, `${filePath}/`); } else { files.push({path: filePath, bytes: (await handle.getFile()).size}); }"""
NEW_VISIT = """                            if (handle.kind === 'directory') {
                                await visit(handle, `${filePath}/`);
                            } else {
                                const file = await handle.getFile();
                                const entry = {path: filePath, bytes: file.size};
                                if (filePath.startsWith('manabitan-dictionary-media-v1/')) {
                                    throw new Error('Generation media is outside the JMdict byte-audit scope');
                                }
                                // Preserve raw hashes. A second hash zeros only
                                // the parsed generation ID; every other byte,
                                // including payload checksums, remains covered.
                                if (!filePath.startsWith('manabitan/sqlite-sahpool-v1/.opaque/')) {
                                    const hex = (bytes) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
                                    const sha256 = async (input) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
                                    const ranges = [];
                                    const record = /^manabitan-term-records\\/[^/]+\\.mbtr$/.test(filePath);
                                    const lookup = /^manabitan-term-records\\/[^/]+\\.mbtr\\.mbti$/.test(filePath);
                                    if (record || lookup) {
                                        let header = new Uint8Array(await file.slice(0, record ? 30 : 40).arrayBuffer());
                                        const expectedMagic = record ? 'MBTRD16X' : 'MBTIDX11';
                                        if (header.length < (record ? 26 : 40) || new TextDecoder().decode(header.subarray(0, 8)) !== expectedMagic) {
                                            throw new Error('Unsupported or truncated record/lookup header');
                                        }
                                        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
                                        if (record) {
                                            let meta = view.getUint16(24, true);
                                            let headerBytes = 26;
                                            if (meta === 0xffff) {
                                                if (header.length < 30) { throw new Error('Truncated extended record header'); }
                                                meta = view.getUint32(26, true);
                                                headerBytes = 30;
                                                if (meta <= 0x7fff) { throw new Error('Noncanonical extended record header'); }
                                            } else if (meta > 0x7fff) {
                                                throw new Error('Noncanonical short record header');
                                            }
                                            const code = meta & 0xff;
                                            const nameBytes = code === 0xff ? meta >>> 8 : 0;
                                            if ((code !== 0xff && (code > 5 || meta !== code)) ||
                                                (code === 0xff && (nameBytes === 0 || nameBytes > 65535))) {
                                                throw new Error('Unsupported record content dictionary metadata');
                                            }
                                            headerBytes += nameBytes;
                                            if (file.size < headerBytes) { throw new Error('Truncated record dictionary name'); }
                                            header = new Uint8Array(await file.slice(0, headerBytes).arrayBuffer());
                                            if (header.length !== headerBytes) { throw new Error('Truncated record header read'); }
                                            if (nameBytes > 0) { new TextDecoder('utf-8', {fatal: true}).decode(header.subarray(headerBytes - nameBytes)); }
                                        } else {
                                            const descriptorBytes = Number(view.getBigUint64(8, true));
                                            const chunkCount = view.getUint32(16, true);
                                            const recordCount = view.getUint32(20, true);
                                            if (!Number.isSafeInteger(descriptorBytes) || descriptorBytes < 26 ||
                                                chunkCount === 0 || recordCount === 0 || chunkCount > recordCount ||
                                                file.size < 40 + chunkCount * 40) {
                                                throw new Error('Invalid lookup header framing');
                                            }
                                        }
                                        Reflect.set(entry, 'identityHeader', {format: expectedMagic, hex: hex(header)});
                                        ranges.push({offset: record ? 8 : 24, bytes: 16});
                                    }
                                    const chunks = [];
                                    const chunkBytes = 4 * 1024 * 1024;
                                    for (let offset = 0; offset < file.size; offset += chunkBytes) {
                                        const bytes = Math.min(chunkBytes, file.size - offset);
                                        const input = await file.slice(offset, offset + bytes).arrayBuffer();
                                        if (input.byteLength !== bytes) { throw new Error('Storage byte audit read was truncated'); }
                                        const rawSha256 = await sha256(input);
                                        let normalizedSha256 = rawSha256;
                                        if (ranges.some((range) => range.offset < offset + bytes && range.offset + range.bytes > offset)) {
                                            const normalized = new Uint8Array(input.slice(0));
                                            for (const range of ranges) {
                                                const start = Math.max(offset, range.offset);
                                                const end = Math.min(offset + bytes, range.offset + range.bytes);
                                                if (start < end) { normalized.fill(0, start - offset, end - offset); }
                                            }
                                            normalizedSha256 = await sha256(normalized);
                                        }
                                        chunks.push({offset, bytes, sha256: rawSha256, normalizedSha256});
                                    }
                                    const after = await handle.getFile();
                                    if (after.size !== file.size || after.lastModified !== file.lastModified) { throw new Error('Storage changed during byte audit'); }
                                    Reflect.set(entry, 'byteAudit', {algorithm: 'SHA-256 per consecutive 4 MiB chunk; generation normalization v1', chunkBytes, ranges, chunks});
                                }
                                files.push(entry);
                            }"""
OLD_RETURN = "                    return {kind: 'OPFS logical file sizes after restart and verification', bytes: files.reduce((sum, file) => sum + file.bytes, 0), files};"
NEW_RETURN = """                    const byPath = new Map(files.map((entry) => [entry.path, entry]));
                    for (const entry of files) {
                        const identity = Reflect.get(entry, 'identityHeader');
                        if (!identity) { continue; }
                        if (identity.format === 'MBTRD16X') {
                            const partner = byPath.get(`${entry.path}.mbti`);
                            if (!partner || Reflect.get(partner, 'identityHeader')?.format !== 'MBTIDX11') { throw new Error('Unpaired record header'); }
                        } else {
                            const partner = byPath.get(entry.path.slice(0, -5));
                            const record = partner && Reflect.get(partner, 'identityHeader');
                            const header = Uint8Array.from(identity.hex.match(/../g), (value) => Number.parseInt(value, 16));
                            if (!record || record.format !== 'MBTRD16X' ||
                                record.hex.slice(16, 48) !== identity.hex.slice(48, 80) ||
                                Number(new DataView(header.buffer).getBigUint64(8, true)) !== partner.bytes) {
                                throw new Error('Record/lookup generation or descriptor length mismatch');
                            }
                        }
                    }
                    return {kind: 'OPFS complete raw and generation-normalized byte audit after restart; separate JMdict correctness observation v1', bytes: files.reduce((sum, file) => sum + file.bytes, 0), files};"""
OLD_REPORT = "    const report = createReport();"
OLD_SUMMARY = "        packageSha256: report.packageSha256,"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-root", required=True, type=Path)
    parser.add_argument("--candidate-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    paths = {arm: root.resolve() / HARNESS_PATH for arm, root in
             (("A", args.baseline_root), ("B", args.candidate_root))}
    before = {arm: path.read_bytes() for arm, path in paths.items()}
    if before["A"] != before["B"] or digest(before["A"]) != SOURCE_SHA256:
        raise RuntimeError("Verification roots do not have the exact common pinned harness")
    locks = {arm: (path.parent.parent.parent / LOCK_PATH).read_bytes() for arm, path in paths.items()}
    if locks["A"] != locks["B"]:
        raise RuntimeError("Verification roots have different fixture locks")
    installer_sha = digest(Path(__file__).read_bytes())
    new_report = OLD_REPORT + "\n" + "\n".join([
        "    report.byteAuditProvenance = {",
        f"        sourceHarnessSha256: '{SOURCE_SHA256}',",
        f"        installerSha256: '{installer_sha}',",
        "        patchedHarnessSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),",
        "        fixtureLockSha256: createHash('sha256').update(await readFile(new URL('../perf/dictionaries.lock.json', import.meta.url))).digest('hex'),",
        "    };",
    ])
    source = before["A"].decode()
    if any(source.count(anchor) != 1 for anchor in (OLD_VISIT, OLD_RETURN, OLD_REPORT, OLD_SUMMARY)):
        raise RuntimeError("Expected unique post-restart storage observer")
    patched = (source.replace(OLD_VISIT, NEW_VISIT).replace(OLD_RETURN, NEW_RETURN)
               .replace(OLD_REPORT, new_report)
               .replace(OLD_SUMMARY, OLD_SUMMARY + "\n        byteAuditProvenance: report.byteAuditProvenance,").encode())
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = {
        "scope": "JMdict only; raw hashes retained; equality except validated paired generation IDs; not timing or memory evidence",
        "sourceHarnessSha256": SOURCE_SHA256,
        "patchedHarnessSha256": digest(patched),
        "installerSha256": installer_sha,
        "fixtureLockSha256": digest(locks["A"]),
        "chunkBytes": 4 * 1024 * 1024,
        "algorithm": ALGORITHM,
        "kind": AUDIT_KIND,
        "normalization": NORMALIZATION,
        "excludedPrefix": "manabitan/sqlite-sahpool-v1/.opaque/",
        "roots": {arm: str(path.parent.parent.parent) for arm, path in paths.items()},
    }
    for path in dict.fromkeys(paths.values()):
        path.write_bytes(patched)
    for path in paths.values():
        if digest(path.read_bytes()) != manifest["patchedHarnessSha256"]:
            raise RuntimeError("Patched harness differs between verification roots")
    (args.output / "instrumentation.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
