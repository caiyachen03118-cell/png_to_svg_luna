"""Fetch the four raster-only experiment inputs and write a reproducible manifest.

Run with --download to replace inputs with freshly downloaded originals.
Without --download, verify existing PNGs and retain original download metadata.
Text metadata is removed by chunk type without inspecting its payload; IDAT
bytes are preserved, preventing embedded editor source from leaking into tests.
No vector file, PDF objects, diagram source, or layout coordinates are fetched.
"""
from pathlib import Path
from urllib.request import Request, urlopen
import argparse
import datetime
import hashlib
import json
import struct

ROOT = Path(__file__).resolve().parent
SOURCES = [
    dict(id="train-01", role="teacher-development", title="BORO process Flowchart",
         sourcePage="https://commons.wikimedia.org/wiki/File:BORO_process_Flowchart.png",
         imageUrl="https://upload.wikimedia.org/wikipedia/commons/1/19/BORO_process_Flowchart.png",
         author="Extendon", license="CC BY-SA 4.0",
         licenseUrl="https://creativecommons.org/licenses/by-sa/4.0/",
         sourcePageRevision="https://commons.wikimedia.org/w/index.php?title=File:BORO_process_Flowchart.png&oldid=810744998"),
    dict(id="train-02", role="teacher-development", title="ACES Output Device Transform (ODT) Workflow",
         sourcePage="https://commons.wikimedia.org/wiki/File:ACES_Output_Device_Transform_(ODT)_Workflow.png",
         imageUrl="https://upload.wikimedia.org/wikipedia/commons/4/42/ACES_Output_Device_Transform_%28ODT%29_Workflow.png",
         author="Academy of Motion Picture Arts and Sciences", license="CC0 1.0 (as stated by the Commons file page)",
         licenseUrl="https://creativecommons.org/publicdomain/zero/1.0/",
         sourcePageRevision="https://commons.wikimedia.org/w/index.php?title=File:ACES_Output_Device_Transform_(ODT)_Workflow.png&oldid=773955125"),
    dict(id="test-01", role="held-out", title="Basic git branching workflow (GitLab)",
         sourcePage="https://commons.wikimedia.org/wiki/File:Basic_git_branching_workflow_(GitLab).png",
         imageUrl="https://upload.wikimedia.org/wikipedia/commons/d/d9/Basic_git_branching_workflow_%28GitLab%29.png",
         author="TheresNoTime", license="CC BY-SA 4.0",
         licenseUrl="https://creativecommons.org/licenses/by-sa/4.0/",
         sourcePageRevision="https://commons.wikimedia.org/w/index.php?title=File:Basic_git_branching_workflow_(GitLab).png&oldid=817853357"),
    dict(id="test-02", role="held-out", title="MM-StoryAgent framework",
         sourcePage="https://github.com/X-PLUG/MM_StoryAgent/blob/main/assets/framework.png",
         imageUrl="https://raw.githubusercontent.com/X-PLUG/MM_StoryAgent/main/assets/framework.png",
         author="unknown (hosted in the paper authors' official X-PLUG/MM_StoryAgent repository)",
         license="unknown for this image specifically",
         repositoryLicense="Apache-2.0",
         licenseUrl="https://github.com/X-PLUG/MM_StoryAgent/blob/main/LICENSE",
         licenseNote="Repository license verified; no image-specific license or individual illustrator attribution was found. No claim of unrestricted commercial reuse is made."),
]
TEXT_CHUNKS = {b"tEXt", b"zTXt", b"iTXt"}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def raster_only(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Input is not PNG")
    out = bytearray(data[:8]); offset = 8; removed = []; idat = bytearray()
    while offset < len(data):
        size = struct.unpack(">I", data[offset:offset+4])[0]
        kind = data[offset+4:offset+8]
        end = offset + 12 + size
        if end > len(data):
            raise ValueError("Truncated PNG")
        if kind in TEXT_CHUNKS:
            removed.append({"type": kind.decode("ascii"), "length": size})
        else:
            out.extend(data[offset:end])
        if kind == b"IDAT":
            idat.extend(data[offset+8:offset+8+size])
        offset = end
    return bytes(out), removed, sha(idat)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    previous = {}
    manifest_path = ROOT / "manifest.json"
    if manifest_path.exists():
        previous = {item["id"]: item for item in json.loads(manifest_path.read_text(encoding="utf-8"))["inputs"]}
    items = []
    for source in SOURCES:
        path = ROOT / (source["id"] + ".png")
        if args.download:
            req = Request(source["imageUrl"], headers={"User-Agent": "PNG-to-SVG-raster-evaluation/1.0"})
            with urlopen(req, timeout=60) as response:
                data = response.read()
        else:
            data = path.read_bytes()
        cleaned, removed, idat_sha = raster_only(data)
        width, height = struct.unpack(">II", cleaned[16:24])
        prior = previous.get(source["id"], {})
        original_sha = sha(data)
        original_bytes = len(data)
        if not args.download and prior.get("sha256") == sha(data):
            original_sha = prior.get("originalDownloadSha256", original_sha)
            original_bytes = prior.get("originalDownloadBytes", original_bytes)
            removed = prior.get("removedTextMetadata", removed)
        if cleaned != data or args.download:
            path.write_bytes(cleaned)
        item = dict(source, file=path.name, width=width, height=height,
                    sha256=sha(cleaned), bytes=len(cleaned), originalDownloadSha256=original_sha,
                    originalDownloadBytes=original_bytes, compressedPixelDataSha256=idat_sha,
                    sourceVerifiedDate="2026-10-18", crop=None, resize=None,
                    removedTextMetadata=removed,
                    transformation="None to raster pixels. Removed PNG text metadata by chunk type without parsing its payload." if removed else "None")
        items.append(item)
        print(f"{item['id']}: {width}x{height}, {item['sha256']}")
    manifest = dict(schemaVersion=1, preparedDate="2026-10-18", inputMode="raster-only",
                    splitPolicy="Teacher develops Skill on train-01/02 only. Freeze Skill before viewing test-01/02. No SVG, scene, or embedded editor source is inspected.",
                    verification="Source pages, original PNG URLs, author and license statements checked on the web; hashes and PNG dimensions computed locally.",
                    inputs=items)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
