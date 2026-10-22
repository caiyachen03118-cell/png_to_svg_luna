"""Prepare raster-only held-out sources; never decode embedded PNG text/editor data."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parent
SOURCES = [
    {
        "id": "test-01", "candidateFile": "candidate-object.png",
        "title": "Object detector 1stage vs 2 stage",
        "sourcePage": "https://commons.wikimedia.org/wiki/File:Object_detector_1stage_vs_2_stage.png",
        "sourcePageRevision": "https://commons.wikimedia.org/w/index.php?title=File:Object_detector_1stage_vs_2_stage.png&oldid=707978737",
        "imageUrl": "https://upload.wikimedia.org/wikipedia/commons/2/20/Object_detector_1stage_vs_2_stage.png",
        "paperSource": "https://doi.org/10.1109/ACCESS.2019.2939201",
        "author": "Licheng Jiao, Fan Zhang, Fang Liu, Shuyuan Yang (as credited by the Commons file page)",
        "license": "CC BY 4.0 (image-specific statement on Commons)",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "selectionCriteria": "Native rotated label, directed connections, moderate label density and two photographic regions.",
    },
    {
        "id": "test-02", "candidateFile": "candidate-mact.png",
        "title": "MACT framework",
        "sourcePage": "https://github.com/boschresearch/MACT/blob/main/framework.png",
        "repositoryPage": "https://github.com/boschresearch/MACT",
        "imageUrl": "https://raw.githubusercontent.com/boschresearch/MACT/main/framework.png",
        "paperSource": "https://arxiv.org/abs/2412.20145",
        "author": "Unknown individual illustrator; hosted in the paper authors' official boschresearch/MACT repository. Paper authors: Wei Zhou, Mohsen Mesgar, Annemarie Friedrich, Heike Adel.",
        "license": "unknown for this image and its third-party icon components specifically",
        "repositoryLicense": "AGPL-3.0",
        "licenseUrl": "https://github.com/boschresearch/MACT/blob/main/LICENSE.txt",
        "licenseNote": "The official repository license is verified. LICENSE.txt and 3rd-party-licenses.txt do not establish image/component-specific licensing. Do not infer that every embedded icon is AGPL or freely reusable.",
        "selectionCriteria": "Multiple detailed icons, directed workflow arrows, dashed panels, tables, and moderate text. Original raster is only 547 x 527, which is a documented input-resolution limitation.",
    },
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def clean_png(data: bytes):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Expected original PNG raster")
    pos, chunks, removed, idat = 8, [data[:8]], [], []
    width = height = None
    seen_end = False
    while pos < len(data):
        size = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        end = pos + 12 + size
        if end > len(data):
            raise ValueError("Truncated PNG chunk")
        # Only read chunk type and length for text. Never parse or decompress its payload.
        if kind in {b"tEXt", b"zTXt", b"iTXt"}:
            removed.append({"type": kind.decode("ascii"), "length": size})
        else:
            payload = data[pos + 8:pos + 8 + size]
            expected_crc = struct.unpack(">I", data[pos + 8 + size:end])[0]
            if zlib.crc32(kind + payload) & 0xffffffff != expected_crc:
                raise ValueError("PNG CRC mismatch")
            chunks.append(data[pos:end])
            if kind == b"IHDR":
                width, height = struct.unpack(">II", payload[:8])
            if kind == b"IDAT":
                idat.append(payload)
            if kind == b"IEND":
                seen_end = True
                break
        pos = end
    if not seen_end or width is None:
        raise ValueError("Incomplete PNG")
    # Bytes after IEND are discarded without interpretation, if any.
    trailing = len(data) - end
    return b"".join(chunks), width, height, removed, sha256(b"".join(idat)), trailing


def main():
    records = []
    for source in SOURCES:
        candidate = ROOT / source["candidateFile"]
        if candidate.exists():
            raw = candidate.read_bytes()
        else:
            req = urllib.request.Request(source["imageUrl"], headers={"User-Agent": "DiagramResearch/1.0 (raster-only evaluation)"})
            raw = urllib.request.urlopen(req, timeout=45).read()
        cleaned, width, height, removed, pixel_hash, trailing = clean_png(raw)
        target = ROOT / (source["id"] + ".png")
        if target.exists() and target.read_bytes() != cleaned:
            raise FileExistsError(f"Refusing to change existing held-out raster: {target}")
        target.write_bytes(cleaned)
        record = {key: value for key, value in source.items() if key != "candidateFile"}
        record.update({
            "role": "held-out-round-02", "file": target.name,
            "width": width, "height": height,
            "sha256": sha256(cleaned), "bytes": len(cleaned),
            "originalDownloadSha256": sha256(raw), "originalDownloadBytes": len(raw),
            "compressedPixelDataSha256": pixel_hash,
            "removedTextMetadata": removed, "removedTrailingBytes": trailing,
            "sourceVerifiedDate": "2026-10-18", "crop": None, "resize": None,
            "transformation": "No pixel changes. PNG text chunks are discarded by type without decoding payload; any bytes after IEND are discarded without interpretation.",
        })
        records.append(record)
        print(json.dumps({key: record[key] for key in ("file", "width", "height", "sha256", "bytes")}))
    manifest = {
        "schemaVersion": 1, "preparedDate": "2026-10-18", "inputMode": "original-raster-only",
        "blindProtocol": "The source-selection agent inspected raster pixels to verify task suitability. Teacher/Skill author receives only neutral paths, dimensions and hashes before Skill freeze. No SVG, XML, scene, vector coordinates, or PNG text payload is downloaded or inspected.",
        "sourceVerification": "Primary official repository and Wikimedia original file pages were checked. Licensing uncertainty is preserved explicitly.",
        "inputs": records,
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
