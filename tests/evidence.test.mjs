import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { initializeRun, renderProposal, preflightProposal } from '../tools/render.mjs';
import { freezeInventory, measureSource, assertEvidenceReady, reviewVersion, finalizeVersion } from '../src/evidence.mjs';

async function fixture(fn, required = true) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-evidence-test-'));
  try {
    const input = join(directory, 'input.png'), run = join(directory, 'run');
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="white"/><rect x="10" y="10" width="30" height="20" fill="black"/><text x="10" y="70" font-family="Arial" font-size="18">Hello World</text><rect x="105" y="95" width="30" height="30" fill="red"/></svg>')).png().toFile(input);
    const manifest = await initializeRun(input, run, { evidenceRequired: required });
    const write = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value)); return path; };
    await mkdir(join(run, 'evidence'));
    const ocr = { schemaVersion: 1, sourceSha256: manifest.sourceSha256, width: 200, height: 160, engine: 'explicit synthetic test fixture', candidates: [{ id: 'ocr-001', text: 'Hello World', confidence: 1, bbox: [10, 50, 120, 72] }] };
    await writeFile(join(run, 'evidence', 'ocr-source.json'), JSON.stringify(ocr));
    const inventory = { texts: [{ id: 'greeting', text: 'Hello World', bbox: [10, 50, 120, 72] }], objects: [{ id: 'icon', kind: 'chart', bbox: [100, 90, 140, 130] }],
      ocrEvidence: 'evidence/ocr-source.json', ocrDecisions: [{ candidateId: 'ocr-001', status: 'accepted', inventoryIds: ['greeting'] }] };
    const scene = { width: 200, height: 160, elements: [{ id: 'greetingText', type: 'text', x: 10, y: 70, text: 'Hello World', fontSize: 18 }, { id: 'iconImage', type: 'image', kind: 'chart', bbox_px: [100, 90, 140, 130], reason: 'Test source chart crop.' }] };
    const freeze = async value => freezeInventory(run, await write('inventory.json', value ?? inventory));
    const measure = async (label, spec) => measureSource(run, await write(`${label}.json`, spec), label);
    const twoMeasurements = async () => {
      await measure('black', { roi: [0, 0, 50, 40], mode: 'dark', purpose: 'Measure black rectangle boundaries', threshold: 100 });
      await measure('red', { roi: [95, 85, 145, 135], mode: 'color', color: '#ff0000', tolerance: 1, purpose: 'Measure red chart foreground bounds' });
    };
    await fn({ directory, run, manifest, inventory, scene, ocr, write, freeze, measure, twoMeasurements });
  } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-evidence-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}

test('required-evidence render gate blocks missing inventory and insufficient measurements before attempt consumption', async () => fixture(async f => {
  const proposal = await f.write('proposal.json', f.scene);
  await assert.rejects(renderProposal(f.run, proposal, 'v01'), /frozen source inventory/);
  await f.freeze();
  await assert.rejects(renderProposal(f.run, proposal, 'v01'), /at least 2/);
  await f.measure('one', { roi: [0, 0, 50, 40], mode: 'dark', purpose: 'bounds' });
  await assert.rejects(renderProposal(f.run, proposal, 'v01'), /found 1/);
  const log = (await readFile(join(f.run, 'render-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.filter(row => row.event === 'attempt').length, 0);
  assert.equal(log.filter(row => row.event === 'evidence_refusal').length, 3);
}));

test('pixel measurement produces actual source bounds, boundary contacts and source-bound images; blank masks fail', async () => fixture(async f => {
  const measured = await f.measure('bounds', { roi: [0, 0, 50, 40], mode: 'dark', threshold: 100, purpose: 'Black bounds' });
  assert.deepEqual(measured.foregroundBbox, [10, 10, 40, 30]);
  assert.equal(measured.matchingPixelCount, 600);
  assert.equal(measured.foregroundTouchesRoi, false);
  assert.equal((await sharp(measured.roi).metadata()).width, 50);
  const touching = await f.measure('touch', { roi: [10, 10, 50, 40], mode: 'dark', threshold: 100, purpose: 'Check clipped left/top boundaries' });
  assert.equal(touching.edgeCounts.left, 20); assert.equal(touching.edgeCounts.top, 30);
  assert.equal(touching.foregroundTouchesRoi, true);
  await assert.rejects(f.measure('blank', { roi: [150, 130, 195, 155], mode: 'dark', purpose: 'Blank area' }), /both matching and nonmatching/);
  await assert.rejects(f.measure('uniform', { roi: [10, 10, 40, 30], mode: 'dark', purpose: 'Uniform black mask' }), /both matching and nonmatching/);
}));

test('changing only a measurement purpose does not satisfy the two-measurement gate', async () => fixture(async f => {
  await f.freeze();
  const spec = { roi: [0, 0, 50, 40], mode: 'dark', threshold: 100, purpose: 'First bound measurement' };
  await f.measure('first', spec);
  await f.measure('renamed', { ...spec, purpose: 'Same pixels with a new purpose label' });
  await assert.rejects(assertEvidenceReady(f.run), /found 1/);
}));

test('frozen inventory covers OCR decisions and rejects changed source, inventory, OCR or measured pixels', async () => fixture(async f => {
  await assert.rejects(f.freeze({ ...f.inventory, ocrDecisions: [] }), /lack decisions/);
  await assert.rejects(f.freeze({ ...f.inventory, ocrDecisions: [{ candidateId: 'ocr-001', status: 'rejected', inventoryIds: [] }] }), /nonempty text/);
  await assert.rejects(f.freeze({ ...f.inventory, texts: [{ ...f.inventory.texts[0], text: 'Hello' }] }), /does not match its inventory text/);
  await assert.rejects(f.freeze({ ...f.inventory, ocrDecisions: [{ candidateId: 'ocr-001', status: 'corrected', inventoryIds: ['greeting'] }] }), /nonempty text/);
  await f.freeze(); await f.twoMeasurements();
  assert.equal((await assertEvidenceReady(f.run)).distinctMeasurements, 2);
  await assert.rejects(f.freeze(), /EEXIST/);
  const ocrPath = join(f.run, 'evidence', 'ocr-source.json'), original = await readFile(ocrPath);
  await writeFile(ocrPath, JSON.stringify({ ...f.ocr, engine: 'changed fixture' }));
  await assert.rejects(assertEvidenceReady(f.run), /Frozen OCR evidence.*changed/);
  await writeFile(ocrPath, original);
  await writeFile(join(f.run, 'evidence', 'measurements', 'black', 'roi.png'), 'tampered');
  await assert.rejects(assertEvidenceReady(f.run), /Measurement images changed/);
}));

test('crop review detects a cut through solid foreground even without a color change across the cut', async () => fixture(async f => {
  await f.freeze(); await f.twoMeasurements();
  const clipped = structuredClone(f.scene); clipped.elements[1].bbox_px = [100, 90, 120, 130];
  const render = await renderProposal(f.run, await f.write('proposal.json', clipped), 'v01');
  const review = { mappings: [{ inventoryId: 'greeting', elementIds: ['greetingText'] }, { inventoryId: 'icon', elementIds: ['iconImage'] }], cropReviews: [{ id: 'iconImage', status: 'issue', note: 'The right half of the red fixture is clipped.' }], visualReview: { viewedPreviewSha256: render.previewSha256, notes: 'Synthetic cropped fixture.' } };
  const result = await reviewVersion(f.run, 'v01', await f.write('review.json', review), 'clipped');
  assert.equal(result.cropChecks[0].sourceBoundaryColorChangeCounts.right, 0);
  assert.equal(result.cropChecks[0].sourceBoundaryForegroundCounts.right, 30);
  assert.ok(result.cropChecks[0].warnings.some(text => text.includes('Nonbackground')));
}));

test('required mode requires OCR while legacy inventory is accepted without OCR', async () => {
  await fixture(async f => { const { ocrEvidence, ocrDecisions, ...plain } = f.inventory; await assert.rejects(f.freeze(plain), /must reference ocrEvidence/); });
  await fixture(async f => { const { ocrEvidence, ocrDecisions, ...plain } = f.inventory; const result = await f.freeze(plain); assert.equal(result.ocr, null); }, false);
});

test('read-only preflight catches path/schema/duplicate failures without spending attempts', async () => fixture(async f => {
  await f.freeze(); await f.twoMeasurements();
  const proposal = await f.write('proposal.json', f.scene), before = await readFile(join(f.run, 'render-events.jsonl'), 'utf8');
  await assert.rejects(preflightProposal(f.run, join(f.directory, 'absent.json'), 'v01'), /ENOENT/);
  const invalid = await f.write('invalid.json', { ...f.scene, width: 99 });
  await assert.rejects(preflightProposal(f.run, invalid, 'v01'), /dimensions must match/);
  const okay = await preflightProposal(f.run, proposal, 'v01');
  assert.equal(okay.remainingAttempts, 3);
  assert.equal(await readFile(join(f.run, 'render-events.jsonl'), 'utf8'), before);
  await renderProposal(f.run, proposal, 'v01');
  await assert.rejects(preflightProposal(f.run, proposal, 'v01'), /already exists/);
  assert.equal((await preflightProposal(f.run, proposal, 'v02')).remainingAttempts, 2);
  await assert.rejects(f.freeze(), /before the first render/);
}));

test('review detects missing and changed text and missing crop reviews rather than claiming quality', async () => fixture(async f => {
  await f.freeze(); await f.twoMeasurements();
  const changed = structuredClone(f.scene); changed.elements[0].text = 'Hello';
  const render = await renderProposal(f.run, await f.write('proposal.json', changed), 'v01');
  const review = { mappings: [{ inventoryId: 'greeting', elementIds: ['greetingText'] }, { inventoryId: 'icon', elementIds: ['iconImage'] }], cropReviews: [], visualReview: { viewedPreviewSha256: render.previewSha256, notes: 'Synthetic test review; not human validation.' } };
  const report = await reviewVersion(f.run, 'v01', await f.write('review.json', review), 'first');
  assert.deepEqual(report.mismatchedTexts, ['greeting']); assert.deepEqual(report.missingCropReviews, ['iconImage']);
  assert.equal(report.status, 'incomplete'); assert.equal(report.acceptance, 'pending');
  assert.equal((await sharp(report.cropContactSheet).metadata()).width, 660);
  const missing = { ...review, mappings: [] };
  const missingReport = await reviewVersion(f.run, 'v01', await f.write('missing.json', missing), 'missing');
  assert.deepEqual(missingReport.missingTexts, ['greeting']); assert.equal(missingReport.extraTexts[0].id, 'greetingText');
  const final = await finalizeVersion(f.run, 'v01', 'first');
  assert.equal(final.status, 'incomplete'); assert.equal(final.qualityStatus, 'not_independently_verified');
}));

test('review/finalize binds actual preview, scene and crop contact sheet hashes', async () => fixture(async f => {
  await f.freeze(); await f.twoMeasurements();
  const render = await renderProposal(f.run, await f.write('proposal.json', f.scene), 'v01');
  const review = { mappings: [{ inventoryId: 'greeting', elementIds: ['greetingText'] }, { inventoryId: 'icon', elementIds: ['iconImage'] }], cropReviews: [{ id: 'iconImage', status: 'accepted', note: 'Full red fixture rectangle and white margin are present.' }], visualReview: { viewedPreviewSha256: 'stale', notes: 'Checked fixture' } };
  await assert.rejects(reviewVersion(f.run, 'v01', await f.write('stale.json', review), 'stale'), /missing or stale/);
  review.visualReview.viewedPreviewSha256 = render.previewSha256;
  const result = await reviewVersion(f.run, 'v01', await f.write('review.json', review), 'reviewed');
  assert.deepEqual(result.missingTexts, []); assert.deepEqual(result.mismatchedTexts, []); assert.deepEqual(result.missingCropReviews, []);
  assert.equal(result.status, 'complete_with_issues'); // chart skip warning is retained, even when agent accepts it.
  const preview = await readFile(render.preview); await writeFile(render.preview, 'changed');
  await assert.rejects(finalizeVersion(f.run, 'v01', 'reviewed'), /artifacts or source changed/);
  await writeFile(render.preview, preview);
  const final = await finalizeVersion(f.run, 'v01', 'reviewed');
  assert.equal(final.acceptance, 'pending');
  await assert.rejects(finalizeVersion(f.run, 'v01', 'reviewed'), /EEXIST/);
}));

for (const sample of [
  { name: 'zero opacity even with painted stroke', style: { opacity: 0, fill: '#000000', stroke: '#ff0000', strokeWidth: 1 }, invisible: true },
  { name: 'none fill and absent stroke', style: { fill: 'none' }, invisible: true },
  { name: 'zero-alpha fill and stroke', style: { fill: '#12345600', stroke: '#abcdef00', strokeWidth: 2 }, invisible: true },
  { name: 'zero-alpha fill without stroke', style: { fill: '#00000000' }, invisible: true },
  { name: 'none fill and zero-width stroke', style: { fill: 'none', stroke: '#123456', strokeWidth: 0 }, invisible: true },
  { name: 'transparent fill with visible shorthand stroke', style: { fill: '#00000000', stroke: '#123', strokeWidth: 1 }, invisible: false },
  { name: 'none fill with visible eight-digit stroke', style: { fill: 'none', stroke: '#123456ff', strokeWidth: 1 }, invisible: false },
  { name: 'visible six-digit fill without stroke', style: { fill: '#123456', stroke: 'none' }, invisible: false },
  { name: 'visible shorthand fill without stroke', style: { fill: '#123', stroke: 'none' }, invisible: false },
]) {
  test(`text mapping visibility: ${sample.name}`, async () => fixture(async f => {
    await f.freeze(); await f.twoMeasurements();
    const scene = structuredClone(f.scene); Object.assign(scene.elements[0], sample.style);
    const render = await renderProposal(f.run, await f.write('proposal.json', scene), 'v01');
    const review = { mappings: [{ inventoryId: 'greeting', elementIds: ['greetingText'] }, { inventoryId: 'icon', elementIds: ['iconImage'] }], cropReviews: [{ id: 'iconImage', status: 'accepted', note: 'Fixture crop present.' }], visualReview: { viewedPreviewSha256: render.previewSha256, notes: 'Synthetic visibility fixture, actual PNG checked by pixels.' } };
    const report = await reviewVersion(f.run, 'v01', await f.write('review.json', review), 'visibility');
    assert.equal(report.textChecks[0].status, sample.invisible ? 'invisible' : 'matched');
    assert.equal(report.invisibleTexts.length, sample.invisible ? 1 : 0);
    const raw = await sharp(render.preview).extract({ left: 0, top: 45, width: 150, height: 32 }).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer();
    const inkChannels = [...raw].filter(value => value < 250).length;
    if (sample.invisible) {
      assert.equal(inkChannels, 0); assert.equal(report.status, 'incomplete');
      assert.deepEqual(report.textChecks[0].invisibleElementIds, ['greetingText']);
      assert.deepEqual(report.invisibleTexts[0].inventoryIds, ['greeting']);
      const final = await finalizeVersion(f.run, 'v01', 'visibility');
      assert.equal(final.invisibleTexts[0].id, 'greetingText'); assert.equal(final.status, 'incomplete');
    } else { assert.ok(inkChannels > 10, 'Visible text must actually paint glyph pixels'); }
  }));
}

test('extra invisible text is explicitly reported and cannot increase matched text coverage', async () => fixture(async f => {
  await f.freeze(); await f.twoMeasurements();
  const scene = structuredClone(f.scene);
  scene.elements.push({ id: 'hiddenExtra', type: 'text', x: 10, y: 85, text: 'Fake OCR token', fontSize: 10, opacity: 0 });
  scene.elements.push({ id: 'emptyDisplay', type: 'text', x: 10, y: 85, text: ' \u200b ', fontSize: 10 });
  const render = await renderProposal(f.run, await f.write('proposal.json', scene), 'v01');
  const review = { mappings: [{ inventoryId: 'greeting', elementIds: ['greetingText'] }, { inventoryId: 'icon', elementIds: ['iconImage'] }], cropReviews: [{ id: 'iconImage', status: 'accepted', note: 'Fixture crop present.' }], visualReview: { viewedPreviewSha256: render.previewSha256, notes: 'Synthetic extra invisible text fixture.' } };
  const report = await reviewVersion(f.run, 'v01', await f.write('review.json', review), 'extra');
  assert.equal(report.textChecks.filter(row => row.status === 'matched').length, 1);
  assert.deepEqual(report.invisibleTexts.map(row => row.id), ['hiddenExtra', 'emptyDisplay']);
  assert.deepEqual(report.extraTexts[0].invisibleReasons, ['zero-opacity']);
  assert.deepEqual(report.extraTexts[1].invisibleReasons, ['no-visible-text-characters']);
  assert.equal(report.status, 'complete_with_issues');
}));
