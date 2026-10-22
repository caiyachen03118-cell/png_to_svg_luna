import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, appendFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { compileScene, validateScene } from '../src/scene.mjs';
import { ensureIconEvidence, loadIconEvidence } from '../src/icon-evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const image = bbox => ({ id: 'network', type: 'image', bbox_px: bbox, kind: 'icon', reason: 'Preserve this source network icon.' });

async function fixture(fn, large = false) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-icon-evidence-'));
  try {
    const run = join(directory, 'run'), width = large ? 600 : 220, height = large ? 1300 : 160;
    const body = large
      ? '<rect x="105" y="105" width="80" height="1060" fill="#1566c0"/>'
      : '<rect x="50" y="35" width="10" height="12" fill="#111111"/><rect x="50" y="47" width="50" height="43" fill="#1566c0"/>';
    const source = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${body}</svg>`)).ensureAlpha().png().toBuffer();
    await mkdir(run);
    await writeFile(join(run, 'source.png'), source);
    await writeFile(join(run, 'manifest.json'), json({ protocol: 'luna-local-render-v1', width, height, sourceSha256: hash(source), maxRenderAttempts: 8 }));
    await writeFile(join(run, 'render-events.jsonl'), '');
    const render = async (version, bbox, extra = [], ambiguous = false) => {
      const ctx = { width, height, sourcePng: source };
      const scene = validateScene({ width, height, background: '#ffffff', elements: [image(bbox), ...extra] }, ctx);
      const result = await compileScene(scene, ctx), sceneBytes = json(scene);
      const path = join(run, version);
      await mkdir(path);
      await Promise.all([writeFile(join(path, 'scene.json'), sceneBytes), writeFile(join(path, 'preview.png'), result.png),
        writeFile(join(path, 'result.svg'), result.svg),
        writeFile(join(path, 'crop-audit.json'), json({ items: [{ id: 'network', kind: 'icon', status: ambiguous ? 'needs_review' : 'unchanged', reason: ambiguous ? 'Multiple nearby silhouettes.' : 'No automatic boundary warning.' }] })),
        writeFile(join(path, 'stats.json'), json({ protocol: 'luna-local-render-v1', version, width, height, sourceSha256: hash(source),
          sceneSha256: hash(sceneBytes), previewSha256: hash(result.png), svgSha256: hash(result.svg) }))]);
      await appendFile(join(run, 'render-events.jsonl'), `${JSON.stringify({ event: 'success', version })}\n`);
      return { scene, result, path };
    };
    await fn({ directory, run, source, width, height, render });
  } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-icon-evidence-')) throw new Error('Unexpected cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}
async function pixels(path) { return sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true }); }
const rgbAt = (raw, x, y) => [...raw.data.subarray((y * raw.info.width + x) * 3, (y * raw.info.width + x) * 3 + 3)];
function inPanel(item, panel, x, y) {
  return [item.comparison.layout.panelOffsets[panel] + (x - item.contextBox[0]) * item.scale,
    item.comparison.layout.header + (y - item.contextBox[1]) * item.scale];
}

test('same-coordinate triptych exposes removed node pixels, actual crop, and final occlusion without annotations obscuring evidence', async () => fixture(async f => {
  await f.render('v01', [40, 30, 110, 100]);
  await f.render('v02', [40, 42, 110, 100], [{ id: 'cover', type: 'rect', x: 50, y: 70, width: 50, height: 3, fill: '#888888', stroke: 'none' }], true);
  const report = await ensureIconEvidence(f.run, 'v02'), item = report.items[0];
  assert.equal(report.previousVersion, 'v01');
  assert.equal(item.scale, 4);
  assert.deepEqual(item.bbox, [40, 42, 110, 100]);
  assert.equal(item.edges.length, 4);
  const removed = item.removedBands.find(row => row.side === 'top');
  assert.deepEqual(removed.bbox, [40, 30, 110, 42]);
  // Seven black rows of a ten-pixel-wide disconnected upper node were lost.
  assert.equal(removed.measurement.foregroundPixels, 70);
  assert.ok(item.warnings.some(row => row.id === 'shrink-foreground-top'));
  assert.ok(item.warnings.some(row => row.id === 'edge-touch-top'));
  assert.ok(item.warnings.some(row => row.id === 'automatic-ambiguous'));
  const coverage = item.warnings.find(row => row.id === 'render-difference');
  assert.equal(coverage.measurement.foregroundChangedPixels, 150);
  assert.deepEqual(coverage.bbox, [50, 70, 100, 73]);
  const raw = await pixels(item.comparison.path);
  // All panels place a source coordinate at exactly the same relative pixel.
  assert.deepEqual(rgbAt(raw, ...inPanel(item, 0, 54, 38)), [17, 17, 17]);
  assert.ok([216, 236].includes(rgbAt(raw, ...inPanel(item, 1, 54, 38))[0]));
  assert.deepEqual(rgbAt(raw, ...inPanel(item, 2, 54, 38)), [255, 255, 255]);
  assert.deepEqual(rgbAt(raw, ...inPanel(item, 0, 55, 71)), [21, 102, 192]);
  assert.deepEqual(rgbAt(raw, ...inPanel(item, 1, 55, 71)), [21, 102, 192]);
  assert.deepEqual(rgbAt(raw, ...inPanel(item, 2, 55, 71)), [136, 136, 136]);
  // Nearest-neighbor zoom preserves each complete 4x4 source-pixel block.
  const [x, y] = inPanel(item, 0, 54, 38);
  for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) assert.deepEqual(rgbAt(raw, x + dx, y + dy), [17, 17, 17]);
  assert.notEqual(item.annotated.sha256, item.comparison.sha256);
  assert.equal(item.sourceContextSha256.length, 64);
  assert.equal(item.contentFingerprint.length, 64);
}));

test('idempotent evidence retains hashes, tolerates later appended renders, and rejects modified evidence files', async () => fixture(async f => {
  await f.render('v01', [40, 30, 110, 100]);
  const first = await ensureIconEvidence(f.run, 'v01');
  assert.deepEqual(await ensureIconEvidence(f.run, 'v01'), first);
  await f.render('v02', [39, 30, 110, 100]);
  assert.equal((await loadIconEvidence(f.run, 'v01')).manifestSha256, first.manifestSha256);
  await appendFile(first.items[0].edges[2].path, 'tampered');
  await assert.rejects(loadIconEvidence(f.run, 'v01'), /artifact hash changed/);
  await assert.rejects(ensureIconEvidence(f.run, 'v01'), /artifact hash changed/);
}));

test('stale current or previous scene/source bindings cannot silently regenerate evidence', async () => fixture(async f => {
  await f.render('v01', [40, 30, 110, 100]);
  await f.render('v02', [40, 42, 110, 100]);
  await ensureIconEvidence(f.run, 'v02');
  const oldPath = join(f.run, 'v01', 'scene.json'), before = await readFile(oldPath);
  await appendFile(oldPath, ' ');
  await assert.rejects(loadIconEvidence(f.run, 'v02'), /hashes are stale for v01/);
  await writeFile(oldPath, before);
  const currentAudit = join(f.run, 'v02', 'crop-audit.json');
  await appendFile(currentAudit, ' ');
  await assert.rejects(ensureIconEvidence(f.run, 'v02'), /stale input hashes/);
  const sourcePath = join(f.run, 'source.png');
  await appendFile(sourcePath, ' ');
  await assert.rejects(loadIconEvidence(f.run, 'v02'), /source hash changed/);
}));

test('reloading recomputes risk metadata and refuses a removed warning or falsified fingerprint', async () => fixture(async f => {
  await f.render('v01', [40, 42, 110, 100]);
  const report = await ensureIconEvidence(f.run, 'v01');
  const path = join(report.directory, 'manifest.json'), original = await readFile(path);
  const edited = JSON.parse(original);
  assert.ok(edited.items[0].warnings.some(row => row.id === 'edge-touch-top'));
  edited.items[0].warnings = [];
  await writeFile(path, json(edited));
  await assert.rejects(loadIconEvidence(f.run, 'v01'), /warnings changed/);
  edited.items[0].warnings = JSON.parse(original).items[0].warnings;
  edited.items[0].contentFingerprint = '0'.repeat(64);
  await writeFile(path, json(edited));
  await assert.rejects(loadIconEvidence(f.run, 'v01'), /contentFingerprint changed/);
}));

test('tall icons remain at 1x with separately preserved edge evidence, never shrink to fit a table', async () => fixture(async f => {
  await f.render('v01', [100, 100, 190, 1170]);
  const report = await ensureIconEvidence(f.run, 'v01'), item = report.items[0];
  assert.equal(item.scale, 1);
  assert.equal(item.comparison.layout.panelHeight, item.contextBox[3] - item.contextBox[1]);
  assert.ok(item.comparison.layout.panelHeight > 1000);
  const raw = await pixels(item.comparison.path);
  assert.deepEqual(rgbAt(raw, ...inPanel(item, 0, 105, 1100)), [21, 102, 192]);
  assert.equal(item.edges.find(edge => edge.side === 'left').scale, 1);
  assert.ok((await sharp(item.edges.find(edge => edge.side === 'left').path).metadata()).height > 1000);
}, true));

test('source-edge warnings are explicit and unchanged local pixels have reusable fingerprints', async () => fixture(async f => {
  await f.render('v01', [0, 30, 110, 100]);
  const first = await ensureIconEvidence(f.run, 'v01');
  assert.ok(first.items[0].warnings.some(row => row.id === 'source-boundary-left'));
  await f.render('v02', [0, 30, 110, 100]);
  const second = await ensureIconEvidence(f.run, 'v02');
  await f.render('v03', [0, 30, 110, 100], [{ id: 'far-away', type: 'rect', x: 180, y: 145, width: 5, height: 5, fill: '#000000' }]);
  const third = await ensureIconEvidence(f.run, 'v03');
  // A preceding version existing alone does not invalidate identical evidence.
  assert.equal(first.items[0].contentFingerprint, second.items[0].contentFingerprint);
  assert.equal(second.items[0].contentFingerprint, third.items[0].contentFingerprint);
  assert.notEqual(second.previewSha256, third.previewSha256);
}));
