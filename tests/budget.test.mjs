import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { initializeRun, renderProposal, preflightProposal } from '../tools/render.mjs';
import { freezeInventory, measureSource, reviewVersion } from '../src/evidence.mjs';

const scene = { width: 200, height: 160, background: '#ffffff', elements: [
  { id: 'box', type: 'rect', x: 20, y: 20, width: 50, height: 50, fill: '#ff0000', stroke: 'none' },
] };
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-budget-test-'));
  try {
    const input = join(directory, 'input.png'), run = join(directory, 'run'), proposal = join(directory, 'proposal.json');
    await sharp({ create: { width: 200, height: 160, channels: 4, background: '#fff' } }).png().toFile(input);
    await writeFile(proposal, JSON.stringify(scene));
    await fn({ directory, input, run, proposal });
  } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-budget-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}

async function prepareClosedLoop(f, budget = 8) {
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160"><rect width="200" height="160" fill="white"/><rect x="20" y="20" width="50" height="30" fill="red"/><rect x="110" y="110" width="25" height="20" fill="black"/><text x="10" y="90" font-family="Arial" font-size="18">Hello</text></svg>')).png().toFile(f.input);
  const manifest = await initializeRun(f.input, f.run, { repairRequired: true, maxRenderAttempts: budget, reviewProtocol: 'legacy' });
  const write = async (name, value) => { const path = join(f.directory, `${name}.json`); await writeFile(path, JSON.stringify(value)); return path; };
  await mkdir(join(f.run, 'evidence'));
  await writeFile(join(f.run, 'evidence', 'ocr-source.json'), JSON.stringify({ schemaVersion: 1, sourceSha256: manifest.sourceSha256,
    width: 200, height: 160, engine: 'Explicit synthetic budget-test fixture', candidates: [{ id: 'ocr-1', text: 'Hello', bbox: [10, 72, 60, 91], confidence: 1 }] }));
  await freezeInventory(f.run, await write('inventory', { texts: [{ id: 'greeting', text: 'Hello', bbox: [10, 72, 60, 91] }],
    objects: [], icons: [], connectors: [], structureCoverage: { icons: 'none', connectors: 'none', note: 'Synthetic fixture contains colored test rectangles and text, with no icons or connectors.' },
    ocrEvidence: 'evidence/ocr-source.json', ocrDecisions: [{ candidateId: 'ocr-1', status: 'accepted', inventoryIds: ['greeting'] }] }));
  await measureSource(f.run, await write('red-measure', { roi: [10, 10, 80, 60], mode: 'color', color: '#ff0000', tolerance: 1, purpose: 'Measure red rectangle bounds' }), 'red');
  await measureSource(f.run, await write('black-measure', { roi: [100, 100, 145, 140], mode: 'dark', threshold: 100, purpose: 'Measure black rectangle bounds' }), 'black');
  const review = async (rendered, label, hasText = false) => reviewVersion(f.run, rendered.version, await write(label, {
    mappings: hasText ? [{ inventoryId: 'greeting', elementIds: ['hello'] }] : [], cropReviews: [], iconChecks: [], connectorChecks: [],
    visualReview: { viewedPreviewSha256: rendered.previewSha256, notes: hasText ? 'Synthetic fixture text has been restored.' : 'Synthetic fixture intentionally omits Hello so the issue must remain open.' },
  }), label);
  return { manifest, write, review };
}

test('closed-loop init defaults to eight attempts and enables both evidence and repair requirements', async () => fixture(async f => {
  const result = await initializeRun(f.input, f.run, { repairRequired: true });
  assert.equal(result.maxRenderAttempts, 8);
  assert.equal(result.evidenceRequired, true);
  assert.equal(result.repairRequired, true);
  assert.match(await readFile(join(f.run, 'README.md'), 'utf8'), /at most 8 attempts/);
  await assert.rejects(preflightProposal(f.run, f.proposal, 'v09'), /v01 through v08/);
  await assert.rejects(preflightProposal(f.run, f.proposal, 'v08'), /frozen source inventory/);
  assert.equal(await readFile(join(f.run, 'render-events.jsonl'), 'utf8'), '');
}));

test('closed-loop explicit budget allows one through twelve with two-digit version bounds', async () => fixture(async f => {
  for (const budget of [1, 4, 12]) {
    const run = join(f.directory, `run-${budget}`);
    const result = await initializeRun(f.input, run, { repairRequired: true, maxRenderAttempts: budget });
    assert.equal(result.maxRenderAttempts, budget);
    await assert.rejects(preflightProposal(run, f.proposal, `v${String(budget).padStart(2, '0')}`), /frozen source inventory/);
    await assert.rejects(preflightProposal(run, f.proposal, `v${String(budget + 1).padStart(2, '0')}`), /Version must/);
    for (const version of ['v1', 'v001', 'v00', 'v-1', 'v99']) await assert.rejects(preflightProposal(run, f.proposal, version), /Version must/);
  }
  for (const budget of [0, 13, 2.5, '8', null, NaN, Infinity]) {
    await assert.rejects(initializeRun(f.input, join(f.directory, 'invalid'), { repairRequired: true, maxRenderAttempts: budget }), /integer from 1 to 12/);
  }
  await assert.rejects(initializeRun(f.input, join(f.directory, 'invalid'), { maxRenderAttempts: 8 }), /requires repairRequired/);
  await assert.rejects(initializeRun(f.input, join(f.directory, 'invalid'), { repairRequired: 'true' }), /repairRequired must be boolean/);
}));

test('legacy and evidence-only init retain three attempts, and failed version validation still consumes one', async () => fixture(async f => {
  const legacy = await initializeRun(f.input, f.run);
  const evidence = await initializeRun(f.input, join(f.directory, 'evidence'), { evidenceRequired: true });
  assert.equal(legacy.maxRenderAttempts, 3); assert.equal(evidence.maxRenderAttempts, 3);
  assert.equal(legacy.repairRequired, undefined); assert.equal(evidence.repairRequired, undefined);
  await assert.rejects(preflightProposal(f.run, f.proposal, 'v04'), /v01 through v03/);
  assert.equal(await readFile(join(f.run, 'render-events.jsonl'), 'utf8'), '');
  await assert.rejects(renderProposal(f.run, f.proposal, 'v04'), /v01 through v03/);
  const events = (await readFile(join(f.run, 'render-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.event), ['attempt', 'failure']);
}));

test('manifest rejects invalid budgets and mismatched closed-loop requirements', async () => fixture(async f => {
  const result = await initializeRun(f.input, f.run, { repairRequired: true });
  for (const modification of [{ maxRenderAttempts: 0 }, { maxRenderAttempts: 13 }, { maxRenderAttempts: 1.5 },
    { maxRenderAttempts: '8' }, { evidenceRequired: false }, { repairRequired: 'true' }, { repairRequired: false }]) {
    await writeFile(join(f.run, 'manifest.json'), JSON.stringify({ ...result, ...modification }));
    await assert.rejects(preflightProposal(f.run, f.proposal, 'v01'), /Unsupported run manifest/);
    await assert.rejects(renderProposal(f.run, f.proposal, 'v01'), /Unsupported run manifest/);
  }
  assert.equal(await readFile(join(f.run, 'render-events.jsonl'), 'utf8'), '');
}));

test('CLI accepts closed-loop budgets and rejects missing, repeated or unrelated options without creating runs', async () => fixture(async f => {
  const cli = resolve('tools/render.mjs');
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'init', f.input, f.run, '--closed-loop', '--max-attempts', '12'], { encoding: 'utf8' }));
  assert.equal(result.maxRenderAttempts, 12); assert.equal(result.repairRequired, true); assert.equal(result.evidenceRequired, true);
  for (const flags of [['--max-attempts', '8'], ['--closed-loop', '--max-attempts'], ['--closed-loop', '--max-attempts', '0'],
    ['--closed-loop', '--max-attempts', '1.2'], ['--closed-loop', '--closed-loop'], ['--bogus']]) {
    assert.throws(() => execFileSync(process.execPath, [cli, 'init', f.input, join(f.directory, 'invalid'), ...flags], { encoding: 'utf8', stdio: 'pipe' }));
  }
}));

test('closed-loop review gate refuses unreviewed output without spending attempts, and an open issue permits a changed repair', async () => fixture(async f => {
  const prepared = await prepareClosedLoop(f);
  const first = await renderProposal(f.run, f.proposal, 'v01');
  const changed = structuredClone(scene);
  changed.elements.push({ id: 'hello', type: 'text', x: 10, y: 90, text: 'Hello', fontSize: 18, fill: '#000000' });
  const repaired = await prepared.write('repair', changed);
  await assert.rejects(preflightProposal(f.run, repaired, 'v02'), /review/i);
  await assert.rejects(renderProposal(f.run, repaired, 'v02'), /review/i);
  const before = (await readFile(join(f.run, 'render-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(before.filter(e => e.event === 'attempt').length, 1);
  assert.equal(before.filter(e => e.event === 'review_refusal').length, 1);
  const report = await prepared.review(first, 'first-review');
  assert.ok(report.missingTexts.includes('greeting'));
  assert.equal((await preflightProposal(f.run, repaired, 'v02')).remainingAttempts, 7);
  const second = await renderProposal(f.run, repaired, 'v02');
  assert.equal(second.attempt, 2); assert.equal(second.remainingAttempts, 6);
}));

test('closed-loop unchanged scene gate ignores JSON whitespace and key order and preserves the remaining budget', async () => fixture(async f => {
  const prepared = await prepareClosedLoop(f, 4);
  const first = await renderProposal(f.run, f.proposal, 'v01');
  await prepared.review(first, 'first-review');
  const equivalent = { elements: scene.elements.map(e => Object.fromEntries(Object.entries(e).reverse())), background: scene.background, height: scene.height, width: scene.width };
  const same = await prepared.write('same-scene-different-keys', equivalent);
  const eventsBefore = await readFile(join(f.run, 'render-events.jsonl'), 'utf8');
  await assert.rejects(preflightProposal(f.run, same, 'v02'), /Unchanged proposal duplicates v01/);
  assert.equal(await readFile(join(f.run, 'render-events.jsonl'), 'utf8'), eventsBefore);
  await assert.rejects(renderProposal(f.run, same, 'v02'), /Unchanged proposal duplicates v01/);
  const events = (await readFile(join(f.run, 'render-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'attempt').length, 1);
  assert.equal(events.filter(e => e.event === 'unchanged_proposal_refusal').length, 1);
  const changed = structuredClone(scene); changed.elements[0].x += 1;
  assert.equal((await preflightProposal(f.run, await prepared.write('changed', changed), 'v04')).remainingAttempts, 3);
}));

test('closed-loop failed proposals consume its configured budget and a high numbered valid version can render', async () => fixture(async f => {
  const prepared = await prepareClosedLoop(f, 4);
  const first = await renderProposal(f.run, f.proposal, 'v04');
  assert.equal(first.attempt, 1); assert.equal(first.remainingAttempts, 3);
  await prepared.review(first, 'first-review');
  await writeFile(f.proposal, '{invalid');
  for (const version of ['v01', 'v02', 'v03']) await assert.rejects(renderProposal(f.run, f.proposal, version), /JSON|property|Expected/);
  await assert.rejects(renderProposal(f.run, f.proposal, 'v01'), /limit reached \(4 attempts/);
  const events = (await readFile(join(f.run, 'render-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'attempt').length, 4);
  assert.equal(events.filter(e => e.event === 'failure').length, 3);
}));

test('closed-loop preserves the submitted crop while recording the same automatic correction adopted by legacy rendering', async () => fixture(async f => {
  const prepared = await prepareClosedLoop(f);
  const cropped = structuredClone(scene);
  cropped.elements = [{ id: 'redSymbol', type: 'image', kind: 'icon', bbox_px: [25, 24, 60, 45], reason: 'Synthetic red source symbol intentionally proposed with clipped edges.' }];
  const proposal = await prepared.write('crop-proposal', cropped);
  const legacyRun = join(f.directory, 'legacy');
  await initializeRun(f.input, legacyRun);
  const legacy = await renderProposal(legacyRun, proposal, 'v01');
  const strict = await renderProposal(f.run, proposal, 'v01');
  const oldScene = JSON.parse(await readFile(legacy.scene, 'utf8'));
  const strictScene = JSON.parse(await readFile(strict.scene, 'utf8'));
  const audit = JSON.parse(await readFile(strict.cropAudit, 'utf8')), item = audit.items[0];
  assert.notDeepEqual(oldScene.elements[0].bbox_px, cropped.elements[0].bbox_px);
  assert.deepEqual(strictScene.elements[0].bbox_px, cropped.elements[0].bbox_px);
  assert.deepEqual(item.finalBox, cropped.elements[0].bbox_px);
  assert.deepEqual(item.suggestedBox, oldScene.elements[0].bbox_px);
  assert.equal(item.automaticSuggestionStatus, 'repaired');
  assert.equal(item.status, 'needs_review');
  assert.deepEqual(audit.unresolvedIds, ['redSymbol']);
  assert.deepEqual(strict.repairedCropIds, []);
  assert.deepEqual(strict.suggestedCropIds, ['redSymbol']);
  assert.equal(item.evidence.boundaryCheckAppliesTo, 'suggestedBox');
  assert.deepEqual(item.evidence.measuredBox, item.suggestedBox);
}));
