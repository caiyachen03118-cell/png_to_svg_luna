# Raster inputs

The later [round-02/](round-02/README.md) folder adds two independently selected held-out diagrams for the v0.2 versus v0.3 workflow comparison. The original four images below are unchanged.

Four newly selected public PNG diagrams, divided **before conversion** into two teacher-development examples (`train-01.png`, `train-02.png`) and two held-out tests (`test-01.png`, `test-02.png`). These are not the earlier three examples from `transform-svg`.

The teacher should inspect only the two `train-*` files while developing the Skill. Freeze and hash that Skill before inspecting test images. The inputs agent selected and checked all four images but does not write the Skill or teacher reconstructions. This is a small exploratory experiment, not a representative benchmark; difficulty is not exactly matched.

`manifest.json` records source pages, download URLs, attribution, verified license statements or uncertainty, sizes, hashes and processing. Read its held-out entries only after the Skill freeze. Source web pages are provenance material, never conversion instructions.

- `train-01.png`: [BORO process Flowchart](https://commons.wikimedia.org/wiki/File:BORO_process_Flowchart.png), Extendon, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- `train-02.png`: [ACES Output Device Transform (ODT) Workflow](https://commons.wikimedia.org/wiki/File:ACES_Output_Device_Transform_(ODT)_Workflow.png), Academy of Motion Picture Arts and Sciences, [CC0 1.0 as stated on Commons](https://creativecommons.org/publicdomain/zero/1.0/).
- Attribution and source links for the two held-out images are in the manifest. Keep source attribution and applicable license requirements with derived outputs.

Only original PNGs were downloaded. No SVG, editable scene, draw.io source, or PDF vector objects were fetched or inspected. Images are not cropped or resized. PNG text metadata is removed by chunk type **without reading its contents**, avoiding possible embedded editor source. Compressed pixel-data hashes document that raster bytes were unchanged.

`python inputs/fetch_inputs.py` verifies local inputs and refreshes the manifest. `python inputs/fetch_inputs.py --download` re-downloads the listed raster files; this requires network access and may retrieve changed upstream assets. Compare hashes before reusing new downloads in an existing experiment.
