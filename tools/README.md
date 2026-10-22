# Command-line tools

No CLI here loads a Skill or calls a conversion model. Commands are agent-driven. Use [SKILL.md](../SKILL.md) for decisions and the relevant sections of [TOOLING.md](../TOOLING.md) for schemas.

## Generate and render

`render.mjs init INPUT RUN --closed-loop [--max-attempts N]` creates a new strict run with `object-review-v1`, evidence requirements and 8 render attempts by default; N may be 1–12. Plain init and `--evidence` preserve the legacy 3-attempt behavior. Historical runs are not migrated or rewritten.

`preflight RUN PROPOSAL VERSION` is read-only. `render RUN PROPOSAL VERSION` writes an immutable attempt and actual SVG/PNG. Failed renders consume attempts; evidence, prior-review, duplicate-proposal and unchanged-proposal gate refusals do not. An existing version directory is never reused. Closed-loop crop analysis records suggestions without silently changing the submitted box.

Before the first render, use `ocr.py` and `evidence.mjs inventory/measure` to establish source observations. See TOOLING for source icon/connector inventories and two distinct actual measurements.

## Review and repair

The preferred conversion review entry point is `review.mjs`:

```powershell
node tools/review.mjs prepare RUN [VERSION]
node tools/review.mjs next RUN
node tools/review.mjs record RUN RESPONSE_JSON
node tools/review.mjs submit RUN [DECISIONS_JSON]
node tools/review.mjs status RUN
node tools/review.mjs close RUN CLOSURE_DECISIONS_JSON
node tools/review.mjs finish RUN
node tools/review.mjs reopen RUN
```

Follow `next`, inspect its actual images and fill the supplied response template. The CLI supplies current paths/hashes, not observations or acceptance. Per-icon evidence compares source context, adopted crop and final render at the same scale, with four edge views and deleted bands after shrinkage. Each warning needs an explicit benign/issue/pending judgment and localized source/render observations. Missing/stale evidence and repeated stock acceptance remain incomplete.

Initial inspection covers a complete grid. Repair inspections may focus on actual changes, neighboring regions and unresolved issues after a compatible complete prior check. Eligible unchanged icons are reused with provenance rather than falsely marked newly viewed. A final overview check remains required; when no local tasks remain, it is the only overview task.

`submit` binds visual findings to objects, registers confirmed issues and prepares closure patches. Ambiguous targets return `unboundFindings`; explicitly confirm `findingBindings`, then submit again. `close` requires actual patch viewing and specific fix descriptions. For a shared group containing multiple issues, select `issueIds`; one repaired item does not authorize closing the entire group.

Every version has `evidence/workflow/vXX/attempt-NNN/` histories and a `current.json` pointer. An icon's pending decision can be corrected with another `record`, then `submit` on the same render. `reopen` starts a new preserved inspection attempt for region/global corrections or amended source inventory. Multiple submissions and icon-record revisions remain available. Neither metadata correction nor reopening requires gratuitous new pixels or consumes render attempts.

`evidence.mjs` remains available for advanced `inventory`, `amend`, `measure`, `review`, `issue`, `resolve`, `closure-plan`, `closure-apply` and `finalize` operations. Low-level review/finalize/resolve obey the same strict object gate. Evidence-backed source amendments preserve prior inventories; Luna's own recheck must declare `reviewer:"luna"`. Real visual defects need changed target pixels in a later render, a current accepted review and explicit closure evidence. A narrow inventory-correction exception is documented in TOOLING. Unknown fields or missing checks are not automatically visual defects.

## Detection only

`partition-review.mjs create/record/zoom/status/global/finalize` compares a source raster and a same-size candidate using a complete overlapping grid. It does not need Scene/OCR/conversion setup, and it does not repair the input. Inspect each pair, record it once, then inspect the whole figure again. Missing coverage or uncertain judgments prevent complete status. For a new candidate or a corrected finalized record, create a new inspection directory and preserve the old one.

## Local OCR

`python tools/ocr.py RUN [--label source]` runs local RapidOCR against verified `source.png`, saving candidate JSON and annotated PNG without overwriting evidence. Install `requirements-ocr.txt` in the selected Python environment. Models `PP-OCRv6_det_small.onnx`, `PP-OCRv6_rec_small.onnx`, and `ch_ppocr_mobile_v2.0_cls_mobile.onnx` belong in `rapidocr/models` or `RAPIDOCR_MODEL_DIR`. Missing weights produce an error; the tool does not download them. OCR confidence is not SVG fidelity; candidates require acceptance, correction or rejection.

All completion and viewed-image statements remain model declarations. Tool success proves only the specific procedural checks implemented; it does not establish semantic correctness or improved model accuracy/cost.
