# Tests

Historical run paths below refer to local experiment archives and are not distributed in the team source repository. The tests generate their own fixtures and do not require those archives.

Run `npm test`. Tests cover strict scene validation, crop pixel preservation, text escaping, conservative icon boundary repair, rendered arrow directions and endpoints, and immutable CLI attempt accounting. Tests use synthetic fixtures generated in temporary directories and require no external model/API.

The v0.8 additions exercise the new review contract:

- `icon-evidence.test.mjs`: same-scale source/adopted/final-render views, actual edge/deleted-band evidence, conservative risk signals, retained context and artifact integrity.
- `object-review.test.mjs`: plain accepted labels cannot dismiss warnings; missing/stale evidence, invalid localizations and repeated templates remain incomplete; pending does not auto-close or invent defects; strict low-level finalization/closure cannot bypass object evidence; open issues deduplicate and resolved recurrences preserve prior history.
- `delta-review.test.mjs`: changed-region selection includes neighboring areas and unresolved regions, and keeps selection evidence separate from complete initial/detection coverage.
- `review-workflow.test.mjs`: unified queue, mechanically bound hashes, explicit semantic records, preserved attempts/submissions, same-version corrections and selective issue closure.

New strict fixtures use the default `object-review-v1` protocol. Historical closed-loop compatibility fixtures explicitly request the legacy API mode; they are not evidence that new strict gates can be bypassed. Running these tests does not invoke Luna and does not measure whether v0.8 finds more clipping errors or consumes fewer tokens. No new Luna conversion outcome is claimed by this tool update.

`partition-review.test.mjs` adds eight tests for full-grid coverage and overlap, 1x crop pixels and alpha normalization, dimension/hash/bbox validation, immutable records, incomplete-coverage gates, uncertainty, and supplemental zooms that do not silently count as reviewed regions. Before the independent partition experiment the complete suite passed **106/106**, recorded in tool-validation.json（本机归档：`../runs/diagnostic-03-partition-review/tool-validation.json`）.

`rotation.test.mjs` verifies native text rotation, bounds and types, XML escaping, horizontal compatibility, actual glyph orientation at ±90°, and baseline-pivot rendering with font styles and text anchoring preserved.

`evidence.test.mjs` covers real source-pixel bounds, missing/stale evidence gates, OCR candidate accounting, changed/omitted native text, missing crop reviews, stale final images and clipping through a uniform-colored foreground. It also checks that changing only the purpose of a measurement does not count as a second distinct measurement. Local OCR is separately smoke-tested with synthetic source text; OCR output is not a ground-truth test oracle.

The post-experiment regression cases render actual pixels to reject zero-opacity text, invisible fill/stroke and nonprinting text while accepting visible stroke-only glyphs. The second-round historical suite had 57 passing tests; the final third-round suite had 86. Before round-04 freeze, the implementation agent ran the full suite with 89 passing tests; its reported result is retained in `runs/round-04/tool-tests.json`.

`structure.test.mjs` covers source icon/connector inventory validation, missing and incorrectly represented icons, crop coverage, connector continuity, endpoint/arrowhead directions and explicit missing review entries. `closure.test.mjs` covers persistent issues, stale review/artifact rejection, incomplete or unresolved finalization, later-version repairs, actual target/ROI changes and the two-step generated-patch hash acknowledgement. These tests use synthetic scenes rather than treating model declarations as ground truth.

Round-04 adds evidenced Luna self-amendment cases: missing/stale or insufficient source context is rejected; a legitimate corrected annotation can close its automatic mismatch after patch review; a manual visual defect still requires real repair; explicit retirement of a falsely annotated connection preserves its history and safeguards.

Before round-05 freeze the full suite passed 95/95, with raw output in tool-tests.tap（本机归档：`../runs/round-05/tool-tests.tap`）. New closure cases verify crop repair outside the original ROI, expansion/shrinking and oversized discovery crops, unchanged-boundary/unrelated-context rejection (including mixed image/native targets), grouped plans with default pending decisions, partial and blocked closure, tampered/stale patches/reviews/inventories/renders, and rejection of finalizing an older successful version. They establish software behavior, not visual correctness of a Luna run.

`budget.test.mjs` verifies closed-loop defaults and 1–12 attempt bounds, two-digit versions, CLI/API behavior, legacy three-attempt accounting, free review/duplicate-proposal gate refusals and allowed repairs while issues remain open. Its pixel fixture compares legacy automatic crop changes with closed-loop preservation of the submitted box and recorded suggestions.

Passing tests establish specific software checks, not the quality of a model conversion. Source inventories and visual acceptance can still be wrong; independent inspection of source and SVG remains required. Image conversion outcomes must be reported separately from these tool tests.
