import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { checkStructure } from '../src/structure.mjs';
import { initializeRun, renderProposal } from '../tools/render.mjs';
import { freezeInventory, measureSource, reviewVersion, planIssueClosure, applyIssueClosure, finalizeVersion } from '../src/evidence.mjs';

test('declared icon and connector defects retain mapped images, shafts and separate heads; absent objects stay unmapped', () => {
  const ctx = { width: 200, height: 160 };
  const inventory = { texts: [], objects: [], icons: [{ id: 'icon', bbox: [10, 10, 30, 30], representation: 'image', description: 'Source icon' }],
    connectors: [{ id: 'edge', from: [40, 50], to: [120, 50], heads: 'end', description: 'Source arrow' }],
    structureCoverage: { icons: 'listed', connectors: 'listed', note: 'Known synthetic source.' } };
  const scene = { ...ctx, elements: [{ id: 'crop', type: 'image', bbox_px: [10, 10, 30, 30], kind: 'icon' },
    { id: 'shaft', type: 'line', x1: 40, y1: 50, x2: 120, y2: 50, stroke: '#000000', strokeWidth: 2 },
    { id: 'tip', type: 'path', d: 'M120 50 L110 45 L110 55 Z', fill: '#000000', stroke: 'none' }] };
  const review = { iconChecks: [{ inventoryId: 'icon', elementIds: ['crop'], status: 'issue', note: 'Review found excess crop fringe.' }],
    connectorChecks: [{ inventoryId: 'edge', lineIds: ['shaft'], headIds: { end: ['tip'] }, status: 'issue', note: 'Review found oversized head.' }] };
  const result = checkStructure(inventory, scene, review, ctx);
  assert.deepEqual(result.issues.find(row => row.kind === 'icon' && row.code === 'declared_issue').elementIds, ['crop']);
  assert.deepEqual(result.issues.find(row => row.kind === 'connector' && row.code === 'declared_issue').elementIds, ['shaft', 'tip']);
  review.iconChecks[0].elementIds = [];
  const missing = checkStructure(inventory, scene, review, ctx);
  assert.deepEqual(missing.issues.find(row => row.kind === 'icon' && row.code === 'declared_issue').elementIds, []);
  assert.ok(missing.issues.some(row => row.kind === 'icon' && row.code === 'missing_mapping' && row.incomplete));
});

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-declared-issue-test-'));
  try {
    const input = join(directory, 'input.png'), run = join(directory, 'run');
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="white"/><rect x="10" y="10" width="30" height="20" fill="black"/><text x="10" y="70" font-family="Arial" font-size="18">Hello World</text><rect x="105" y="95" width="30" height="30" fill="red"/></svg>')).png().toFile(input);
    const manifest = await initializeRun(input, run, { repairRequired: true, reviewProtocol: 'legacy' });
    const write = async (name, data) => { const path = join(directory, name); await writeFile(path, JSON.stringify(data)); return path; };
    await mkdir(join(run, 'evidence'));
    await writeFile(join(run, 'evidence', 'ocr-source.json'), JSON.stringify({ sourceSha256: manifest.sourceSha256, width: 200, height: 160,
      candidates: [{ id: 'ocr-1', text: 'Hello World', bbox: [10, 50, 130, 76] }] }));
    const inventory = { texts: [{ id: 'greeting', text: 'Hello World', bbox: [10, 50, 130, 76] }], objects: [],
      icons: [{ id: 'red-icon', bbox: [105, 95, 135, 125], representation: 'image', description: 'Red source square' }], connectors: [],
      structureCoverage: { icons: 'listed', connectors: 'none', note: 'Known synthetic source.' }, ocrEvidence: 'evidence/ocr-source.json',
      ocrDecisions: [{ candidateId: 'ocr-1', status: 'accepted', inventoryIds: ['greeting'] }] };
    await freezeInventory(run, await write('inventory.json', inventory));
    await measureSource(run, await write('black.json', { roi: [0, 0, 50, 40], mode: 'dark', purpose: 'Measure black source square.' }), 'black');
    await measureSource(run, await write('red.json', { roi: [95, 85, 145, 135], mode: 'color', color: '#ff0000', tolerance: 1, purpose: 'Measure red source icon.' }), 'red');
    const scene = { width: 200, height: 160, background: '#aaccff', elements: [
      { id: 'greetingText', type: 'text', x: 10, y: 70, text: 'Hello World', fontSize: 18, fontFamily: 'Arial' },
      { id: 'redCrop', type: 'image', bbox_px: [95, 85, 145, 135], kind: 'icon', reason: 'Source red square with excessive white fringe.' }] };
    const render = async (version, proposal) => renderProposal(run, await write(`${version}.json`, proposal), version);
    const review = async (version, rendered, status = 'accepted', ids = ['redCrop']) => reviewVersion(run, version, await write(`${version}-review.json`, {
      mappings: [{ inventoryId: 'greeting', elementIds: ['greetingText'] }],
      cropReviews: [{ id: 'redCrop', status: 'accepted', note: 'This fixture records the defect through iconChecks only.' }],
      iconChecks: [{ inventoryId: 'red-icon', elementIds: ids, status, note: status === 'issue' ? 'Remove unwanted outer white crop fringe.' : 'Fixture current icon mapping accepted.' }], connectorChecks: [],
      visualReview: { viewedPreviewSha256: rendered.previewSha256, notes: 'Synthetic inspection declaration, not a model quality evaluation.' }
    }), version);
    const ledger = async () => JSON.parse(await readFile(join(run, 'evidence', 'open-issues.json'), 'utf8'));
    await fn({ run, scene, write, render, review, ledger });
  } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-declared-issue-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}

test('declared icon issue persists the old image and rejects unrelated mixed-mapping edits before accepting a real boundary repair', async () => fixture(async f => {
  const first = await f.render('v01', f.scene); await f.review('v01', first, 'issue');
  const issue = (await f.ledger()).openIssues.find(row => row.kind === 'icon' && row.code === 'declared_issue');
  assert.ok(issue); assert.deepEqual(issue.elementIds, ['redCrop']);
  assert.deepEqual(issue.discoveryElements, [f.scene.elements[1]]);
  const unrelated = structuredClone(f.scene);
  unrelated.elements.push({ id: 'nearbyDot', type: 'rect', x: 100, y: 90, width: 3, height: 3, fill: '#000000', stroke: 'none' });
  const second = await f.render('v02', unrelated); await f.review('v02', second, 'accepted', ['redCrop', 'nearbyDot']);
  const blocked = await planIssueClosure(f.run, 'v02', 'unrelated');
  assert.equal(blocked.readyCount, 0);
  assert.match(blocked.rows.find(row => row.issueId === issue.id).blockedReason, /no changed source pixels at the target crop boundary/);
  const attempt = await applyIssueClosure(f.run, 'v02', await f.write('invalid-acceptance.json', { planLabel: 'unrelated', decisions: [
    { issueId: issue.id, status: 'accepted', fixDescription: 'Unrelated native dot is not a crop repair.', viewedPatchSha256: blocked.groups[0].sha256 }
  ] }), 'unrelated-apply');
  assert.equal(attempt.resolvedCount, 0); assert.equal(attempt.ledger.openIssues.length, 1);
  const fixed = structuredClone(f.scene); fixed.elements[1].bbox_px = [101, 91, 139, 129];
  const third = await f.render('v03', fixed); await f.review('v03', third);
  const ready = await planIssueClosure(f.run, 'v03', 'actual-repair');
  assert.equal(ready.readyCount, 1);
  const body = JSON.parse(await readFile(ready.plan, 'utf8')), record = body.rows[0].prepared;
  assert.deepEqual(record.adoptedDiscoveryBoxes, [[95, 85, 145, 135]]);
  assert.deepEqual(record.adoptedCurrentBoxes, [[101, 91, 139, 129]]);
  assert.equal(record.originalRoiChangedPixels, 0); assert.ok(record.changedPixels > 0);
  assert.ok(record.targetBoundaryChangedPixels > 0);
  const closed = await applyIssueClosure(f.run, 'v03', await f.write('repair-acceptance.json', { planLabel: 'actual-repair', decisions: [
    { issueId: issue.id, status: 'accepted', fixDescription: 'Trim only the outer white fringe, retaining the full source red square.', viewedPatchSha256: ready.groups[0].sha256 }
  ] }), 'actual-repair-apply');
  assert.equal(closed.resolvedCount, 1); assert.equal(closed.ledger.openIssues.length, 0);
  assert.equal((await finalizeVersion(f.run, 'v03', 'v03')).status, 'complete');
}));

test('the existing automatic text mismatch path already preserves its mapped text snapshot', async () => fixture(async f => {
  const bad = structuredClone(f.scene); bad.elements[0].text = 'Hello';
  const first = await f.render('v01', bad); await f.review('v01', first);
  const issue = (await f.ledger()).openIssues.find(row => row.kind === 'text');
  assert.equal(issue.code, 'mismatch'); assert.deepEqual(issue.elementIds, ['greetingText']);
  assert.deepEqual(issue.discoveryElements, [JSON.parse(await readFile(join(f.run, 'v01', 'scene.json'), 'utf8')).elements[0]]);
}));
