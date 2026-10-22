# Round 04 original raster inputs

Prepared 2026-10-19 for the independent GPT-6 Luna PNG-to-SVG test.

| Input | Original source | Resolution | SHA-256 |
| --- | --- | --- | --- |
| [test-01.png](test-01.png) | [GoalAct framework](https://github.com/cjj826/GoalAct/blob/master/framework.png) | 1858 x 962 | `5c85f17b9f8854cf7821da78605326911863e8a07c00f4821ad820892d654e3f` |
| [test-02.png](test-02.png) | [DCNet framework](https://github.com/USTCL/DCNet/blob/main/framework.png) | 2058 x 1096 | `791cc35158d3c81d428a43ae106e31cfed9fe1cb120a9f531fe07893f81c6349` |

Only original PNG image bytes were downloaded as conversion inputs. Pixels, resolution, color data and compressed IDAT data are preserved. No cropping, resizing, redrawing or simplification was performed. The metadata filter recognizes PNG text chunk types without decoding their contents and discards bytes after IEND without interpretation. Neither selected original contained text chunks or trailing bytes. File hashes, CRCs, successful image viewing, IDAT decompression and absence of text chunks were verified.

The selection agent checked the pixels for task suitability. Before Skill freeze only neutral metadata is disclosed to the Skill author. No per-image layout description, annotated image, vector source or reconstruction guidance is provided. No SVG, drawio, scene source or PNG text payload was inspected. Selected hashes were compared with both earlier manifests and the three old project input PNGs; none match.

GoalAct: the official repository and linked arXiv abstract were verified. No repository license or image-specific permission was found in the checked root listing or README. Image/component licensing and individual illustrator attribution remain unknown.

DCNet: the official repository and MIT LICENSE were verified. The repository license is MIT, copyright (c) 2023 USTCL; permission for the image and embedded third-party material specifically remains unverified. Paper authors are credited from the official README. The linked CVF paper page returned HTTP 403 during verification.

See [manifest.json](manifest.json) for original image URLs, paper links, author context, original/download hashes, IDAT hashes, byte counts and transformation records. Files are local experimental inputs, not a claim of unrestricted redistribution rights.
