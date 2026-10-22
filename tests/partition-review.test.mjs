import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { partitionGrid, createPartitionReview, recordPartitionReview, recordGlobalReview, partitionReviewStatus, finalizePartitionReview, zoomPartitionReview } from '../src/partition-review.mjs';

async function fixture(fn, { width = 160, height = 100, tileSize = 128, overlap = 32 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-partition-test-'));
  try {
    const reference = join(directory, 'reference.png'), candidate = join(directory, 'candidate.png'), run = join(directory, 'run');
    const original = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="20" y="20" width="25" height="30" fill="red"/></svg>`)).png().toBuffer();
    await writeFile(reference, original); await writeFile(candidate, original);
    const manifestResult = await createPartitionReview(reference, candidate, run, { tileSize, overlap });
    const manifest = JSON.parse(await readFile(join(run, 'manifest.json'), 'utf8'));
    const write = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value)); return path; };
    const regionRecord = (r = manifest.regions[0]) => ({ regionId: r.id, viewedPairSha256: r.pairSha256, summary: 'Red rectangle and its whitespace agree in A and B.',
      checks: { text: 'not_applicable', shape: 'no_difference', connector: 'not_applicable', boundary: 'no_difference' }, findings: [], uncertain: [] });
    const globalRecord = () => ({ viewedOverviewSha256: manifest.overview.sha256, summary: 'Entire rectangle is present; no connectors or text occur in either image.',
      checks: { crossRegionConnectors: 'not_applicable', iconCompleteness: 'no_difference', omissions: 'no_difference' }, findings: [], uncertain: [] });
    const recordAll = async () => { for (const r of manifest.regions) await recordPartitionReview(run, await write(`${r.id}.json`, regionRecord(r))); };
    await fn({ directory, reference, candidate, run, manifestResult, manifest, write, regionRecord, globalRecord, recordAll, original });
  } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-partition-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}

test('fixed grid covers every pixel including edges and yields real overlap', () => {
  for (const [width, height, tileSize, overlap] of [[641, 129, 128, 32], [1301, 771, 640, 96], [50, 30, 640, 96], [640, 640, 640, 96]]) {
    const grid = partitionGrid(width, height, { tileSize, overlap }), counts = new Uint8Array(width * height);
    for (const r of grid.regions) {
      assert.ok(r.bbox[2] - r.bbox[0] <= tileSize); assert.ok(r.bbox[3] - r.bbox[1] <= tileSize);
      for (let y = r.bbox[1]; y < r.bbox[3]; y++) for (let x = r.bbox[0]; x < r.bbox[2]; x++) counts[y * width + x]++;
    }
    assert.ok(counts.every(n => n >= 1));
    assert.equal(grid.coverageSummary.coveredPixels, counts.filter(n => n > 0).length);
    if (grid.regions.length > 1) assert.ok(counts.some(n => n > 1));
    else assert.deepEqual(grid.regions[0].bbox, [0, 0, width, height]);
    for (let i = 1; i < grid.xStarts.length; i++) assert.ok(grid.xStarts[i - 1] + tileSize - grid.xStarts[i] >= overlap);
  }
  assert.throws(() => partitionGrid(640, 640, { tileSize: 64, overlap: 64 }), /overlap/);
});

test('create flattens transparency equally, keeps 1x region pixels, and refuses mismatch or existing output', async () => fixture(async f => {
  const data = await sharp(join(f.run, 'reference.png')).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data.info.channels, 3);
  assert.deepEqual([...data.data.subarray(0, 3)], [255, 255, 255]);
  const redOffset = (25 * data.info.width + 25) * 3;
  assert.deepEqual([...data.data.subarray(redOffset, redOffset + 3)], [255, 0, 0]);
  assert.deepEqual(await readFile(join(f.run, 'reference.png')), await readFile(join(f.run, 'candidate.png')));
  const r = f.manifest.regions[0], pairMeta = await sharp(join(f.run, r.pair)).metadata();
  assert.equal(pairMeta.width, 2 * (r.bbox[2] - r.bbox[0]) + 16);
  assert.equal(pairMeta.height, r.bbox[3] - r.bbox[1] + 36);
  assert.ok(pairMeta.width <= 1400 && pairMeta.height <= 750);
  const region = await sharp(join(f.run, r.reference)).raw().toBuffer();
  const pairPanel = await sharp(join(f.run, r.pair)).extract({ left: 0, top: 36, width: 128, height: 100 }).removeAlpha().raw().toBuffer();
  assert.deepEqual(region, pairPanel);
  await assert.rejects(createPartitionReview(f.reference, f.candidate, f.run), /EEXIST/);
  const wrong = join(f.directory, 'wrong.png');
  await sharp({ create: { width: 99, height: 98, channels: 3, background: 'white' } }).png().toFile(wrong);
  await assert.rejects(createPartitionReview(f.reference, wrong, join(f.directory, 'mismatch')), /dimensions must match/);
}));

test('region record requires matching visual hash, observed evidence, consistent checks and in-region boxes', async () => fixture(async f => {
  const valid = f.regionRecord();
  await assert.rejects(recordPartitionReview(f.run, await f.write('bad-hash.json', { ...valid, viewedPairSha256: 'abc' })), /viewedPairSha256/);
  const finding = { bbox: [140, 1, 150, 10], kind: 'crop', description: 'Candidate cuts the contour.', evidence: ['A has a continuous edge; B ends abruptly.'] };
  const checks = { ...valid.checks, boundary: 'difference' };
  await assert.rejects(recordPartitionReview(f.run, await f.write('outside.json', { ...valid, checks, findings: [finding] })), /outside the reviewed region/);
  await assert.rejects(recordPartitionReview(f.run, await f.write('no-evidence.json', { ...valid, checks, findings: [{ ...finding, bbox: [20, 20, 40, 40], evidence: [] }] })), /observed evidence/);
  await assert.rejects(recordPartitionReview(f.run, await f.write('no-finding.json', { ...valid, checks })), /requires at least one/);
  await assert.rejects(recordPartitionReview(f.run, await f.write('missing-check.json', { ...valid, checks: { shape: 'no_difference' } })), /checks.text/);
  assert.deepEqual((await partitionReviewStatus(f.run)).pendingRegions, ['r001', 'r002']);
}));

test('records are immutable, append-only, hash bound, and status reports pending rather than passed', async () => fixture(async f => {
  const recordPath = await f.write('record.json', f.regionRecord());
  const result = await recordPartitionReview(f.run, recordPath);
  assert.equal(result.status, 'checked_no_difference');
  const logBefore = await readFile(join(f.run, 'events.jsonl'));
  await assert.rejects(recordPartitionReview(f.run, recordPath), /already recorded/);
  assert.deepEqual(await readFile(join(f.run, 'events.jsonl')), logBefore);
  const status = await partitionReviewStatus(f.run);
  assert.deepEqual(status.pendingRegions, ['r002']); assert.equal(status.globalStatus, 'pending');
  const initialLedger = JSON.parse(await readFile(join(f.run, 'ledger.json'), 'utf8'));
  assert.ok(initialLedger.regions.every(r => r.status === 'pending'));
  assert.equal(initialLedger.kind, 'immutable_initial_ledger');
  const r2 = f.manifest.regions[1];
  await recordPartitionReview(f.run, await f.write('record2.json', f.regionRecord(r2)));
  const logAfter = await readFile(join(f.run, 'events.jsonl'));
  assert.deepEqual(logAfter.subarray(0, logBefore.length), logBefore);
  const events = logAfter.toString().trim().split('\n').map(JSON.parse);
  assert.equal(events[1].previousEventSha256, events[0].eventSha256);
  const mutated = JSON.parse(await readFile(join(f.run, 'records/r001.json'), 'utf8'));
  mutated.summary = 'Changed claim';
  await writeFile(join(f.run, 'records/r001.json'), JSON.stringify(mutated));
  await assert.rejects(partitionReviewStatus(f.run), /Immutable review record changed/);
}));

test('source changes and evidence image changes cannot be registered or finalized', async () => fixture(async f => {
  await writeFile(join(f.run, 'candidate.png'), f.original);
  await assert.rejects(recordPartitionReview(f.run, await f.write('record.json', f.regionRecord())), /candidate input hash changed/);
  await writeFile(join(f.run, 'candidate.png'), await readFile(join(f.run, 'reference.png')));
  await writeFile(join(f.run, f.manifest.regions[0].pair), 'not an image');
  await assert.rejects(recordPartitionReview(f.run, await f.write('record.json', f.regionRecord())), /Evidence image hash changed/);
}));

test('finalization refuses missing regions/global and freezes completed coverage without quality approval', async () => fixture(async f => {
  await assert.rejects(finalizePartitionReview(f.run), /Cannot finalize incomplete coverage/);
  await assert.rejects(recordGlobalReview(f.run, await f.write('global.json', f.globalRecord())), /requires all regions first/);
  await f.recordAll();
  await assert.rejects(finalizePartitionReview(f.run), /global pending/);
  await recordGlobalReview(f.run, await f.write('global.json', f.globalRecord()));
  const result = await finalizePartitionReview(f.run);
  assert.equal(result.status, 'review_complete_no_reported_findings');
  assert.equal(result.reviewComplete, true); assert.equal(result.visualCorrectnessVerified, false);
  const reportBefore = await readFile(join(f.run, 'report.json'));
  await assert.rejects(finalizePartitionReview(f.run), /Run is finalized/);
  assert.deepEqual(await readFile(join(f.run, 'report.json')), reportBefore);
  await assert.rejects(zoomPartitionReview(f.run, [0, 0, 100, 100], 'after'), /Run is finalized/);
}));

test('uncertainty prevents complete status even with complete recorded grid coverage', async () => fixture(async f => {
  for (const r of f.manifest.regions) {
    const item = f.regionRecord(r);
    if (r.id === 'r001') { item.checks.boundary = 'uncertain'; item.uncertain = ['The antialiased edge cannot be judged at this scale.']; }
    await recordPartitionReview(f.run, await f.write(`${r.id}.json`, item));
  }
  await recordGlobalReview(f.run, await f.write('global.json', f.globalRecord()));
  const result = await finalizePartitionReview(f.run);
  assert.equal(result.status, 'review_incomplete_uncertain'); assert.equal(result.reviewComplete, false);
  assert.deepEqual(result.uncertainRegions, ['r001']); assert.equal(result.coverageRecorded, true);
}));

test('real finding declarations remain findings at completion and supplemental zoom never checks a grid cell', async () => fixture(async f => {
  const zoom = await zoomPartitionReview(f.run, [0, 0, 160, 100], 'whole-context');
  assert.equal(zoom.gridCoverageChanged, false); assert.equal(zoom.sourcePixelScale, 1);
  assert.equal((await partitionReviewStatus(f.run)).recordedRegions, 0);
  await assert.rejects(zoomPartitionReview(f.run, [0, 0, 160, 100], 'whole-context'), /EEXIST/);
  await f.recordAll();
  const global = f.globalRecord();
  global.checks.omissions = 'difference';
  global.findings.push({ bbox: [20, 20, 45, 50], kind: 'test-claim', description: 'Synthetic declared difference for protocol test, not real ground truth.', evidence: ['This assertion is only a recorded model claim.'] });
  await recordGlobalReview(f.run, await f.write('global.json', global));
  const result = await finalizePartitionReview(f.run);
  assert.equal(result.status, 'review_complete_with_findings'); assert.equal(result.findingCount, 1);
  assert.equal(result.visualCorrectnessVerified, false);
}));
