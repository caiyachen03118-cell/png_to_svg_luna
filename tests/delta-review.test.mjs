import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { partitionGrid, selectChangedRegions, createPartitionReview, recordPartitionReview, recordGlobalReview, partitionReviewStatus, finalizePartitionReview } from '../src/partition-review.mjs';

const gridOptions = { tileSize: 128, overlap: 32, contextPadding: 16 };
const image = async (width, height, objects = '') => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${objects}</svg>`)).png().toBuffer();
const rect = (x, y, w = 1, h = 1, fill = 'black') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-delta-test-'));
  try { await fn(directory); } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-delta-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}

test('local changes select intersecting cells and context neighbors without selecting the entire bounding box of distant changes', async () => {
  const width = 512, height = 512, before = await image(width, height);
  const after = await image(width, height, rect(130, 130) + rect(490, 490));
  const selected = await selectChangedRegions(before, after, gridOptions);
  const grid = partitionGrid(width, height, gridOptions);
  const expected = grid.regions.filter(r => [[130, 130], [490, 490]].some(([x, y]) =>
    x >= r.bbox[0] - 16 && x < r.bbox[2] + 16 && y >= r.bbox[1] - 16 && y < r.bbox[3] + 16));
  assert.deepEqual(selected.regionIds, expected.map(r => r.id));
  assert.equal(selected.changedPixels, 2);
  assert.ok(selected.regionIds.length < grid.regions.length);
  assert.ok(!selected.regionIds.includes('r013'), 'central unchanged cell must not be selected by a large global change bbox');
  assert.deepEqual(selected.selectionReasonById.r001, ['changed_pixel_context']);
  assert.deepEqual(selected.selectionReasonById.r007, ['changed_pixels']);
  assert.equal(selected.visualCorrectnessVerified, false);
  assert.equal(selected.mode, 'incremental');
});

test('object removal and an occluding overlay are detected from render pixels in either direction', async () => {
  const before = await image(256, 256, rect(40, 40, 12, 16));
  const removed = await image(256, 256);
  const occluded = await image(256, 256, rect(40, 40, 12, 16) + rect(40, 40, 12, 8, 'white'));
  const deletion = await selectChangedRegions(before, removed, gridOptions);
  const occlusion = await selectChangedRegions(before, occluded, gridOptions);
  assert.equal(deletion.changedPixels, 12 * 16);
  assert.equal(occlusion.changedPixels, 12 * 8);
  assert.ok(deletion.regionIds.includes('r001'));
  assert.ok(occlusion.regionIds.includes('r001'));
  assert.equal((await selectChangedRegions(removed, before, gridOptions)).changedPixels, deletion.changedPixels);
});

test('identical pixels skip local cells even with different PNG encoding; white-composited alpha policy matches review images', async () => {
  const original = await image(256, 256, rect(30, 30, 10, 10));
  const recompressed = await sharp(original).png({ compressionLevel: 0 }).toBuffer();
  const result = await selectChangedRegions(original, recompressed, gridOptions);
  assert.equal(result.changedPixels, 0); assert.deepEqual(result.regionIds, []);
  assert.equal(result.previousPixelSha256, result.currentPixelSha256);
  const transparent = await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 17, g: 88, b: 29, alpha: 0 } } }).png().toBuffer();
  const opaque = await image(256, 256);
  assert.equal((await selectChangedRegions(transparent, opaque, gridOptions)).changedPixels, 0);
});

test('unresolved or unreviewed required ROIs keep cells selected despite no pixel changes', async () => {
  const original = await image(512, 512);
  const result = await selectChangedRegions(original, original, { ...gridOptions, requiredRois: [
    { id: 'unresolved-icon', bbox: [200, 200, 205, 205], reason: 'Previously cut node remains unresolved.' },
    [490, 490, 500, 500],
  ] });
  const expected = partitionGrid(512, 512, gridOptions).regions.filter(r =>
    [[184, 184, 221, 221], [474, 474, 516, 516]].some(b => r.bbox[0] < b[2] && r.bbox[2] > b[0] && r.bbox[1] < b[3] && r.bbox[3] > b[1]));
  assert.equal(result.changedPixels, 0);
  assert.deepEqual(result.regionIds, expected.map(r => r.id));
  assert.ok(Object.values(result.selectionReasonById).flat().includes('required_roi:unresolved-icon'));
  assert.ok(result.requiredRois[0].reason.includes('unresolved'));
  await assert.rejects(selectChangedRegions(original, original, { ...gridOptions, requiredRois: [[0, 0, 999, 999]] }), /within the image/);
});

test('first/default review remains full-grid; selected empty review still requires global review and declares its limited scope', async () => temporary(async directory => {
  const png = await image(256, 256), path = join(directory, 'input.png');
  await writeFile(path, png);
  await assert.rejects(selectChangedRegions(null, path, gridOptions), /full-grid/);
  const initial = await createPartitionReview(path, path, join(directory, 'initial'), gridOptions);
  assert.equal(initial.reviewScope, 'full_grid');
  assert.equal(initial.coverageSummary.fullCanvasCovered, true);
  assert.equal(initial.regions.length, 9);
  const selection = await selectChangedRegions(path, path, gridOptions);
  const selected = await createPartitionReview(path, path, join(directory, 'selected'), { ...gridOptions, selectedRegionIds: selection.regionIds, selectionEvidence: selection });
  assert.equal(selected.reviewScope, 'selected_regions');
  assert.equal(selected.coverageSummary.fullCanvasCovered, false);
  assert.equal(selected.coverageSummary.coveredPixels, 0);
  assert.equal(selected.coverageSummary.fullGridRegionCount, 9);
  assert.equal(selected.coverageSummary.selectedRegionCount, 0);
  assert.deepEqual(selected.regions, []);
  await assert.rejects(finalizePartitionReview(selected.run), /global pending/);
  const global = join(directory, 'global.json');
  await writeFile(global, JSON.stringify({ viewedOverviewSha256: selected.overviewSha256, summary: 'No new differences claimed in the global overview; earlier issues are not thereby cleared.',
    checks: { crossRegionConnectors: 'not_applicable', iconCompleteness: 'no_difference', omissions: 'no_difference' }, findings: [], uncertain: [] }));
  await recordGlobalReview(selected.run, global);
  const report = await finalizePartitionReview(selected.run);
  assert.equal(report.reviewScope, 'selected_regions');
  assert.equal(report.reviewComplete, true);
  assert.equal(report.fullGridCoverageRecorded, false);
  assert.equal(report.visualCorrectnessVerified, false);
  assert.match(report.note, /skipped regions were not inspected in detail/);
}));

test('selected reviews preserve grid IDs, exact union coverage, and normal immutable record semantics', async () => temporary(async directory => {
  const path = join(directory, 'input.png'); await writeFile(path, await image(256, 256));
  const result = await createPartitionReview(path, path, join(directory, 'selected'), { ...gridOptions, selectedRegionIds: ['r005', 'r002'] });
  assert.deepEqual(result.regions.map(r => r.id), ['r002', 'r005']);
  assert.equal(result.coverageSummary.coveredPixels, 128 * (128 + 96));
  assert.equal(result.coverageSummary.cropPixelSum, 2 * 128 * 128);
  assert.deepEqual((await partitionReviewStatus(result.run)).pendingRegions, ['r002', 'r005']);
  for (const region of result.regions) {
    const path = join(directory, `${region.id}.json`);
    await writeFile(path, JSON.stringify({ regionId: region.id, viewedPairSha256: region.pairSha256, summary: 'The selected local pair is uniformly white.',
      checks: { text: 'not_applicable', shape: 'not_applicable', connector: 'not_applicable', boundary: 'no_difference' }, findings: [], uncertain: [] }));
    await recordPartitionReview(result.run, path);
  }
  const status = await partitionReviewStatus(result.run);
  assert.equal(status.recordedRegions, 2);
  assert.equal(status.fullGridRegionCount, 9);
  assert.equal(status.globalStatus, 'pending');
  await assert.rejects(finalizePartitionReview(result.run), /global pending/);
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(manifest.selectionEvidence, null);
  assert.match(manifest.selectionEvidenceNote, /not proof/);
}));

test('selection rejects stale pixel hashes, invalid IDs, mismatched grid evidence, and changed canvas size', async () => temporary(async directory => {
  const beforePath = join(directory, 'before.png'), afterPath = join(directory, 'after.png');
  await writeFile(beforePath, await image(256, 256));
  await writeFile(afterPath, await image(256, 256, rect(200, 200)));
  const selection = await selectChangedRegions(beforePath, afterPath, gridOptions);
  const run = join(directory, 'refused');
  await assert.rejects(createPartitionReview(beforePath, beforePath, run, { ...gridOptions, selectedRegionIds: selection.regionIds, selectionEvidence: selection }), /currentPixelSha256/);
  await assert.rejects(createPartitionReview(beforePath, afterPath, run, { ...gridOptions, selectedRegionIds: ['r999'] }), /unique existing/);
  await assert.rejects(createPartitionReview(beforePath, afterPath, run, { ...gridOptions, selectedRegionIds: ['r001', 'r001'] }), /unique existing/);
  await assert.rejects(createPartitionReview(beforePath, afterPath, run, { ...gridOptions, selectedRegionIds: [], selectionEvidence: selection }), /regionIds/);
  await assert.rejects(createPartitionReview(beforePath, afterPath, run, { ...gridOptions, selectionEvidence: selection }), /explicit selectedRegionIds/);
  await assert.rejects(selectChangedRegions(beforePath, await image(257, 256), gridOptions), /dimensions must match/);
}));
