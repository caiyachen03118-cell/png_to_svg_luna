import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { initializeRun, renderProposal } from '../tools/render.mjs';
import { freezeInventory, measureSource, reviewVersion, finalizeVersion, inspectObjectCropReview, resolveVersionIssues, registerVersionIssues } from '../src/evidence.mjs';
import { ensureIconEvidence } from '../src/icon-evidence.mjs';

const fakeItem = () => ({ id: 'image1', bbox: [10, 10, 40, 40], comparison: { sha256: 'pair' },
  edges: ['left', 'top', 'right', 'bottom'].map(side => ({ side, sha256: side, bbox: [10, 10, 40, 40] })),
  removedBands: [{ id: 'removed-top', sha256: 'band', bbox: [10, 10, 40, 12] }],
  warnings: [{ id: 'shrink-foreground-top', kind: 'shrink-foreground', bbox: [10, 10, 40, 12] },
    { id: 'render-difference', kind: 'render-difference', bbox: [15, 15, 35, 35] }] });
const accepted = (item, bundle) => ({
  id: item.id, status: 'accepted', note: 'Checked the red source object and the rendered boundary.',
  evidenceManifestSha256: bundle.manifestSha256, comparisonSha256: item.comparison.sha256,
  edgeObservations: item.edges.map(edge => ({ side: edge.side, sha256: edge.sha256,
    sourceObservation: `At the ${edge.side} side of ${item.id}, source red fill ends against the white margin.`,
    renderObservation: `The ${edge.side} edge of rendered ${item.id} preserves the same corner and white margin.` })),
  warningDecisions: item.warnings.map(warning => ({ warningId: warning.id, status: 'benign', bbox: warning.bbox,
    sourceObservation: `Source region ${warning.id} of ${item.id} contains an intended neighboring stroke beside the red area.`,
    renderObservation: `Rendered region ${warning.id} of ${item.id} retains that stroke and has no lost part of the red square.` })),
  removedBandDecisions: item.removedBands.map(band => ({ id: band.id, sha256: band.sha256, status: 'benign', bbox: band.bbox,
    sourceObservation: `Removed band ${band.id} on ${item.id} contains the neighboring rule and white background.`,
    renderObservation: `After removal of ${band.id} on ${item.id}, the red object remains below the rule with its full outline.` })),
});

test('strict accepted declaration alone cannot dismiss boundary warnings; missing and stale evidence stay incomplete', () => {
  const item = fakeItem(), bundle = { manifestSha256: 'manifest' };
  let check = inspectObjectCropReview(item, { id: item.id, status: 'accepted', note: '主体完整可见' }, bundle);
  assert.equal(check.status, 'incomplete'); assert.equal(check.declaredIssue, false);
  assert.ok(check.missing.includes('missing_or_stale_three_column_evidence'));
  const row = accepted(item, bundle); row.evidenceManifestSha256 = 'old-version';
  check = inspectObjectCropReview(item, row, bundle);
  assert.equal(check.acceptanceEligible, false); assert.ok(check.missing.includes('missing_or_stale_evidence_manifest'));
  row.evidenceManifestSha256 = bundle.manifestSha256; row.comparisonSha256 = 'old-preview';
  assert.equal(inspectObjectCropReview(item, row, bundle).acceptanceEligible, false);
});

test('strict decisions need per-warning localization, per-edge evidence and removed-band inspection', () => {
  const item = fakeItem(), bundle = { manifestSha256: 'manifest' }, row = accepted(item, bundle);
  assert.equal(inspectObjectCropReview(item, row, bundle).acceptanceEligible, true);
  row.warningDecisions[0].bbox = [12, 20, 20, 22];
  let check = inspectObjectCropReview(item, row, bundle);
  assert.ok(check.missing.some(value => value.includes('observation_bbox_outside_evidence')));
  row.warningDecisions[0].bbox = item.warnings[0].bbox;
  row.edgeObservations[2].sha256 = 'stale';
  assert.ok(inspectObjectCropReview(item, row, bundle).missing.some(value => value.includes('missing_or_stale_edge')));
  row.edgeObservations[2].sha256 = item.edges[2].sha256;
  row.removedBandDecisions = [];
  assert.ok(inspectObjectCropReview(item, row, bundle).missing.some(value => value.includes('removed-band')));
});

test('stock and repeated templates cannot replace specific observations, but correctly bound benign decisions are accepted', () => {
  const item = fakeItem(), bundle = { manifestSha256: 'manifest' }, row = accepted(item, bundle);
  row.warningDecisions.forEach(decision => Object.assign(decision, { sourceObservation: 'The source object has all of its parts intact.',
    renderObservation: 'The rendered object has all of its parts intact.' }));
  let check = inspectObjectCropReview(item, row, bundle);
  assert.equal(check.acceptanceEligible, false); assert.ok(check.missing.some(value => value.includes('repeated_warning_template')));
  const good = accepted(item, bundle);
  good.edgeObservations[0].sourceObservation = '主体完整可见';
  assert.equal(inspectObjectCropReview(item, good, bundle).acceptanceEligible, false);
  assert.equal(inspectObjectCropReview(item, accepted(item, bundle), bundle).status, 'accepted');
});

test('pending warning stays unresolved, and an explicit warning issue overrides the overall accepted label', () => {
  const item = fakeItem(), bundle = { manifestSha256: 'manifest' }, row = accepted(item, bundle);
  row.warningDecisions[0].status = 'pending';
  assert.equal(inspectObjectCropReview(item, row, bundle).status, 'incomplete');
  row.warningDecisions[0].status = 'issue';
  const checked = inspectObjectCropReview(item, row, bundle);
  assert.equal(checked.status, 'issue'); assert.equal(checked.declaredIssue, true); assert.equal(checked.acceptanceEligible, false);
});

async function fixture(fn, { legacy = false, twoImages = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-object-review-test-'));
  try {
    const input = join(directory, 'input.png'), run = join(directory, 'run');
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="white"/><rect x="10" y="10" width="30" height="20" fill="black"/><text x="10" y="70" font-family="Arial" font-size="18">Hello World</text><rect x="105" y="95" width="30" height="30" fill="red"/><rect x="170" y="95" width="30" height="30" fill="blue"/></svg>')).png().toFile(input);
    const manifest = await initializeRun(input, run, { repairRequired: true, ...(legacy ? { reviewProtocol: 'legacy' } : {}) });
    if (!legacy) assert.equal(manifest.reviewProtocol, 'object-review-v1');
    const write = async (name, value) => { const path = join(directory, name); await writeFile(path, JSON.stringify(value)); return path; };
    await mkdir(join(run, 'evidence'));
    await writeFile(join(run, 'evidence', 'ocr-source.json'), JSON.stringify({ sourceSha256: manifest.sourceSha256, width: 240, height: 180,
      candidates: [{ id: 'ocr-1', text: 'Hello World', bbox: [10, 50, 130, 76] }] }));
    const inventory = { texts: [{ id: 'greeting', text: 'Hello World', bbox: [10, 50, 130, 76] }], objects: [],
      icons: [{ id: 'red-icon', bbox: [105, 95, 135, 125], representation: 'image', description: 'Full red square.' },
        ...(twoImages ? [{ id: 'blue-icon', bbox: [170, 95, 200, 125], representation: 'image', description: 'Full blue square.' }] : [])], connectors: [],
      structureCoverage: { icons: 'listed', connectors: 'none', note: 'Synthetic fixed test inventory.' },
      ocrEvidence: 'evidence/ocr-source.json', ocrDecisions: [{ candidateId: 'ocr-1', status: 'accepted', inventoryIds: ['greeting'] }] };
    await freezeInventory(run, await write('inventory.json', inventory));
    await measureSource(run, await write('black.json', { roi: [0, 0, 50, 40], mode: 'dark', purpose: 'Black bounds' }), 'black');
    await measureSource(run, await write('red.json', { roi: [95, 85, 145, 135], mode: 'color', color: '#ff0000', tolerance: 1, purpose: 'Red bounds' }), 'red');
    const scene = { width: 240, height: 180, elements: [
      { id: 'greetingText', type: 'text', x: 10, y: 70, text: 'Hello World', fontSize: 18, fontFamily: 'Arial' },
      { id: 'redImage', type: 'image', kind: 'chart', bbox_px: [100, 90, 140, 130], reason: 'Synthetic crop test.' },
      ...(twoImages ? [{ id: 'blueImage', type: 'image', kind: 'chart', bbox_px: [165, 90, 205, 130], reason: 'Second synthetic crop test.' }] : [])] };
    const render = async (version, value = scene) => renderProposal(run, await write(`${version}-scene.json`, value), version);
    const inputReview = async (version, rendered) => {
      const bundle = legacy ? null : await ensureIconEvidence(run, version);
      return { mappings: [{ inventoryId: 'greeting', elementIds: ['greetingText'] }],
        cropReviews: bundle ? bundle.items.map(item => accepted(item, bundle)) : [{ id: 'redImage', status: 'accepted', note: 'Full red square and white margins.' }],
        iconChecks: inventory.icons.map(item => ({ inventoryId: item.id, elementIds: [item.id === 'red-icon' ? 'redImage' : 'blueImage'], status: 'accepted', note: 'Checked source red or blue square bounds.' })),
        connectorChecks: [], visualReview: { viewedPreviewSha256: rendered.previewSha256, notes: 'Synthetic deterministic test assertions, not semantic model validation.' } };
    };
    const review = async (version, rendered, label, change = row => row) => reviewVersion(run, version, await write(`${label}.json`, change(await inputReview(version, rendered))), label);
    await fn({ directory, run, manifest, inventory, scene, write, render, inputReview, review });
  } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-object-review-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}

test('strict low-level review cannot bypass object evidence; incomplete metadata neither closes nor invents an issue', async () => fixture(async f => {
  const v1 = await f.render('v01');
  const incomplete = await f.review('v01', v1, 'generic', row => ({ ...row,
    cropReviews: [{ id: 'redImage', status: 'accepted', note: '主体完整可见' }], mappings: [] }));
  assert.equal(incomplete.status, 'incomplete'); assert.equal(incomplete.cropContactSheet, null);
  assert.equal(incomplete.structureContactSheets.length, 0);
  assert.equal(JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json'))).openIssues.length, 0);
  await assert.rejects(finalizeVersion(f.run, 'v01', 'generic'), /missing checks/);
  const next = structuredClone(f.scene); next.elements[0].x = 11;
  const v2 = await f.render('v02', next);
  const valid = await f.review('v02', v2, 'specific');
  assert.equal(valid.status, 'complete'); assert.equal(valid.cropChecks[0].objectReview.acceptanceEligible, true);
  assert.equal((await finalizeVersion(f.run, 'v02', 'specific')).status, 'complete');
}));

test('pending warning decisions survive review without auto-closure or automatic defect registration', async () => fixture(async f => {
  const touching = structuredClone(f.scene); touching.elements[1].bbox_px = [105, 95, 135, 125];
  const v1 = await f.render('v01', touching);
  const report = await f.review('v01', v1, 'pending', row => {
    assert.ok(row.cropReviews[0].warningDecisions.length);
    row.cropReviews[0].warningDecisions[0].status = 'pending'; return row;
  });
  assert.equal(report.status, 'incomplete');
  assert.equal(JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json'))).openIssues.length, 0);
  await assert.rejects(finalizeVersion(f.run, 'v01', 'pending'), /missing checks/);
}));

test('identical warning templates across icons are incomplete even when each hash is current', async () => fixture(async f => {
  const touching = structuredClone(f.scene); touching.elements[1].bbox_px = [105, 95, 135, 125]; touching.elements[2].bbox_px = [170, 95, 200, 125];
  const v1 = await f.render('v01', touching);
  const report = await f.review('v01', v1, 'reused', row => {
    for (const crop of row.cropReviews) for (const decision of crop.warningDecisions) Object.assign(decision, {
      sourceObservation: 'Source object has its original full shape and surrounding margin.',
      renderObservation: 'Rendered object has its original full shape and surrounding margin.' });
    return row;
  });
  assert.equal(report.status, 'incomplete');
  assert.ok(report.cropChecks.every(row => row.objectReview.missing.some(message => message.includes('repeated_warning_template'))));
}, { twoImages: true }));

test('the same declared crop/icon defect is registered once, while a distinct declared defect remains separate', async () => fixture(async f => {
  const v1 = await f.render('v01');
  const declare = description => row => {
    row.cropReviews[0].status = 'issue'; row.cropReviews[0].note = description;
    row.iconChecks[0].status = 'issue'; row.iconChecks[0].note = description; return row;
  };
  const first = 'The red square right edge is declared incorrect in this synthetic ledger test.';
  await f.review('v01', v1, 'first-declaration', declare(first));
  await f.review('v01', v1, 'repeat-declaration', declare(first));
  let ledger = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json')));
  assert.equal(ledger.openIssues.length, 1);
  await f.review('v01', v1, 'another-declaration', declare('The red square top fill is a separately declared defect in this synthetic ledger test.'));
  ledger = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json')));
  assert.equal(ledger.openIssues.length, 2);
}));

test('open automatic issues deduplicate across versions; resolved recurrence gets a new immutable occurrence', async () => fixture(async f => {
  const bad = structuredClone(f.scene); bad.elements[0].text = 'Hello';
  const v1 = await f.render('v01', bad); await f.review('v01', v1, 'first');
  let ledger = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json')));
  assert.equal(ledger.openIssues.length, 1); const firstId = ledger.openIssues[0].id;
  const secondBad = structuredClone(bad); secondBad.elements[0].x = 11;
  const v2 = await f.render('v02', secondBad); await f.review('v02', v2, 'again');
  ledger = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json')));
  assert.deepEqual(ledger.openIssues.map(row => row.id), [firstId]);
  const v3 = await f.render('v03'); await f.review('v03', v3, 'fixed');
  const request = { resolutions: [{ issueId: firstId, reviewLabel: 'fixed', fixDescription: 'Restore full Hello World source text.' }] };
  let prepared = await resolveVersionIssues(f.run, 'v03', await f.write('resolve.json', request), 'restore');
  request.resolutions[0].viewedPatchSha256 = prepared.patches[0].sha256;
  await resolveVersionIssues(f.run, 'v03', await f.write('resolve.json', request), 'restore');
  const regression = structuredClone(bad); regression.elements[0].x = 12;
  const v4 = await f.render('v04', regression); await f.review('v04', v4, 'regression');
  ledger = JSON.parse(await readFile(join(f.run, 'evidence', 'open-issues.json')));
  assert.equal(ledger.openIssues.length, 1); assert.equal(ledger.resolvedIssues.length, 1);
  assert.notEqual(ledger.openIssues[0].id, firstId); assert.equal(ledger.openIssues[0].semanticKey, ledger.resolvedIssues[0].semanticKey);
}));

test('explicit crop issue cannot close through the low-level resolver using an accepted label without object evidence', async () => fixture(async f => {
  const clipped = structuredClone(f.scene); clipped.elements[1].bbox_px = [105, 95, 125, 125];
  const v1 = await f.render('v01', clipped); await f.review('v01', v1, 'clipped');
  await registerVersionIssues(f.run, 'v01', await f.write('crop-issue.json', { reviewer: 'independent', issues: [{
    id: 'right-side-cut', kind: 'crop', inventoryId: 'red-icon', elementIds: ['redImage'], roi: [100, 90, 140, 130],
    severity: 'critical', description: 'The right ten pixels of the red square are absent.' }] }), 'independent');
  const v2 = await f.render('v02'); await f.review('v02', v2, 'generic-fixed', row => ({ ...row,
    cropReviews: [{ id: 'redImage', status: 'accepted', note: 'The full red object is visible now.' }] }));
  const request = { resolutions: [{ issueId: 'right-side-cut', reviewLabel: 'generic-fixed', fixDescription: 'Expanded the crop to retain the missing right edge.' }] };
  await assert.rejects(resolveVersionIssues(f.run, 'v02', await f.write('resolve.json', request), 'blocked'), /complete object evidence/);
  await f.review('v02', v2, 'fully-checked'); request.resolutions[0].reviewLabel = 'fully-checked';
  const prepared = await resolveVersionIssues(f.run, 'v02', await f.write('resolve.json', request), 'ready');
  assert.equal(prepared.status, 'pending_visual_review');
}));

test('finalization rejects altered three-column evidence even when review and preview hashes remain unchanged', async () => fixture(async f => {
  const v1 = await f.render('v01'); await f.review('v01', v1, 'checked');
  const bundle = await ensureIconEvidence(f.run, 'v01'), path = bundle.items[0].comparison.path;
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('changed')]));
  await assert.rejects(finalizeVersion(f.run, 'v01', 'checked'), /changed|stale|hash/i);
}));

test('legacy manifest still uses the historical crop declaration and contact-sheet contract', async () => fixture(async f => {
  const v1 = await f.render('v01'), report = await f.review('v01', v1, 'legacy');
  assert.equal(report.reviewProtocol, undefined); assert.ok(report.cropContactSheet);
  assert.equal(report.cropChecks[0].objectReview, undefined);
  assert.equal((await finalizeVersion(f.run, 'v01', 'legacy')).status, 'complete');
}, { legacy: true }));
