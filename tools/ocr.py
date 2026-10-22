#!/usr/bin/env python3
"""Extract local OCR candidates from an immutable normalized render source.

No model download is attempted. Install requirements-ocr.txt and provision the
three ONNX files in RapidOCR's models directory or RAPIDOCR_MODEL_DIR first.
OCR output is evidence to review, never an authoritative transcription.
"""

import argparse
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timezone
from unittest.mock import patch


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run_ocr(run, label):
    started = time.perf_counter()
    run = Path(run).resolve()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", label):
        raise ValueError("Label must start with a letter and use 1-64 letters, digits, _ or -")
    manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("protocol") != "luna-local-render-v1":
        raise ValueError("Unsupported run manifest; initialize with tools/render.mjs init first")
    source_bytes = (run / "source.png").read_bytes()
    source_hash = digest(source_bytes)
    if source_hash != manifest.get("sourceSha256"):
        raise ValueError("Normalized source hash changed")

    try:
        from PIL import Image, ImageDraw
        import rapidocr
        from rapidocr import RapidOCR
        from rapidocr.utils.download_file import DownloadFile
    except ImportError as error:
        raise RuntimeError("Local OCR dependencies missing; use python -m pip install -r requirements-ocr.txt") from error

    source = Image.open(io.BytesIO(source_bytes))
    width, height = source.size
    if source.format != "PNG" or getattr(source, "n_frames", 1) != 1:
        raise ValueError("Source must be a single normalized PNG")
    if (width, height) != (manifest.get("width"), manifest.get("height")):
        raise ValueError("Normalized source dimensions differ from manifest")
    source.load()
    model_dir = Path(os.environ.get("RAPIDOCR_MODEL_DIR", Path(rapidocr.__file__).parent / "models")).resolve()
    models = {
        "Det": model_dir / "PP-OCRv6_det_small.onnx",
        "Rec": model_dir / "PP-OCRv6_rec_small.onnx",
        "Cls": model_dir / "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    }
    missing = [str(path) for path in models.values() if not path.is_file()]
    if missing:
        raise RuntimeError("Local OCR model files missing (automatic download disabled): " + "; ".join(missing)
                           + ". Provision them in RAPIDOCR_MODEL_DIR or the installed rapidocr/models directory.")

    evidence = run / "evidence"
    evidence.mkdir(exist_ok=True)
    json_path = evidence / f"ocr-{label}.json"
    png_path = evidence / f"ocr-{label}.png"
    lock_path = evidence / f".ocr-{label}.lock"
    with lock_path.open("x", encoding="utf-8") as lock:
        lock.write(str(os.getpid()))
    try:
        if json_path.exists() or png_path.exists():
            raise FileExistsError(f"OCR label {label!r} already exists; use a new label to preserve evidence")
        params = {
            "EngineConfig.onnxruntime.intra_op_num_threads": 2,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            "Global.log_level": "error",
            "Global.max_side_len": max(width, height),
            "Det.limit_side_len": max(width, height),
            "Det.limit_type": "max",
            **{f"{kind}.model_path": str(path) for kind, path in models.items()},
        }
        # Explicit paths prevent normal model fetching; this guard also blocks
        # fallback dictionary/font downloads if supplied weights lack metadata.
        with patch.object(DownloadFile, "run", side_effect=RuntimeError(
                "RapidOCR requested a missing local resource; automatic downloading is disabled")):
            engine = RapidOCR(params=params)
            inference_started = time.perf_counter()
            result = engine(source_bytes)
        inference_ms = round((time.perf_counter() - inference_started) * 1000)
        candidates = []
        boxes = [] if result.boxes is None else result.boxes
        texts = [] if result.txts is None else result.txts
        scores = [] if result.scores is None else result.scores
        if not (len(boxes) == len(texts) == len(scores)):
            raise RuntimeError("OCR returned inconsistent candidate arrays")
        for index, (box, text, score) in enumerate(zip(boxes, texts, scores), 1):
            quad = [[round(float(x), 3), round(float(y), 3)] for x, y in box]
            if len(quad) != 4 or any(not math.isfinite(value) for point in quad for value in point):
                raise RuntimeError("OCR returned an invalid quadrilateral")
            confidence = float(score)
            if not math.isfinite(confidence) or not 0 <= confidence <= 1:
                raise RuntimeError("OCR returned an invalid confidence score")
            left = max(0, math.floor(min(point[0] for point in quad)))
            top = max(0, math.floor(min(point[1] for point in quad)))
            right = min(width, math.ceil(max(point[0] for point in quad)))
            bottom = min(height, math.ceil(max(point[1] for point in quad)))
            if left >= right or top >= bottom:
                raise RuntimeError("OCR returned an empty or off-canvas candidate")
            candidates.append({"id": f"ocr-{index:03d}", "text": str(text), "confidence": round(confidence, 6),
                               "bbox": [left, top, right, bottom], "quad": quad})

        annotation = Image.new("RGB", source.size, "white")
        rgba = source.convert("RGBA")
        annotation.paste(rgba, mask=rgba.getchannel("A"))
        draw = ImageDraw.Draw(annotation)
        for candidate in candidates:
            draw.polygon([tuple(point) for point in candidate["quad"]], outline="#e11d48", width=2)
            left, top = candidate["bbox"][:2]
            label_y = max(0, top - 13)
            draw.rectangle((left, label_y, min(width - 1, left + 55), label_y + 12), fill="white")
            draw.text((left, label_y), candidate["id"], fill="#be123c")
        png_buffer = io.BytesIO()
        annotation.save(png_buffer, format="PNG")
        document = {
            "schemaVersion": 1,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "sourceSha256": source_hash,
            "width": width,
            "height": height,
            "engine": {"name": "RapidOCR", "version": importlib.metadata.version("rapidocr"),
                       "backend": "onnxruntime", "backendVersion": importlib.metadata.version("onnxruntime"),
                       "models": {kind: {"file": path.name, "sha256": digest(path.read_bytes())}
                                  for kind, path in models.items()},
                       "detLimitSideLen": max(width, height), "detLimitType": "max",
                       "intraOpThreads": 2, "interOpThreads": 1, "networkDownloads": False},
            "elapsedMs": round((time.perf_counter() - started) * 1000),
            "inferenceMs": inference_ms,
            "candidates": candidates,
            "note": "OCR candidates are not ground truth. Review every candidate against the source; record accepted, corrected, or rejected decisions. OCR can miss text entirely, including rotated or stylized labels.",
        }
        with png_path.open("xb") as output:
            output.write(png_buffer.getvalue())
        with json_path.open("x", encoding="utf-8") as output:
            json.dump(document, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.write("\n")
        try:
            with (evidence / "README.md").open("x", encoding="utf-8") as output:
                output.write("# Measurement evidence\n\nOCR JSON files contain machine-generated candidates, with matching source-coordinate PNG annotations. They require review against the original image and do not prove that every text region was found. Files are never overwritten.\n")
        except FileExistsError:
            pass
        return {"json": str(json_path), "png": str(png_path), "sourceSha256": source_hash,
                "candidates": len(candidates), "elapsedMs": document["elapsedMs"], "inferenceMs": inference_ms}
    finally:
        lock_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", help="Run directory initialized by tools/render.mjs")
    parser.add_argument("--label", default="source", help="Unique evidence label, default: source")
    args = parser.parse_args()
    try:
        result = run_ocr(args.run, args.label)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"OCR failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
