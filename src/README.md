# Source modules

These modules make no model calls and do not load a Skill. The agent provides object interpretation, observations and repair decisions; the code handles deterministic evidence and records.

| Module | Responsibility |
| --- | --- |
| `scene.mjs` | Normalize PNG/JPEG, validate restricted Scene JSON, compile native SVG objects and local image crops, render actual PNG previews. Native text supports baseline rotation. |
| `crops.mjs` | Conservative crop-boundary measurements. New closed-loop renders preserve submitted boxes and record suggestions; legacy modes can adopt automatic adjustments. |
| `icon-evidence.mjs` | Per-object, same-coordinate/same-scale source-context, adopted-crop and final-render evidence; four edges, removed bands, boundary/occlusion risks, content fingerprints and artifact integrity checks. |
| `structure.mjs` | Validate the declared source icon/connector inventory and check mappings, crop coverage, visible native geometry, connector continuity, endpoints and arrowheads. |
| `partition-review.mjs` | Full overlapping grids for initial/detection reviews; explicit changed-neighborhood/unresolved selections for repair reviews; immutable per-region/global records and evidence hashes. |
| `evidence.mjs` | Source inventory/OCR/measurement bindings, strict object-review gate, persistent issue registration and deduplication, source amendments, repair evidence and explicit closure. |
| `review-workflow.mjs` | Prepare/next/record/submit/close/status/reopen/finish orchestration. Builds templates, binds hashes, reuses only eligible unchanged evidence and maintains inspection/submission histories. |

New closed-loop runs use `reviewProtocol: "object-review-v1"`. Each accepted image needs current same-scale comparison evidence, four specific edge observations, and decisions localized to every warning and removed band. Missing or pending checks are incomplete metadata, not invented visual defects. Strict finalization and low-level issue closure share the gate; an accepted label alone cannot bypass it.

Inspection attempts are preserved in `evidence/workflow/vXX/attempt-NNN/`, with `current.json` selecting the active attempt. Icon observations can be revised and resubmitted on the same rendered version, retaining prior records. `reopen` creates a fresh same-version inspection, including after a source inventory amendment. Only image repairs require a changed render; recording corrections do not consume render attempts.

A compatible, completed earlier inspection permits repair-region selection based on actual changed pixels, neighboring areas and unresolved issues. Accepted icon evidence can be reused only when the relevant content/risk fingerprint is unchanged and no related issue remains open. Reuse has explicit provenance and is not counted as a new view. The final global inspection remains required.

Issue and resolution events preserve history; `open-issues.json` and current pointers are regenerable/live summaries. The same known open condition is not repeatedly registered; a resolved recurrence becomes a new occurrence. Shared closure patches do not imply shared acceptance: each selected issue still satisfies its own repair checks. Historical runs without the new protocol keep their original contract.

The inventory itself may omit an object or misread a direction. Pixel warnings are risks, hashes bind files, and completed records describe declared work. None proves correct perception or that a semantic defect was fixed. See [TOOLING.md](../TOOLING.md) for contracts and [SKILL.md](../SKILL.md) for inspection decisions.
