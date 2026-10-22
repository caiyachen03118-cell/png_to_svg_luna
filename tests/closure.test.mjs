import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { initializeRun, renderProposal } from '../tools/render.mjs';
import { freezeInventory, measureSource, reviewVersion, finalizeVersion, registerVersionIssues, resolveVersionIssues, amendInventory, planIssueClosure, applyIssueClosure } from '../src/evidence.mjs';

async function fixture(fn, withIcon = false) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-closure-test-'));
  try {
    const input = join(directory, 'input.png'), run = join(directory, 'run');
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="white"/><rect x="10" y="10" width="30" height="20" fill="black"/><text x="10" y="70" font-family="Arial" font-size="18">Hello World</text><rect x="105" y="95" width="30" height="30" fill="red"/></svg>')).png().toFile(input);
    const manifest = await initializeRun(input, run, { repairRequired: true, reviewProtocol: 'legacy' });
    const write = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value)); return path; };
    await mkdir(join(run, 'evidence'));
    const ocr = { sourceSha256: manifest.sourceSha256, width: 200, height: 160, candidates: [{ id: 'ocr-1', text: 'Hello World', bbox: [10, 50, 130, 76] }] };
    await writeFile(join(run, 'evidence', 'ocr-source.json'), JSON.stringify(ocr));
    const inventory = { texts: [{ id: 'greeting', text: 'Hello World', bbox: [10, 50, 130, 76] }], objects: [],
      icons: withIcon ? [{ id: 'red-icon', bbox: [105, 95, 135, 125], representation: 'vector', description: 'Red square icon.' }] : [], connectors: [],
      structureCoverage: { icons: withIcon ? 'listed' : 'none', connectors: 'none', note: 'Synthetic fixture coverage, independently known.' },
      ocrEvidence: 'evidence/ocr-source.json', ocrDecisions: [{ candidateId: 'ocr-1', status: 'accepted', inventoryIds: ['greeting'] }] };
    await freezeInventory(run, await write('inventory.json', inventory));
    await measureSource(run, await write('black.json', { roi: [0, 0, 50, 40], mode: 'dark', purpose: 'Black bounds' }), 'black');
    await measureSource(run, await write('red.json', { roi: [95, 85, 145, 135], mode: 'color', color: '#ff0000', tolerance: 1, purpose: 'Red bounds' }), 'red');
    const scene = { width: 200, height: 160, elements: [
      { id: 'greetingText', type: 'text', x: 15, y: 70, text: 'Hello World', fontSize: 18, fontFamily: 'Arial' },
      { id: 'redSquare', type: 'rect', x: 105, y: 95, width: 30, height: 30, fill: '#ff0000', stroke: 'none' }] };
    const render = async (version, value = scene) => renderProposal(run, await write(`${version}-proposal.json`, value), version);
    const reviewInput = rendered => ({ mappings: [{ inventoryId: 'greeting', elementIds: ['greetingText'] }], cropReviews: [],
      iconChecks: withIcon ? [{ inventoryId: 'red-icon', elementIds: ['redSquare'], status: 'accepted', visualMatch: true, note: 'Red square has full bounds.' }] : [], connectorChecks: [],
      visualReview: { viewedPreviewSha256: rendered.previewSha256, notes: 'Synthetic source and preview checked.' } });
    const review = async (version, rendered, label = version, transform = x => x) => reviewVersion(run, version, await write(`${label}-review.json`, transform(reviewInput(rendered))), label);
    await fn({ directory, run, manifest, inventory, scene, write, render, review, reviewInput });
  } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-closure-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}

test('closed-loop issue requires relevant changed pixels, later render, new review and viewed source/old/new patch before finalization', async () => fixture(async f => {
  const v1 = await f.render('v01'); await f.review('v01', v1);
  const payload = { reviewer: 'independent', issues: [{ id: 'text-offset', kind: 'layout', inventoryId: 'greeting', elementIds: ['greetingText'], roi: [5, 45, 135, 78], description: 'Text baseline x is five pixels too far right.', severity: 'minor' }] };
  await registerVersionIssues(f.run, 'v01', await f.write('issues.json', payload), 'critic');
  await assert.rejects(registerVersionIssues(f.run, 'v01', await f.write('duplicate.json', payload), 'duplicate'), /Duplicate issue ID/);
  await assert.rejects(finalizeVersion(f.run, 'v01', 'v01'), /Open issues/);
  const resolution = { resolutions: [{ issueId: 'text-offset', fixDescription: 'Move text left by five pixels.', reviewLabel: 'v01' }] };
  await assert.rejects(resolveVersionIssues(f.run, 'v01', await f.write('same.json', resolution), 'same'), /later rendered version/);
  const unrelated = structuredClone(f.scene); unrelated.elements[1].fill = '#ff1100';
  const v2 = await f.render('v02', unrelated); await f.review('v02', v2);
  resolution.resolutions[0].reviewLabel = 'v02';
  await assert.rejects(resolveVersionIssues(f.run, 'v02', await f.write('unrelated.json', resolution), 'unrelated'), /no actual pixel change/);
  const fixed = structuredClone(unrelated); fixed.elements[0].x = 10;
  const v3 = await f.render('v03', fixed);
  resolution.resolutions[0].reviewLabel = 'v03';
  await assert.rejects(resolveVersionIssues(f.run, 'v03', await f.write('unreviewed.json', resolution), 'unreviewed'), /ENOENT/);
  await assert.rejects(f.review('v03', v3, 'stale', row => ({ ...row, visualReview: { ...row.visualReview, viewedPreviewSha256: v1.previewSha256 } })), /missing or stale/);
  await f.review('v03', v3);
  const prepared = await resolveVersionIssues(f.run, 'v03', await f.write('resolve.json', resolution), 'repair');
  assert.equal(prepared.status, 'pending_visual_review'); assert.equal((await sharp(prepared.patches[0].path).metadata()).width, 960);
  await assert.rejects(finalizeVersion(f.run, 'v03', 'v03'), /Open issues/);
  resolution.resolutions[0].viewedPatchSha256 = 'stale';
  await assert.rejects(resolveVersionIssues(f.run, 'v03', await f.write('wrong.json', resolution), 'repair'), /missing or stale/);
  resolution.resolutions[0].viewedPatchSha256 = prepared.patches[0].sha256;
  const closed = await resolveVersionIssues(f.run, 'v03', await f.write('resolve.json', resolution), 'repair');
  assert.equal(closed.ledger.openIssues.length, 0); assert.ok(closed.resolutions[0].changedPixels > 0);
  assert.equal((await finalizeVersion(f.run, 'v03', 'v03')).status, 'complete');
}));

test('automatic missing text issues persist across an accepted later review and require explicit closure', async () => fixture(async f => {
  const bad = structuredClone(f.scene); bad.elements[0].text = 'Hello';
  const first = await f.render('v01', bad); const report = await f.review('v01', first);
  assert.deepEqual(report.mismatchedTexts, ['greeting']);
  const ledger = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json')));
  assert.equal(ledger.openIssues.length, 1);
  const fixed = await f.render('v02'); await f.review('v02', fixed);
  await assert.rejects(finalizeVersion(f.run, 'v02', 'v02'), /Open issues/);
  const resolutions = { resolutions: [{ issueId: ledger.openIssues[0].id, fixDescription: 'Restore full source text.', reviewLabel: 'v02' }] };
  const prepared = await resolveVersionIssues(f.run, 'v02', await f.write('res.json', resolutions), 'text-fixed');
  resolutions.resolutions[0].viewedPatchSha256 = prepared.patches[0].sha256;
  await resolveVersionIssues(f.run, 'v02', await f.write('res.json', resolutions), 'text-fixed');
  assert.equal((await finalizeVersion(f.run, 'v02', 'v02')).status, 'complete');
}));

test('pending structure checks block finalize without inventing a defect; missing icon cannot be removed via amendment', async () => fixture(async f => {
  const first = await f.render('v01');
  const pending = await f.review('v01', first, 'pending', row => ({ ...row, iconChecks: [{ inventoryId: 'red-icon', elementIds: ['redSquare'], status: 'pending', note: 'Inspect generated contact sheet.' }] }));
  assert.equal(pending.status, 'incomplete'); assert.ok(pending.structureContactSheets.length);
  assert.equal(JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json'))).openIssues.length, 0);
  await assert.rejects(finalizeVersion(f.run, 'v01', 'pending'), /missing checks/);
  await f.review('v01', first, 'missing', row => ({ ...row, iconChecks: [{ inventoryId: 'red-icon', elementIds: [], status: 'issue', note: 'Icon is not represented in the mapping.' }] }));
  const changed = structuredClone(f.inventory); changed.icons = []; changed.structureCoverage.icons = 'none';
  await assert.rejects(amendInventory(f.run, await f.write('amend.json', { inventory: changed, reason: 'Try deletion.', reviewer: 'independent', evidenceNote: 'Synthetic rejection test.' }), 'delete'), /Cannot remove icons/);
  await f.review('v01', first, 'accepted');
  await assert.rejects(finalizeVersion(f.run, 'v01', 'accepted'), /Open issues/);
}, true));

test('append-only inventory amendment preserves original and makes old review stale without closing issues', async () => fixture(async f => {
  const first = await f.render('v01'); await f.review('v01', first);
  const original = await readFile(join(f.run, 'evidence', 'inventory.json'));
  const next = structuredClone(f.inventory); next.texts[0].bbox = [8, 48, 132, 78];
  const result = await amendInventory(f.run, await f.write('amend.json', { inventory: next, reason: 'Include source antialias fringe.', reviewer: 'independent', evidenceNote: 'Inspected source label bounds.' }), 'bounds');
  assert.notEqual(result.inventorySha256, result.previousInventorySha256);
  assert.deepEqual(await readFile(join(f.run, 'evidence', 'inventory.json')), original);
  await assert.rejects(finalizeVersion(f.run, 'v01', 'v01'), /does not match/);
  await f.review('v01', first, 'amended-review');
  assert.equal((await finalizeVersion(f.run, 'v01', 'amended-review')).status, 'complete');
}));

test('independent source-inventory correction can close only an automatic mismatch after a fresh review and patch check', async () => fixture(async f => {
  const wrong = structuredClone(f.inventory); wrong.texts[0].text = 'Hello';
  wrong.ocrDecisions = [{ candidateId: 'ocr-1', status: 'corrected', inventoryIds: ['greeting'], note: 'Deliberately incorrect source interpretation for this regression fixture.' }];
  await amendInventory(f.run, await f.write('wrong-inventory.json', { inventory: wrong, reviewer: 'independent', reason: 'Synthetic bad initial source interpretation.', evidenceNote: 'Test setup, not a real reviewer.' }), 'wrong');
  const first = await f.render('v01'); await f.review('v01', first, 'bad-inventory-review');
  const issue = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json'))).openIssues[0];
  const resolution = { resolutions: [{ issueId: issue.id, resolutionType: 'inventory-correction', fixDescription: 'Source really says Hello World; the rendered text was already right.', reviewLabel: 'corrected-source' }] };
  await assert.rejects(resolveVersionIssues(f.run, 'v01', await f.write('resolve-source.json', resolution), 'too-early'), /later independent/);
  await amendInventory(f.run, await f.write('good-inventory.json', { inventory: f.inventory, reviewer: 'independent', reason: 'Restore the actual source wording.', evidenceNote: 'Fixture source and OCR both contain Hello World.' }), 'corrected');
  await f.review('v01', first, 'corrected-source');
  const prepared = await resolveVersionIssues(f.run, 'v01', await f.write('resolve-source.json', resolution), 'source-fix');
  resolution.resolutions[0].viewedPatchSha256 = prepared.patches[0].sha256;
  const closed = await resolveVersionIssues(f.run, 'v01', await f.write('resolve-source.json', resolution), 'source-fix');
  assert.equal(closed.resolutions[0].changedPixels, 0); assert.equal(closed.resolutions[0].resolutionType, 'inventory-correction');
  assert.equal((await finalizeVersion(f.run, 'v01', 'corrected-source')).status, 'complete');
}));

test('Luna self-amendment requires hash-bound source context for every changed item and preserves the old inventory', async () => fixture(async f => {
  const original = await readFile(join(f.run, 'evidence', 'inventory.json'));
  const next = structuredClone(f.inventory); next.texts[0].bbox = [8, 48, 132, 78];
  const request = { inventory: next, reviewer: 'luna', reason: 'Recheck source label extent.', evidenceNote: 'Source context includes the complete source label.' };
  await assert.rejects(amendInventory(f.run, await f.write('self.json', request), 'no-evidence'), /sourceRecheck/);
  const measured = await measureSource(f.run, await f.write('label-measure.json', { roi: [5, 45, 140, 80], mode: 'dark', purpose: 'Recheck full source label with surroundings.' }), 'label-source');
  request.sourceRecheck = { viewedSourceSha256: f.manifest.sourceSha256, checks: [{ inventoryId: 'greeting', measurementLabel: 'label-source', viewedContextSha256: 'stale', note: 'The entire label and its padding were inspected.' }] };
  await assert.rejects(amendInventory(f.run, await f.write('self.json', request), 'stale-context'), /viewedContextSha256/);
  request.sourceRecheck.checks[0].measurementLabel = 'black';
  request.sourceRecheck.checks[0].viewedContextSha256 = JSON.parse(await readFile(join(f.run, 'evidence', 'measurements', 'black', 'measurement.json'))).contextSha256;
  await assert.rejects(amendInventory(f.run, await f.write('self.json', request), 'unrelated-context'), /must contain old and updated bounds/);
  request.sourceRecheck.checks[0].measurementLabel = 'label-source'; request.sourceRecheck.checks[0].viewedContextSha256 = measured.contextSha256;
  const result = await amendInventory(f.run, await f.write('self.json', request), 'self-rechecked');
  assert.equal(result.reviewer, 'luna'); assert.equal(result.sourceRecheck.checks[0].viewedContextSha256, measured.contextSha256);
  assert.deepEqual(await readFile(join(f.run, 'evidence', 'inventory.json')), original);
  const changed = structuredClone(next); changed.objects.push({ id: 'new-square', bbox: [105, 95, 135, 125], kind: 'square' });
  await assert.rejects(amendInventory(f.run, await f.write('missing-item.json', { ...request, inventory: changed }), 'missing-item'), /every changed inventory item: new-square/);
}));

test('evidenced Luna source correction still needs fresh review and patch acceptance and cannot bypass a real self-discovered defect', async () => fixture(async f => {
  const wrong = structuredClone(f.inventory); wrong.texts[0].text = 'Hello';
  wrong.ocrDecisions = [{ candidateId: 'ocr-1', status: 'corrected', inventoryIds: ['greeting'], note: 'Wrong source transcription in fixture.' }];
  await amendInventory(f.run, await f.write('wrong.json', { inventory: wrong, reviewer: 'independent', reason: 'Fixture setup.', evidenceNote: 'Intentionally incorrect annotation.' }), 'wrong');
  const first = await f.render('v01'); await f.review('v01', first, 'wrong-source');
  const issue = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json'))).openIssues[0];
  const measured = await measureSource(f.run, await f.write('label.json', { roi: [5, 45, 140, 80], mode: 'dark', purpose: 'Inspect source wording again.' }), 'self-source');
  await amendInventory(f.run, await f.write('self.json', { inventory: f.inventory, reviewer: 'luna', reason: 'Correct my source transcription.', evidenceNote: 'Full source says Hello World.', sourceRecheck: { viewedSourceSha256: f.manifest.sourceSha256, checks: [{ inventoryId: 'greeting', measurementLabel: 'self-source', viewedContextSha256: measured.contextSha256, note: 'Checked both words against source pixels.' }] } }), 'self-corrected');
  const request = { resolutions: [{ issueId: issue.id, resolutionType: 'inventory-correction', fixDescription: 'Rendering was right; source transcription was incomplete.', reviewLabel: 'wrong-source' }] };
  await assert.rejects(resolveVersionIssues(f.run, 'v01', await f.write('resolution.json', request), 'stale-review'), /does not match/);
  await f.review('v01', first, 'self-reviewed'); request.resolutions[0].reviewLabel = 'self-reviewed';
  const prepared = await resolveVersionIssues(f.run, 'v01', await f.write('resolution.json', request), 'self-fixed');
  await assert.rejects(finalizeVersion(f.run, 'v01', 'self-reviewed'), /Open issues/);
  request.resolutions[0].viewedPatchSha256 = prepared.patches[0].sha256;
  const result = await resolveVersionIssues(f.run, 'v01', await f.write('resolution.json', request), 'self-fixed');
  assert.equal(result.resolutions[0].changedPixels, 0); assert.equal(result.resolutions[0].inventoryCorrection.reviewer, 'luna');
  await registerVersionIssues(f.run, 'v01', await f.write('real.json', { reviewer: 'luna', issues: [{ id: 'real-offset', kind: 'layout', inventoryId: 'greeting', elementIds: ['greetingText'], roi: [5, 45, 135, 78], description: 'Self-review found a real five-pixel text offset.', severity: 'minor' }] }), 'self-defect');
  const bypass = { resolutions: [{ issueId: 'real-offset', resolutionType: 'inventory-correction', fixDescription: 'Cannot use annotation correction to waive visible defect.', reviewLabel: 'self-reviewed' }] };
  await assert.rejects(resolveVersionIssues(f.run, 'v01', await f.write('bypass.json', bypass), 'bypass'), /limited to automatically detected/);
  delete bypass.resolutions[0].resolutionType;
  await assert.rejects(resolveVersionIssues(f.run, 'v01', await f.write('bypass.json', bypass), 'same-render'), /later rendered version/);
}));

test('new critic issue invalidates a previous final snapshot and repaired later final preserves that snapshot', async () => fixture(async f => {
  const first = await f.render('v01'); await f.review('v01', first);
  const snapshot = await finalizeVersion(f.run, 'v01', 'v01');
  const oldBytes = await readFile(snapshot.report);
  await registerVersionIssues(f.run, 'v01', await f.write('late.json', { reviewer: 'independent', issues: [{ id: 'late-layout', kind: 'layout', inventoryId: 'greeting', elementIds: ['greetingText'], roi: [5, 45, 135, 78], description: 'Late critic identified text offset.', severity: 'minor' }] }), 'late');
  assert.equal(JSON.parse(await readFile(join(f.run, 'evidence', 'current-verification.json'))).status, 'invalidated_requires_finalization');
  assert.deepEqual(await readFile(snapshot.report), oldBytes);
  await assert.rejects(finalizeVersion(f.run, 'v01', 'v01'), /Open issues/);
  const fixed = structuredClone(f.scene); fixed.elements[0].x = 10;
  const second = await f.render('v02', fixed); await f.review('v02', second);
  const resolutions = { resolutions: [{ issueId: 'late-layout', fixDescription: 'Move to source baseline x.', reviewLabel: 'v02' }] };
  const patches = await resolveVersionIssues(f.run, 'v02', await f.write('late-resolve.json', resolutions), 'late-fixed');
  resolutions.resolutions[0].viewedPatchSha256 = patches.patches[0].sha256;
  await resolveVersionIssues(f.run, 'v02', await f.write('late-resolve.json', resolutions), 'late-fixed');
  await finalizeVersion(f.run, 'v02', 'v02');
  assert.equal(JSON.parse(await readFile(join(f.run, 'evidence', 'current-verification.json'))).status, 'finalized');
  assert.deepEqual(await readFile(snapshot.report), oldBytes);
}));

for (const reviewer of ['independent', 'luna']) test(`a source connector false positive needs explicit ${reviewer} retirement and reviewed evidence, never silent deletion`, async () => fixture(async f => {
  const wrong = structuredClone(f.inventory);
  wrong.connectors = [{ id: 'phantom-edge', from: [140, 30], to: [180, 30], heads: 'end', description: 'Synthetic mistaken connector annotation.' }];
  wrong.structureCoverage.connectors = 'listed';
  await amendInventory(f.run, await f.write('phantom.json', { inventory: wrong, reviewer: 'independent', reason: 'Fixture sets up a false source annotation.', evidenceNote: 'No actual line in fixture source.' }), 'phantom');
  const first = await f.render('v01');
  await f.review('v01', first, 'false-connector', row => ({ ...row, connectorChecks: [{ inventoryId: 'phantom-edge', lineIds: [], status: 'issue', note: 'Source contains no such arrow.' }] }));
  const issues = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json'))).openIssues;
  const amendment = { inventory: f.inventory, reviewer, reason: 'Original source rechecked; annotation was invented.', evidenceNote: 'Original source region 130,20,190,40 is blank.' };
  if (reviewer === 'luna') {
    const measured = await measureSource(f.run, await f.write('recheck.json', { roi: [0, 0, 195, 45], mode: 'dark', purpose: 'Inspect the claimed arrow region with surrounding source content.' }), 'retirement-source');
    amendment.sourceRecheck = { viewedSourceSha256: f.manifest.sourceSha256, checks: [{ inventoryId: 'phantom-edge', measurementLabel: 'retirement-source', viewedContextSha256: measured.contextSha256, note: 'No arrow appears inside its originally annotated source extent.' }] };
  }
  await assert.rejects(amendInventory(f.run, await f.write('remove.json', amendment), 'silent'), /retiredConnectorIds/);
  amendment.retiredConnectorIds = ['phantom-edge'];
  await assert.rejects(amendInventory(f.run, await f.write('remove.json', amendment), 'no-reason'), /retirementReason/);
  amendment.retirementReason = 'Remove explicitly documented nonexistent source arrow, not a difficult real connection.';
  await amendInventory(f.run, await f.write('remove.json', amendment), 'retired');
  await assert.rejects(finalizeVersion(f.run, 'v01', 'false-connector'), /does not match/);
  await f.review('v01', first, 'source-corrected');
  const request = { resolutions: issues.map(issue => ({ issueId: issue.id, resolutionType: 'inventory-correction', fixDescription: amendment.retirementReason, reviewLabel: 'source-corrected' })) };
  const prepared = await resolveVersionIssues(f.run, 'v01', await f.write('retire-resolve.json', request), 'retire-resolve');
  assert.equal(prepared.status, 'pending_visual_review');
  request.resolutions.forEach((row, i) => row.viewedPatchSha256 = prepared.patches[i].sha256);
  await resolveVersionIssues(f.run, 'v01', await f.write('retire-resolve.json', request), 'retire-resolve');
  assert.equal((await finalizeVersion(f.run, 'v01', 'source-corrected')).status, 'complete');
}));

test('a related manual issue may waive only already resolved retired targets and still requires its remaining targets to change', async () => fixture(async f => {
  const wrong = structuredClone(f.inventory);
  wrong.connectors = [{ id: 'phantom-edge', from: [140, 30], to: [180, 30], heads: 'start', description: 'Synthetic false source connector with a mismatched claimed head.' }];
  wrong.structureCoverage.connectors = 'listed';
  await amendInventory(f.run, await f.write('phantom-inventory.json', { inventory: wrong, reviewer: 'independent', reason: 'Create erroneous source annotation fixture.', evidenceNote: 'The source region is blank.' }), 'phantom');
  const initial = structuredClone(f.scene); initial.elements.push({ id: 'phantomArrow', type: 'line', x1: 140, y1: 30, x2: 180, y2: 30, stroke: '#000000', arrowEnd: true });
  const first = await f.render('v01', initial);
  await f.review('v01', first, 'first', row => ({ ...row, connectorChecks: [{ inventoryId: 'phantom-edge', lineIds: ['phantomArrow'], status: 'issue', note: 'Source has no such connector.' }] }));
  const automatic = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json'))).openIssues;
  await registerVersionIssues(f.run, 'v01', await f.write('manual.json', { reviewer: 'independent', issues: [{ id: 'teacher-size', kind: 'layout', elementIds: ['redSquare', 'phantomArrow'], roi: [95, 20, 190, 135], description: 'Resize the real target; original review also referenced a false connector.', severity: 'minor' }] }), 'teacher');
  await amendInventory(f.run, await f.write('retire.json', { inventory: f.inventory, reviewer: 'independent', reason: 'Source confirms the connector is a false positive.', evidenceNote: 'Blank source patch verified.', retiredConnectorIds: ['phantom-edge'], retirementReason: 'Retire only the explicitly identified nonexistent connector.' }), 'retired');
  await f.review('v01', first, 'amended');
  const second = await f.render('v02'); await f.review('v02', second, 'second');
  const teacher = { resolutions: [{ issueId: 'teacher-size', fixDescription: 'Resize the real target after retiring a false connector.', reviewLabel: 'second' }] };
  await assert.rejects(resolveVersionIssues(f.run, 'v02', await f.write('teacher-resolve.json', teacher), 'not-yet-retired'), /cannot be deleted/);
  const retire = { resolutions: automatic.map(issue => ({ issueId: issue.id, resolutionType: 'inventory-correction', fixDescription: 'Remove the explicitly retired false connector.', reviewLabel: 'second' })) };
  const retirementPatches = await resolveVersionIssues(f.run, 'v02', await f.write('retire-resolve.json', retire), 'retire-resolve');
  retire.resolutions.forEach((row, i) => row.viewedPatchSha256 = retirementPatches.patches[i].sha256);
  await resolveVersionIssues(f.run, 'v02', await f.write('retire-resolve.json', retire), 'retire-resolve');
  await assert.rejects(resolveVersionIssues(f.run, 'v02', await f.write('teacher-resolve.json', teacher), 'only-retired-removed'), /target elements did not change/);
  const deleted = structuredClone(f.scene); deleted.elements = deleted.elements.filter(row => row.id !== 'redSquare');
  const third = await f.render('v03', deleted); await f.review('v03', third, 'third'); teacher.resolutions[0].reviewLabel = 'third';
  await assert.rejects(resolveVersionIssues(f.run, 'v03', await f.write('teacher-resolve.json', teacher), 'real-target-deleted'), /cannot be deleted/);
  const fixed = structuredClone(f.scene); fixed.elements[1].width = 31;
  const fourth = await f.render('v04', fixed); await f.review('v04', fourth, 'fourth'); teacher.resolutions[0].reviewLabel = 'fourth';
  const prepared = await resolveVersionIssues(f.run, 'v04', await f.write('teacher-resolve.json', teacher), 'teacher-fixed');
  teacher.resolutions[0].viewedPatchSha256 = prepared.patches[0].sha256;
  const result = await resolveVersionIssues(f.run, 'v04', await f.write('teacher-resolve.json', teacher), 'teacher-fixed');
  assert.deepEqual(result.resolutions[0].waivedRetiredElementIds, ['phantomArrow']);
  assert.deepEqual(result.resolutions[0].targetElementIds, ['redSquare']);
  assert.equal(result.ledger.openIssues.length, 0);
}));

async function cropFixture(f, oldBox = [95, 85, 145, 135]) {
  const inventory = structuredClone(f.inventory); inventory.icons[0].representation = 'image';
  await amendInventory(f.run, await f.write('image-inventory.json', { inventory, reviewer: 'independent', reason: 'Fixture uses a source image crop.', evidenceNote: 'Known red square source bounds.' }), 'image');
  const scene = structuredClone(f.scene); scene.background = '#aaccff';
  scene.elements[1] = { id: 'redSquare', type: 'image', bbox_px: oldBox, kind: 'icon', reason: 'Source square including unwanted surrounding white pixels.' };
  const review = async (version, rendered, label = version) => f.review(version, rendered, label, row => ({ ...row,
    cropReviews: [{ id: 'redSquare', status: 'accepted', note: 'Fixture source crop compared against the original.' }] }));
  const first = await f.render('v01', scene); await review('v01', first);
  const issues = [{ id: 'crop-fringe', kind: 'crop', inventoryId: 'red-icon', elementIds: ['redSquare'], roi: [105, 95, 135, 125], description: 'Crop surrounds source icon with an unwanted white fringe.', severity: 'minor' },
    { id: 'icon-fringe', kind: 'icon', inventoryId: 'red-icon', elementIds: ['redSquare'], roi: [105, 95, 135, 125], description: 'Same object icon fringe diagnosis, separately auditable.', severity: 'minor' }];
  await registerVersionIssues(f.run, 'v01', await f.write('crop-issues.json', { reviewer: 'luna', issues }), 'crop-discovery');
  return { scene, review, issues };
}

test('crop closure preserves original ROI hashes, checks adopted-boundary changes outside it and groups duplicate evidence without auto-acceptance', async () => fixture(async f => {
  const crop = await cropFixture(f), scene = structuredClone(crop.scene); scene.elements[1].bbox_px = [101, 91, 139, 129];
  const rendered = await f.render('v02', scene); await crop.review('v02', rendered);
  const plan = await planIssueClosure(f.run, 'v02', 'fringe-plan');
  assert.equal(plan.readyCount, 2); assert.equal(plan.groups.length, 1); assert.equal(plan.groups[0].issueIds.length, 2);
  const body = JSON.parse(await readFile(plan.plan)); const row = body.rows[0].prepared;
  assert.deepEqual(row.roi, [105, 95, 135, 125]); assert.equal(row.originalRoiChangedPixels, 0);
  assert.ok(row.changedPixels > 0); assert.ok(row.targetBoundaryChangedPixels > 0);
  assert.deepEqual(row.reviewRoi, [87, 77, 153, 143]);
  const original = JSON.parse(await readFile(join(f.run, 'evidence', 'issues', 'crop-discovery', 'issues.json'))).issues[0];
  assert.equal(row.sourcePatchSha256, original.sourcePatchSha256); assert.equal(row.oldPatchSha256, original.discoveredPatchSha256);
  const template = JSON.parse(await readFile(plan.decisionsTemplate));
  assert.ok(template.decisions.every(decision => decision.status === 'pending' && !decision.viewedPatchSha256));
  const pending = await applyIssueClosure(f.run, 'v02', plan.decisionsTemplate, 'no-acceptance');
  assert.equal(pending.resolvedCount, 0); assert.equal(pending.ledger.openIssues.length, 2);
  const partial = { planLabel: 'fringe-plan', decisions: [{ issueId: 'crop-fringe', status: 'accepted', fixDescription: 'Remove only surrounding white fringe; preserve full red square.', viewedPatchSha256: plan.groups[0].sha256 }] };
  const applied = await applyIssueClosure(f.run, 'v02', await f.write('partial.json', partial), 'partial');
  assert.equal(applied.resolvedCount, 1); assert.equal(applied.ledger.openIssues.length, 1);
  await assert.rejects(finalizeVersion(f.run, 'v02', 'v02'), /Open issues/);
  partial.decisions.push({ ...partial.decisions[0], issueId: 'icon-fringe' });
  const rest = await applyIssueClosure(f.run, 'v02', await f.write('rest.json', partial), 'rest');
  assert.equal(rest.resolvedCount, 1); assert.equal(rest.outcomes[0].status, 'already_resolved');
  assert.equal((await finalizeVersion(f.run, 'v02', 'v02')).status, 'complete');
}, true));

test('crop expansion across the old boundary is reviewable, while no pixel change and unrelated context edits stay blocked', async () => fixture(async f => {
  const crop = await cropFixture(f, [105, 95, 135, 125]);
  const nonvisual = structuredClone(crop.scene); nonvisual.elements[1].reason = 'New note, unchanged crop pixels.';
  const same = await f.render('v02', nonvisual); await crop.review('v02', same);
  const noChange = await planIssueClosure(f.run, 'v02', 'no-change');
  assert.equal(noChange.readyCount, 0); assert.match(noChange.rows[0].blockedReason, /no actual pixel change/);
  const unrelated = structuredClone(crop.scene); unrelated.elements[1].reason = 'Changed only nonvisual reason.';
  unrelated.elements.push({ id: 'nearbyDot', type: 'rect', x: 100, y: 90, width: 3, height: 3, fill: '#000000' });
  const third = await f.render('v03', unrelated); await crop.review('v03', third);
  const unrelatedPlan = await planIssueClosure(f.run, 'v03', 'unrelated');
  assert.equal(unrelatedPlan.readyCount, 0); assert.match(unrelatedPlan.rows[0].blockedReason, /target elements did not change/);
  const expanded = structuredClone(crop.scene); expanded.elements[1].bbox_px = [101, 91, 139, 129];
  const fourth = await f.render('v04', expanded); await crop.review('v04', fourth);
  const plan = await planIssueClosure(f.run, 'v04', 'expanded');
  assert.equal(plan.readyCount, 2); assert.ok(JSON.parse(await readFile(plan.plan)).rows[0].prepared.targetBoundaryChangedPixels > 0);
}, true));

test('a mixed image/native mapping cannot use unrelated native changes to bypass crop boundary checks', async () => fixture(async f => {
  const crop = await cropFixture(f), scene = structuredClone(crop.scene);
  scene.elements.push({ id: 'nearbyDot', type: 'rect', x: 100, y: 90, width: 3, height: 3, fill: '#000000' });
  const second = await f.render('v02', scene);
  await f.review('v02', second, 'mixed', row => ({ ...row,
    cropReviews: [{ id: 'redSquare', status: 'accepted', note: 'Fixture declaration.' }],
    iconChecks: [{ inventoryId: 'red-icon', elementIds: ['redSquare', 'nearbyDot'], status: 'accepted', note: 'Fixture mixes a new unrelated element into the mapping.' }] }));
  const plan = await planIssueClosure(f.run, 'v02', 'mixed-plan');
  assert.equal(plan.readyCount, 0); assert.match(plan.rows[0].blockedReason, /no changed source pixels at the target crop boundary/);
}, true));

test('closure plan isolates blocked items and does not accept missing, stale or unconfirmed patch decisions', async () => fixture(async f => {
  const first = await f.render('v01'); await f.review('v01', first);
  await registerVersionIssues(f.run, 'v01', await f.write('two-issues.json', { reviewer: 'luna', issues: [
    { id: 'label-offset', kind: 'layout', inventoryId: 'greeting', elementIds: ['greetingText'], roi: [5, 45, 135, 78], description: 'Move label left five pixels.', severity: 'minor' },
    { id: 'square-size', kind: 'layout', elementIds: ['redSquare'], roi: [100, 90, 140, 130], description: 'Square needs another source check before it may close.', severity: 'minor' }] }), 'two');
  const fixed = structuredClone(f.scene); fixed.elements[0].x = 10;
  const second = await f.render('v02', fixed); await f.review('v02', second);
  const plan = await planIssueClosure(f.run, 'v02', 'mixed-ready');
  assert.equal(plan.readyCount, 1); assert.equal(plan.blockedCount, 1); assert.equal(plan.groups.length, 2);
  const request = { planLabel: 'mixed-ready', decisions: [{ issueId: 'label-offset', status: 'accepted', fixDescription: 'Moved label to source x.', viewedPatchSha256: 'wrong' }, { issueId: 'square-size', status: 'accepted', fixDescription: 'Unchanged is not repaired.' }] };
  const blocked = await applyIssueClosure(f.run, 'v02', await f.write('bad-decisions.json', request), 'blocked');
  assert.equal(blocked.resolvedCount, 0); assert.ok(blocked.outcomes.every(row => row.status === 'blocked'));
  request.decisions[0].viewedPatchSha256 = plan.groups.find(group => group.issueIds.includes('label-offset')).sha256;
  const result = await applyIssueClosure(f.run, 'v02', await f.write('good-partial.json', request), 'good-partial');
  assert.equal(result.resolvedCount, 1); assert.equal(result.ledger.openIssues[0].id, 'square-size');
  await assert.rejects(finalizeVersion(f.run, 'v02', 'v02'), /Open issues/);
}));

test('closure plans reject a newer review, a newer render, inventory changes and changed patch files', async () => fixture(async f => {
  const crop = await cropFixture(f), scene = structuredClone(crop.scene); scene.elements[1].bbox_px = [101, 91, 139, 129];
  const second = await f.render('v02', scene); await crop.review('v02', second);
  const plan = await planIssueClosure(f.run, 'v02', 'old-review');
  const request = { planLabel: 'old-review', decisions: [{ issueId: 'crop-fringe', status: 'accepted', fixDescription: 'Trim outer fringe.', viewedPatchSha256: plan.groups[0].sha256 }] };
  await crop.review('v02', second, 'new-review');
  await assert.rejects(applyIssueClosure(f.run, 'v02', await f.write('stale.json', request), 'stale-review'), /latest review/);
  const newer = await planIssueClosure(f.run, 'v02', 'new-review-plan'); request.planLabel = 'new-review-plan'; request.decisions[0].viewedPatchSha256 = newer.groups[0].sha256;
  const newerScene = structuredClone(scene); newerScene.elements[1].reason = 'New render with unchanged crop boundary.';
  const third = await f.render('v03', newerScene); await crop.review('v03', third);
  await assert.rejects(applyIssueClosure(f.run, 'v02', await f.write('stale.json', request), 'old-render'), /latest successful/);
  await assert.rejects(finalizeVersion(f.run, 'v02', 'new-review'), /latest successful rendered version/);
  const inventoryPlan = await planIssueClosure(f.run, 'v03', 'before-amend'); request.planLabel = 'before-amend'; request.decisions[0].viewedPatchSha256 = inventoryPlan.groups[0].sha256;
  const inventory = structuredClone(f.inventory); inventory.icons[0].representation = 'image'; inventory.icons[0].description = 'Newly documented original red square.';
  await amendInventory(f.run, await f.write('amend-again.json', { inventory, reviewer: 'independent', reason: 'Fixture changes annotation.', evidenceNote: 'Same geometry, new annotation.' }), 'updated');
  await assert.rejects(applyIssueClosure(f.run, 'v03', await f.write('stale.json', request), 'old-inventory'), /plan is stale/);
  await crop.review('v03', third, 'after-amend');
  const tampered = await planIssueClosure(f.run, 'v03', 'patch-test'); request.planLabel = 'patch-test'; request.decisions[0].viewedPatchSha256 = tampered.groups[0].sha256;
  await writeFile(tampered.groups[0].path, 'tampered');
  await assert.rejects(applyIssueClosure(f.run, 'v03', await f.write('stale.json', request), 'changed-patch'), /patch changed/);
}, true));

test('a previously oversized crop can be repaired without trapping its original immutable issue', async () => fixture(async f => {
  const crop = await cropFixture(f, [75, 65, 165, 155]), scene = structuredClone(crop.scene);
  scene.elements[1].bbox_px = [101, 91, 139, 129];
  const second = await f.render('v02', scene); await crop.review('v02', second);
  const plan = await planIssueClosure(f.run, 'v02', 'oversized-fixed');
  assert.ok(plan.rows.find(row => row.issueId === 'crop-fringe').status === 'ready_for_visual_review');
  const record = JSON.parse(await readFile(plan.plan)).rows.find(row => row.issueId === 'crop-fringe').prepared;
  assert.deepEqual(record.roi, [105, 95, 135, 125]); assert.deepEqual(record.reviewRoi, [67, 57, 173, 160]);
  assert.ok(record.targetBoundaryChangedPixels > 0);
}, true));
