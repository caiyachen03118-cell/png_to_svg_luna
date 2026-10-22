# Local tool contract

This file describes the local tools available to teacher and Luna. It contains no case-specific coordinates. The tools do not invoke a generative model or load a Skill. For new conversions, read Scene JSON and Closed-loop workflow; use the unified `review.mjs` queue instead of copying hashes and issue IDs between low-level commands. Read the advanced evidence references only when needed. Detection-only work uses Automatic partition review.

## Install and commands

Requires Node.js 22 or newer. Dependencies are pinned in this project's `package-lock.json`: `sharp` 0.34.5 and `@resvg/resvg-js` 2.6.2. Install with `npm ci`. This project has its own dependency installation and no runtime dependency on another project's directory.

For OCR evidence and closed-loop conversions, follow [OCR_SETUP.md](OCR_SETUP.md) to create a Python environment, provision the three local ONNX models, verify their hashes and set `RAPIDOCR_MODEL_DIR` in the shell that runs OCR. Installing `requirements-ocr.txt` alone does not provision the weights. Plain rendering and the Node test suite do not require OCR.

```powershell
node tools/render.mjs init INPUT_PNG_OR_JPG OUTPUT_DIR
node tools/render.mjs init INPUT_PNG_OR_JPG OUTPUT_DIR --evidence
node tools/render.mjs init INPUT_PNG_OR_JPG OUTPUT_DIR --closed-loop --max-attempts 8
node tools/render.mjs preflight OUTPUT_DIR PROPOSAL_JSON v01
node tools/render.mjs render OUTPUT_DIR PROPOSAL_JSON v01
node tools/render.mjs render OUTPUT_DIR REVISED_PROPOSAL_JSON v02
node tools/render.mjs render OUTPUT_DIR FINAL_PROPOSAL_JSON v03
npm test
```

Run commands from the project directory, or use the absolute script path. All CLI paths may be absolute or relative to the current working directory. CLI output is JSON with absolute artifact paths; failures print an error and exit with code 1.

`init` requires a new output directory. It accepts a single PNG or JPEG up to 40 million pixels, at most 20,000 pixels per side. It applies EXIF orientation, converts to sRGB, preserves alpha, strips source metadata, and writes `source.png`. `manifest.json` records input and normalized-image SHA-256 hashes, normalized dimensions, input metadata and tool protocol. Use the normalized dimensions in scene coordinates.

Legacy runs allow **three render attempts including failures**. Closed-loop runs default to eight; `--max-attempts N` selects 1–12 at initialization. Versions are two-digit `v01` through the run's limit. A version directory cannot be replaced or reused, even after failure. Legacy duplicate requests consume an attempt; closed-loop preflight gates may reject a duplicate/unchanged proposal without rendering. Rendering is serialized with a lock. The source hash is checked on every attempt. The tool never automatically retries. Do not edit the manifest, source, audit, event log or existing version files to bypass this contract.

Each successful version contains:

- `submitted.json`: exact bytes of the submitted proposal.
- `scene.json`: validated scene after local icon boundary checks; this is the scene actually rendered.
- `result.svg`: standalone SVG with native objects and embedded PNG source crops.
- `preview.png`: raster rendering of that SVG using resvg and installed system fonts.
- `crop-audit.json`: submitted/adopted boxes, measurement evidence, unresolved IDs and limitations.
- `crop-review.png`: legacy modes only, when icons exist. Its independently scaled cells are not the strict icon acceptance evidence. New closed-loop runs use the per-object, same-scale evidence prepared by `review.mjs`.
- `stats.json`: dimensions, local runtime, object counts, bitmap coverage, hashes and crop statuses. `apiCalls: 0` and `modelTokens: 0` refer only to this local CLI; agent/model usage is separate.

`render-events.jsonl` in the run directory records every attempt and success/failure. A failed version contains `error.json` and any diagnostic files written before the failure. No final SVG quality score or semantic correctness claim is produced by this tool.

## Scene JSON

```json
{
  "width": 200,
  "height": 120,
  "background": "#ffffff",
  "elements": [
    { "id": "node_a", "type": "rect", "x": 20, "y": 20, "width": 60, "height": 40, "rx": 4, "fill": "#eeeeff", "stroke": "#222222" },
    { "id": "label_a", "type": "text", "x": 50, "y": 45, "text": "Example", "fontSize": 12, "textAnchor": "middle" },
    { "id": "edge_a", "type": "line", "x1": 80, "y1": 40, "x2": 150, "y2": 40, "strokeWidth": 2, "arrowEnd": true }
  ]
}
```

The root permits only `width`, `height`, `background`, `elements`. Dimensions must exactly match the normalized source. Background defaults to `#ffffff`. Elements are painted in list order. There must be 1–400 elements. Each `id` must be unique, begin with a letter and contain at most 64 ASCII letters, digits, `_` or `-`.

Every non-image element supports these optional style keys:

| Key | Values / default |
| --- | --- |
| `fill` | Hex color or `none`; default black for text, `none` for other shapes |
| `stroke` | Hex color or `none`; default `none` for text, black for other shapes |
| `strokeWidth` | Number from 0 to 100; default 1 |
| `opacity` | Number from 0 to 1; default 1 |
| `dash` | 1–32 nonnegative lengths, at least one positive |
| `linecap` | `butt`, `round`, `square` |
| `linejoin` | `miter`, `round`, `bevel` |

Colors accept `#rgb`, `#rrggbb`, `#rrggbbaa` or `none`. CSS names, arbitrary CSS, URLs, gradients, scripts, general transforms and unknown keys are rejected. Text has the specific `rotation` field documented below.

| Type | Geometry and content |
| --- | --- |
| `rect` | Required `x`, `y`, `width`, `height`; optional `rx` |
| `ellipse` | Required `cx`, `cy`, `rx`, `ry` |
| `line` | Required `x1`, `y1`, `x2`, `y2`; optional boolean `arrowStart`, `arrowEnd` |
| `polyline` | Required `points`: 2–1000 `[x,y]` pairs; optional `arrowStart`, `arrowEnd` |
| `path` | Required `d` in restricted standard SVG path syntax; optional `arrowStart`, `arrowEnd` |
| `text` | Required `x`, `y`, `text`, `fontSize`; optional font keys below |
| `image` | Required integer `bbox_px: [x1,y1,x2,y2]`, `kind`, `reason`; no style keys |

Path supports `M L H V C S Q T A Z` and lowercase relative forms, finite bounded coordinates and valid arc flags. It must begin with `M`/`m` and contain at most 20,000 characters / 5,000 tokens. Shape widths/radii must be positive; geometry is bounded to a finite neighborhood of the canvas. Arrow markers require a visible stroke. Marker size is eight stroke-width units; start and end use separate mirrored paths with `orient="auto"` so SVG and resvg PNG agree. The arrow tip is located at the declared endpoint.

Text uses a single baseline `(x,y)` and a single line; embedded newlines are rejected. Text stays editable `<text>` and XML special characters are escaped. Font options:

- `fontFamily`: default `Arial`; installed font name or comma-separated family list.
- `fontSize`: required, 1–1000 pixels.
- `fontWeight`: integer 100–900, default 400.
- `fontStyle`: `normal`, `italic`, `oblique`; default `normal`.
- `textAnchor`: `start`, `middle`, `end`; default `start`.
- `letterSpacing`: optional, -100 to 100 pixels.
- `rotation`: optional finite degrees from -360 to 360, including decimals. Positive is clockwise in SVG coordinates. Rotates around the original text baseline anchor `(x,y)`; font style, letter spacing and `textAnchor` apply before rotation. Omitting it preserves the previous output. This remains native editable SVG text; no automatic angle estimation or rotated-boundary clipping check is performed.

An `image` box is left/top inclusive and right/bottom exclusive in normalized source coordinates. The crop is placed at that exact source location at its original size, embedded as `data:image/png;base64,...`. Neither source pixel values nor alpha are modified. `kind` is `icon`, `chart` or `illustration`; `reason` is a nonempty string of up to 500 characters. Each crop is at most 40% of the canvas; there are at most 32 crops and their rectangular union covers at most 70% of the canvas. The tools do not permit embedding the whole input as a fake vector conversion.

## Local icon boundary checks

Before compilation the tool examines `kind: "icon"` boxes with conservative local edge-component measurement. A single sufficiently isolated target can have its box adjusted with antialiasing padding. Ambiguous targets, clipped source boundaries, potentially discarded detached components and unsafe padding remain unchanged with `needs_review` status. `chart` and `illustration` crops are not automatically resized. These checks do not recognize icon semantics and cannot guarantee all touching details belong to the same object. Proposed and adopted boxes are always both recorded. The actual SVG uses `scene.json`, not `submitted.json`.

## Optional evidence workflow and low-level reference

The simple review JSON and contact-sheet sequence in this section are for historical/plain `--evidence` runs. New closed-loop runs have `reviewProtocol: "object-review-v1"` and require the stricter object evidence described below. Calling the old `evidence.mjs review/finalize/resolve` commands cannot bypass that protocol.

All groups can use the commands below. Normal `init` preserves legacy behavior. `init INPUT RUN --evidence` sets `evidenceRequired: true`; in that mode a render is refused before consuming an attempt unless a frozen source inventory, OCR accounting and at least two distinct nonempty pixel measurements exist. Refusals are recorded. This checks execution evidence, not reconstruction quality.

`preflight RUN PROPOSAL VERSION` checks files, source hash, Scene schema, unused version and remaining budget without consuming an attempt. It does not render or reserve a version. Actual render failures still count against the run's budget.

```powershell
python tools/ocr.py RUN --label source
node tools/evidence.mjs inventory RUN INVENTORY_JSON
node tools/evidence.mjs measure RUN SPEC_JSON LABEL
node tools/render.mjs preflight RUN PROPOSAL_JSON v01
node tools/render.mjs render RUN PROPOSAL_JSON v01
node tools/evidence.mjs review RUN v01 REVIEW_JSON LABEL
node tools/evidence.mjs finalize RUN v01 LABEL
```

OCR is an optional Python dependency for the general renderer and required for evidence-mode runs. Install the versions in `requirements-ocr.txt` into a Python environment. `tools/ocr.py` uses installed local RapidOCR models; it does not call a model API. It records candidates, confidence, source coordinates/hash, runtime and an annotated image under `RUN/evidence/`. A confidence score is OCR recognition confidence, not SVG fidelity. Supply a new label instead of overwriting evidence.

Inventory input:

```json
{
  "ocrEvidence": "evidence/ocr-source.json",
  "texts": [{"id":"title", "text":"Example", "bbox":[10,10,100,30]}],
  "objects": [{"id":"panel", "kind":"rect", "bbox":[5,5,110,70]}],
  "ocrDecisions": [{"candidateId":"ocr-001", "status":"accepted", "inventoryIds":["title"], "note":"Matches source."}]
}
```

Coordinates are integer normalized-source pixels with exclusive right/bottom edges. `texts` registers intended native text, separate from optional object notes. OCR decisions must address every candidate using `accepted`, `corrected`, or `rejected`; accepted/corrected decisions reference valid inventory text IDs. Accepted text must match the mapped inventory text; corrected and rejected decisions need a reason. Additional manual text entries are permitted. OCR candidates are not ground truth. Inventory and referenced OCR hashes are frozen before rendering. Do not derive inventory retrospectively from generated Scene.

Measurement spec:

```json
{"roi":[10,10,100,50],"purpose":"Measure label ink bounds", "mode":"dark", "threshold":100}
```

Modes: `dark`, `color` (requires `color: "#RRGGBB"`), or `difference` (difference from supplied color, otherwise estimated corner background). `threshold` and `tolerance` are 0–255. Output includes actual pixel-match count/bounds, ROI-edge counts, dominant colors, crop/context PNGs and source hash. A nonempty mask is not necessarily one semantic object. Labels must be unique; distinct specs may not be made up by renaming identical evidence.

Review input maps each inventory text to one or more native Scene text IDs. The tool checks normalized whitespace and concatenated content in mapping order. Cropped text does not satisfy native text coverage.

After the round-02 experiment, the reviewer was corrected to flag native text with zero opacity or no visible fill/stroke as invisible instead of matched. This catches transparent placeholders; it does not prove that a nominally visible glyph is inside the canvas, unoccluded, or legible. The frozen round-02 tools and original results are preserved; the fix is documented separately.

```json
{
  "mappings":[{"inventoryId":"title", "elementIds":["title-text"]}, {"inventoryId":"panel", "elementIds":["panel-rect"]}],
  "cropReviews":[{"id":"icon-a", "status":"accepted", "note":"Checked adopted crop and context; detached feet are present."}],
  "visualReview":{"viewedPreviewSha256":"COPY_ACTUAL_PREVIEW_HASH", "notes":"State specific observed differences, including unresolved ones."}
}
```

Every adopted image needs a crop decision, including charts/illustrations; use `issue` for unresolved problems. Review records missing/changed/extra text, optional inventoried-object mappings, crop decisions, and actual Scene/preview hashes. It retains automatic crop warnings even if the model accepts the crop. The preview-view declaration is a model statement, not proof of visual understanding. Review output includes source/adopted-crop context in `crop-contact-sheet.png`: generate a preliminary review, inspect this sheet and the preview, then submit a new labeled review with the final observations. Native scene text IDs cannot be reused to satisfy multiple inventory entries. `finalize RUN VERSION LABEL` summarizes that labeled review into immutable `VERSION/final-verification.json`. Complete evidence can still contain issues; user acceptance stays pending.

## Closed-loop workflow

`init INPUT RUN --closed-loop [--max-attempts 8]` enables `evidenceRequired`, `repairRequired`, and `reviewProtocol: "object-review-v1"`. Historical manifests without the new protocol keep their original behavior; do not alter them to retrofit new gates. Source image normalization, actual OCR, frozen text/icon/connector inventory and two distinct measurements are still required. A successful render is not a successful reconstruction.

### Unified review queue

After each successful render:

```powershell
node tools/review.mjs prepare RUN v01
node tools/review.mjs next RUN
node tools/review.mjs record RUN RESPONSE_JSON
node tools/review.mjs submit RUN DECISIONS_JSON
node tools/review.mjs status RUN
node tools/review.mjs close RUN CLOSURE_DECISIONS_JSON
node tools/review.mjs finish RUN
```

`next` returns one actual evidence item, absolute image paths, and a response template. Inspect the evidence, fill the observations, set `viewed:true`, then `record`. Paths and current hashes are bound by code; the agent does not type them. Code never supplies visual observations or acceptance. The normal queue is overview → individual image objects → selected region pairs → final overview. If a recheck has no local tasks, it goes directly to the final overview instead of presenting that same overview twice.

| Command | Behavior |
| --- | --- |
| `prepare RUN [VERSION]` | Prepare or resume the latest successful render's current inspection attempt. |
| `next RUN` | Return the next item and response schema; it does not mark anything viewed. |
| `record RUN RESPONSE_JSON` | Save actual observations. Invalid accepted icon evidence is rejected; issue/pending can be recorded. |
| `submit RUN [DECISIONS_JSON]` | Assemble current icon/region observations, validate mappings, register confirmed findings and prepare closure evidence. Omitted decisions use the generated review template, whose missing mappings/observations remain incomplete. |
| `status RUN` | Report coverage, reuse, unresolved findings and the next action. |
| `close RUN DECISIONS_JSON` | Apply explicit decisions to selected issues after inspecting the generated source/discovery/current patches. |
| `reopen RUN` | Start a new inspection attempt for the same latest rendered version, preserving earlier attempts; no render is consumed. |
| `finish RUN` | Require current submission, complete region/global checks, bound findings, accepted object evidence and zero open issues. It does not certify visual correctness. |

Each version stores inspection attempts under `evidence/workflow/vXX/attempt-NNN/`; `evidence/workflow/vXX/current.json` points to the active attempt. Its plan, icon record history, region evidence, and `submissions/submit-NNN/` remain available. The latest `submission.json` is an index, not replacement of old submission records. An identical resubmission is reused rather than registering the same evidence twice.

An icon can be recorded again on the same render after a `pending` judgment is resolved; its previous response is retained. Submit again to bind the new decision. Use `reopen` to correct already-recorded region/global observations or prepare against an amended inventory. A missing check, missing mapping or stale declaration is incomplete metadata, not a confirmed visual defect and not a reason to introduce gratuitous pixel changes.

Initial inspection uses a complete grid. Later repair inspection may select changed pixels plus neighboring regions and unresolved issues, only after a complete compatible previous inspection. The plan preserves its selection evidence. Unchanged accepted icons may be carried forward only when their source context, actual crop, final-render context and risk/content fingerprint match, with no related open issue. Such records state their prior origin and `unchanged_verified_content_reuse_not_new_view`; they are not new viewing claims. Changes to a neighboring object or removed band can invalidate reuse. The final overview is still inspected. Detection-only independent experiments retain full-grid coverage.

### Same-scale icon evidence and decisions

`evidence/icon-reviews/vXX/` contains one small evidence set per actual image element, including charts/illustrations:

- `comparison`: source context / actually adopted source crop on its canvas position / final SVG render context. All columns have the same coordinates and scale; no independent fitting of crops.
- Four side views and an annotated companion, without obscuring pixels in the unannotated comparison.
- `removedBands` after a crop shrinks, with the actual deleted source-coordinate strip and surrounding context.
- Deterministic warnings for boundary contact, uncertain crop analysis, removed foreground and render differences. They are risk signals, not semantic clipping verdicts.

The icon response template includes `id`, `status: accepted|issue|pending`, `note`, four `edgeObservations`, `warningDecisions`, and `removedBandDecisions`. Every edge needs a specific `sourceObservation` and `renderObservation`. Each automatic warning requires its `warningId`, `status: benign|issue|pending`, a source-coordinate `bbox` inside that warning's range, and the two concrete observations. Removed-band entries similarly name `id` and inspect their actual deleted area. `viewed:true` is required for recording; the code supplies evidence hashes only after this explicit declaration.

Do not accept all icons with the same “full subject visible” sentence. Missing/stale three-column or edge evidence, repeated observation templates, missing decisions and pending risks prevent acceptance. A warning's explicit `issue` decision overrides an overall accepted label. Shrinking a crop requires removed-band evidence even if the new middle-column crop looks clean. Render-difference warnings require looking at the final-render column to distinguish source-crop completeness from later SVG occlusion.

These gates establish current, specific records; they cannot verify that natural-language observations are true or that a reported benign edge is actually harmless. The warning itself never automatically becomes a semantic defect merely because its review is missing.

### Findings and selective closure

Generated `review-template.json` includes mechanical mapping suggestions. Fill ambiguous native text/object/icon/connector mappings and visual checks; image icon status is derived from the corresponding actual crop decisions when those mappings are unambiguous. Confirmed regional findings are attached to scene/inventory targets. When attachment is ambiguous, `submit` returns `unboundFindings` with stable keys and candidate inventory IDs. Add an explicit binding and submit again on the same version:

```json
{"findingBindings":[{"key":"KEY_RETURNED_BY_SUBMIT","inventoryId":"camera","elementIds":["camera-image"]}]}
```

This is a field example, not a complete replacement for the review-template mappings. Missing bindings block `finish`; the tool does not guess that every scene element is involved.

Automatic open issues use stable target, condition and location to avoid repeat registration. Equivalent crop/icon declarations with the same target and description share one open occurrence. A distinct condition remains separate; recurrence after resolution gets a new occurrence while prior closure evidence stays immutable. The code does not infer arbitrary semantic equivalence between paraphrases.

After submission, inspect the returned closure plan and relevant source/discovery/current patches. Each shared patch group lists its individual issues. Accept only selected, actually repaired issue IDs:

```json
{"decisions":[
  {"groupId":"GROUP_RETURNED_BY_SUBMIT","issueIds":["camera-cut"],"status":"accepted","viewed":true,"fixDescription":"The lower crop now retains the entire stand; the nearby label remains visible."},
  {"groupId":"GROUP_RETURNED_BY_SUBMIT","issueIds":["camera-shadow"],"status":"pending","fixDescription":""}
]}
```

For a group containing multiple issues, `issueIds` is required. Different subsets can use the same group ID; issue IDs must not be repeated. Single-issue groups allow omission of `issueIds`. The CLI binds the appropriate hashes and applies the existing per-issue closure checks; no explicit decision means no closure. Shared evidence does not justify one blanket semantic verdict.

Read remaining issues from `status`, repair actual image defects in a later version, and repeat `prepare`. Keep same-version metadata corrections separate from image repair. Low-level review/finalize/resolve still enforce strict object evidence, so switching entry points cannot waive current warning decisions. The following sections document the underlying inventory, geometry and closure contracts for advanced use.

### Source inventory and underlying evidence contracts

In this mode automatic icon boundary analysis supplies suggestions; the rendered crop retains the model's explicitly submitted box. The audit records `suggestedBox` separately from actual `finalBox`. This avoids a heuristic silently discarding details after the model has selected a box; the model can adopt a suggested correction in the next proposal after reviewing it. Legacy modes retain automatic crop adjustment.

Add these fields to the ordinary inventory (IDs must be unique across all inventory categories):

```json
{
  "structureCoverage":{"icons":"listed","connectors":"listed","note":"Source reviewed region by region."},
  "icons":[{"id":"camera","bbox":[10,30,60,80],"description":"Full camera including detached stand","representation":"image"}],
  "connectors":[{"id":"camera-output","from":[60,55],"to":[150,55],"heads":"end","description":"Camera output to the next panel","tolerance":8}]
}
```

`icons` includes all intended image crops, including photos and small plots. `representation` is `image` or `vector`. `connectors` registers every distinct connection/branch, with `heads: start|end|both|none`. The default endpoint tolerance is 8 pixels, configurable 1–30; it is not permission to redraw inaccurately. When a category is absent, use an empty array and `structureCoverage` value `none` with a concrete explanation. This is source annotation by the model, not automatically verified ground truth. Reinspect the source for unregistered objects and incorrect annotations. An independent reviewer is useful when the run permits one; in an unassisted run Luna must perform and label its own source recheck, without claiming independence.

Extend every review:

```json
{
  "iconChecks":[{"inventoryId":"camera","elementIds":["camera-image"],"status":"accepted","note":"Full stand and lens checked against the original crop context."}],
  "connectorChecks":[{"inventoryId":"camera-output","lineIds":["output-line"],"status":"accepted","note":"Original arrow tip is on the right; rendered arrow agrees."}]
}
```

`accepted`, `issue`, and `pending` distinguish checked-correct, a confirmed defect, and not yet inspected. `pending` or absent review entries prevent finalization but do not themselves demand pixel changes. All actual image elements must map to source icons; text-only replacements cannot satisfy an icon. Image crops must enclose the inventoried full source bbox and not extend over 20 pixels beyond it. Native-vector icons require visible geometry in that source region and `visualMatch:true` after inspection; this declaration does not prove pixel equivalence.

Connector `lineIds` reference native line/polyline/open path segments forming a continuous chain. Shared branches may reuse a segment. Geometry may be reversed in the Scene; the checker normalizes it to the inventory direction and checks arrow placement at both ends. Interior segment gaps are limited to 3 pixels. Open single-subpath SVG paths with M/L/H/V/C/S/Q/T/A are supported; closed/multiple-subpath shapes are not connector shafts. A separate native triangle can be mapped through `headIds:{"start":[],"end":["tip-path"]}`. It must be a visible closed straight triangle (or filled three-point polyline), near the required endpoint and oriented outward. Arbitrary decorative shapes or text arrows are not validated arrowheads.

The low-level review produces local source/preview evidence. In strict runs, icon evidence uses the per-object sets above rather than the old crop contact sheet; connector structure sheets remain available. Confirmed structural mismatches and declared crop/icon/connector defects become persistent issues; omitting them from a later review does not close them. Pixel-boundary warnings require the strict, per-warning decision schema before acceptance. A missing mapping is initially an incomplete review; explicitly record `status:"issue"` when the source object really is missing from the scene.

Register additional visible defects, including independent-review feedback:

```powershell
node tools/evidence.mjs issue RUN v01 ISSUE_JSON reviewer-v01
```

```json
{"reviewer":"independent","issues":[{"id":"camera-cut","kind":"crop","inventoryId":"camera","elementIds":["camera-image"],"roi":[0,20,75,90],"description":"Stand cut off at bottom edge","severity":"critical"}]}
```

The issue binds its source, discovered version, affected elements and pixel region. `reviewer` records who made the declaration; it is not cryptographic identity verification. New issues may be registered after an earlier version finalized; that old final record is historical, not acceptance of a later state.

After changing the affected object and rendering/reviewing a later version:

```powershell
node tools/evidence.mjs resolve RUN v02 RESOLUTION_JSON fix-camera
```

```json
{"resolutions":[{"issueId":"camera-cut","fixDescription":"Expanded the crop to include the stand","reviewLabel":"review-v02"}]}
```

The first call produces source/discovery-version/new-version patch images and returns `pending_visual_review`; it does not close the issue. Actually inspect that image, add its returned `viewedPatchSha256` to the resolution entry, and rerun the same label. Closure requires the latest successful rendered version, a later render than discovery (except the narrow inventory-correction case), actual changes in the affected area, the latest matching review and the patch hash. Changing an unrelated element, reusing the old preview or hiding/deleting the affected content is insufficient. If inspection still shows a defect, revise again instead of submitting false acceptance.

For `crop`/`icon` issues involving image crops, the original discovery `roi` and its source/discovery pixel hashes stay unchanged. A separate `reviewRoi` is derived from the original ROI, original/current source semantic boxes, and original/current actually adopted image boxes, with 8 pixels of context clipped to the canvas. It is not a caller-selected enlarged ROI. Current adopted crops must remain within a local allowance of `max(24px, 0.5 × longest anchor side)` around the union of original ROI and source boxes; a farther-away/huge current crop cannot become an arbitrary whole-image closure window. The hash-bound discovery crop is included even if it was oversized: otherwise fixing that original error would permanently trap its issue. The resolution records both original-ROI and expanded-region hashes and change counts.

When both versions use image crops, closure requires actual changed source pixels in the old/new crop-footprint difference. This allows removal of unwanted outer pixels even when the icon interior is unchanged. Changing only a crop's `reason`, adding an unrelated native object to its mapping, or changing nearby pixels cannot satisfy that boundary gate. Color comparison is conservative and uses flattened source pixels; translucent compositing may need a separately diagnosed visual issue rather than forcing this crop-boundary proof. The gate does **not** establish that the removed pixels were unwanted: the agent must inspect source context, detached details and shared borders to avoid cutting off a tail, smoke, stand, or connector while removing contamination.

### Preparing and closing a ledger without hand-copying every issue

After the latest render and its latest review, run:

```powershell
node tools/evidence.mjs closure-plan RUN v02 closure-v02
```

This reads the persistent ledger and produces `evidence/closure-plans/closure-v02/plan.json`, source/discovery/current three-panel patches, and `decisions.template.json`. Every open issue keeps its ID, description and discovery version. Entries sharing a discovery version, target set and review region share a patch; grouping does not merge their audit records. Every item is either `ready_for_visual_review` or `blocked` with a concrete reason, and blocked items also get available inspection patches. One uncorrected item does not stop other patches from being prepared. Readiness means only that procedural prerequisites are satisfied. It is not visual acceptance and does not close anything. A narrowly eligible inventory correction may be offered as that explicit resolution type, with its amendment evidence recorded.

Inspect the relevant patches. Copy the template to your own decision file, leave unresolved items `pending` or `issue`, and explicitly accept only the repairs that still look correct against the source. The template deliberately supplies neither acceptance nor a viewed hash:

```json
{"planLabel":"closure-v02","decisions":[
  {"issueId":"camera-cut","status":"accepted","fixDescription":"Expanded lower crop edge to preserve the entire stand; neighboring label remains native and separate.","viewedPatchSha256":"ACTUAL_INSPECTED_GROUP_HASH"},
  {"issueId":"other-arrow","status":"pending","fixDescription":""}
]}
```

```powershell
node tools/evidence.mjs closure-apply RUN v02 DECISIONS_JSON close-v02-part1
```

The command validates each explicit acceptance again, requires its nonempty fix description and actually viewed group hash, and preserves unselected/pending/issue/blocked entries as open. It returns per-ID outcomes and a refreshed ledger. Missing or stale acceptance hashes do not close their items; another valid item can still close. Resolutions retain per-issue source/discovery/current hashes and copied patch evidence even when the plan grouped the display. This remains a declaration of viewing and judgment, not proof that the model perceived the defect correctly.

A still-current plan can be applied to another subset using a new apply label; already closed IDs return `already_resolved`. Any new successful render, review or source-inventory revision makes the old plan stale: review the new state and generate a new plan. Changed plan/patch files are rejected. `closure-apply` cannot turn a blocked or pending decision into acceptance. An empty latest review does not erase the historical ledger. After every apply, read remaining open IDs and either continue fixing/reviewing them or report the exact budget/blocker; do not stop merely because a render looks finished.

Strict `finalize RUN VERSION REVIEW_LABEL` refuses success while any issue remains open or the latest source-inventory checks are incomplete/incorrect. It records the blocking details in `evidence/open-issues.json`. Preserve those details if the budget is exhausted; do not change the manifest or call a legacy tool to manufacture a success. Model/user quality acceptance remains separate from procedural completion.

If a source reinspection finds a wrong or missing inventory annotation, append an amendment:

```powershell
node tools/evidence.mjs amend RUN AMENDMENT_JSON source-correction
```

```json
{"inventory":"REPLACE WITH THE FULL UPDATED INVENTORY OBJECT","reviewer":"independent","reason":"OCR read an icon detail as body text","evidenceNote":"Inspected the original icon with surrounding pixels","retiredTextIds":["false-text"],"retirementReason":"The mark belongs inside the preserved icon"}
```

`inventory` must be an object, not the placeholder string above. For Luna's own correction use `reviewer:"luna"` and additionally provide:

```json
{"sourceRecheck":{"viewedSourceSha256":"RUN_SOURCE_SHA256","checks":[{"inventoryId":"false-text","measurementLabel":"source-recheck-01","viewedContextSha256":"MEASUREMENT_CONTEXT_SHA256","note":"What the original pixels show and why my previous annotation was wrong"}]}}
```

The measurement must have actually been executed with `measure`; inspect its `context.png` and copy `contextSha256` from `measurement.json` only after viewing it. Each changed, added or retired inventory ID needs a check. The measurement context must contain both the item's previous and updated source bounds, so use a sufficiently broad ROI. Several checks may reference the same inspected context. Source/image hashes and measurement execution records are validated. Viewing is still a declaration, not proof of semantic correctness. A single agent must not label its own inspection `independent`.

Retiring text requires exactly the removed text IDs and a reason; update the OCR decisions accordingly. Existing icon and object IDs cannot be removed. A connector confirmed absent by source reinspection may be explicitly retired with the exact `retiredConnectorIds` list, `retirementReason`, and source `evidenceNote`. Silent deletion is refused. This exception corrects false source annotations; it must not remove a real difficult connection. The amendment preserves previous inventories, records hashes and invalidates earlier reviews. It does not close existing issues. Any scene elements mapped to a retired false positive must actually be removed before its automatic issue can close; hiding them is refused.

A narrow resolution exception, `resolutionType:"inventory-correction"`, applies to an automatic inventory mismatch when an independent amendment or evidenced Luna self-amendment changes the actual inventory item implicated by the issue and the scene was already correct. It still requires a fresh matching review and inspected source/discovery/current patch; it does not demand a gratuitous pixel change. It cannot close a manually registered visual defect. All actual image defects use the default `resolutionType:"render-repair"` and require a changed later render. The reviewer role and visual acceptance remain declarations, not proof of correctness; the resolution records whether the source correction was independent or Luna's own recheck.

## Automatic partition review (detection only)

`tools/partition-review.mjs` makes a fixed overlapping grid from an original raster and a same-size SVG raster preview. It does not read a Scene, SVG, error list or answer key, and it never selects regions by image differences. It does not modify either input. This workflow separates recorded inspection coverage from the correctness of the model's judgments.

```powershell
node tools/partition-review.mjs create REFERENCE.png CANDIDATE.png NEW_REVIEW_DIR --tile-size 640 --overlap 96
node tools/partition-review.mjs status REVIEW_DIR
node tools/partition-review.mjs record REVIEW_DIR REGION_RECORD.json
node tools/partition-review.mjs zoom REVIEW_DIR X1 Y1 X2 Y2 UNIQUE_LABEL
node tools/partition-review.mjs global REVIEW_DIR GLOBAL_RECORD.json
node tools/partition-review.mjs finalize REVIEW_DIR
```

`create` requires a new directory and PNG/JPEG inputs with identical dimensions after EXIF orientation. It applies sRGB and composites alpha over white equally, without registration, content cropping or resizing either normalized input. Original bytes are retained in `originals/`; the normalized pair is `reference.png` and `candidate.png`. A changed original or normalized image prevents subsequent recording. The maximum image size is 40 million pixels and 20,000 pixels per side. Tile size is 64–680 pixels; overlap is 1 through tile size minus 1. Grids above 1,024 regions are refused. Default tiles are 640 pixels with at least 96 pixels overlap between adjacent tiles; the last row/column is anchored to the image edge so there are no thin leftover strips or uncovered margins.

`manifest.json` records input hashes, normalization, grid coordinates, every crop and pair hash, and `coverageSummary`. Its `overview-pair.png` has A/reference and B/candidate with the complete canvas, downscaled only if necessary to fit 2,000 pixels wide. Each `regions/rNNN/` contains `reference.png`, `candidate.png`, and a labeled `pair.png` at exactly 1 source pixel per display pixel before any viewer scaling. The pair has a 36-pixel header and 16-pixel gutter, at most 1,376 × 716 pixels for standard grid tiles. Bboxes throughout use original normalized-image coordinates `[left,top,right,bottom]`, with exclusive right/bottom edges; pair-display offsets are not source coordinates.

Inspect the full overview first, then actually view each pair one at a time. Submit each region exactly once, after completing any desired local reinspection. A record requires all four check categories and concrete observed evidence for every reported difference. `not_applicable` means that category does not occur, not that it was skipped:

```json
{
  "regionId": "r001",
  "viewedPairSha256": "ACTUAL_MANIFEST_PAIR_HASH",
  "summary": "The same two labels and rectangular node are visible. The right arrow tip is present in A and absent in B.",
  "checks": {
    "text": "no_difference",
    "shape": "no_difference",
    "connector": "difference",
    "boundary": "no_difference"
  },
  "findings": [{
    "id": "missing-tip",
    "bbox": [100, 80, 125, 105],
    "kind": "arrowhead",
    "description": "Candidate connector ends without the source arrowhead.",
    "evidence": ["A has a filled triangle at the right end; B has only the horizontal shaft."]
  }],
  "uncertain": []
}
```

Check values are `no_difference`, `difference`, `uncertain`, or `not_applicable`. The Chinese check-key aliases `文字`, `图形`, `连线`, `边界` are also accepted. Every finding bbox must fit wholly within the recorded region. Cross-region findings can be inspected using a model-selected `zoom` and recorded in the final global review. `zoom` writes immutable source/candidate/pair images at 1x with the same source coordinates and hashes. It never marks a grid region checked; if its pair is too large to inspect clearly, use the separate crops or smaller supplemental views. Reusing a zoom label is refused.

After every grid region has a record, inspect the full overview again and submit:

```json
{
  "viewedOverviewSha256": "ACTUAL_MANIFEST_OVERVIEW_HASH",
  "summary": "Rechecked complete icons, cross-region connection endpoints and objects omitted from local findings.",
  "checks": {
    "crossRegionConnectors": "no_difference",
    "iconCompleteness": "no_difference",
    "omissions": "no_difference"
  },
  "findings": [],
  "uncertain": []
}
```

Global findings use the same schema and may cover the full source canvas. Mention unresolved questions explicitly in `uncertain`; do not convert an uncertain judgment to `no_difference` merely to finish. The tool validates coordinates, current image hashes, evidence declarations and record consistency. It cannot verify whether a claimed visual difference exists.

`ledger.json` is the immutable initial all-pending snapshot. Live state is derived by `status` from immutable `records/` and append-only, hash-chained `events.jsonl`; each event binds the manifest and input fingerprint. Records cannot be silently revised, repeated, or removed through the CLI. Use a new review directory for a new candidate, corrected inspection, or later verification. A lock prevents concurrent writes to one review run.

Region status is `pending`, `checked_no_difference`, `checked_with_findings`, or `uncertain`, never `passed`. `finalize` refuses missing grid records or missing global review. It writes one immutable `report.json`: `review_complete_with_findings`, `review_complete_no_reported_findings`, or `review_incomplete_uncertain`. Uncertainty prevents `reviewComplete: true`. Complete means recorded coverage only; `visualCorrectnessVerified` is always false. Finding counts may include the same object in overlapping regions and are not unique-defect counts or accuracy scores. After finalization, recording and zoom generation are frozen.

The claimed viewed hash is only the model's declaration. For an independent experiment, audit actual image-view tool calls separately. A successful CLI record does not prove that the model viewed, understood, or correctly judged the image. This workflow neither repairs defects nor closes conversion issues.

## Implementation origin (renderer)

`src/scene.mjs` and `src/crops.mjs` were adapted from the existing transform-svg project's local renderer and conservative crop checker. The new project fixes the resvg marker-orientation issue and adds an independent command contract, immutable attempt logging and pixel-based arrow regression tests. No old project path is imported at runtime. Native SVG text, source crops and raster preview behavior are covered by local tests.
