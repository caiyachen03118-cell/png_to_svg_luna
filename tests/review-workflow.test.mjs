import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { initializeRun, renderProposal } from '../tools/render.mjs';
import { freezeInventory, measureSource, refreshVerificationState, reviewVersion } from '../src/evidence.mjs';
import { prepareReview, reopenReview, nextReviewItem, recordReviewItem, submitReview, closeReviewIssues, finishReview, workflowStatus } from '../src/review-workflow.mjs';

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-workflow-test-'));
  try {
    const input = join(directory, 'input.png'), run = join(directory, 'run');
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700"><rect width="900" height="700" fill="white"/><rect x="10" y="10" width="30" height="20" fill="black"/><text x="10" y="70" font-family="Arial" font-size="18">Hello World</text><rect x="105" y="95" width="30" height="30" fill="red"/></svg>')).png().toFile(input);
    const manifest = await initializeRun(input, run, { repairRequired: true });
    assert.equal(manifest.reviewProtocol, 'object-review-v1');
    let sequence = 0;
    const write = async value => { const path = join(directory, `request-${++sequence}.json`); await writeFile(path, JSON.stringify(value)); return path; };
    await mkdir(join(run, 'evidence'));
    await writeFile(join(run, 'evidence', 'ocr-source.json'), JSON.stringify({ sourceSha256: manifest.sourceSha256, width: 900, height: 700,
      engine: 'Synthetic test fixture, no OCR model invocation', candidates: [{ id: 'ocr-1', text: 'Hello World', bbox: [10, 50, 130, 76] }] }));
    const inventory = { texts: [{ id: 'greeting', text: 'Hello World', bbox: [10, 50, 130, 76] }],
      objects: [{ id: 'blackbox', kind: 'rectangle', bbox: [10, 10, 40, 30], description: 'Black source rectangle.' }],
      icons: [{ id: 'red-icon', bbox: [105, 95, 135, 125], representation: 'image', description: 'Full red source square.' }],
      connectors: [], structureCoverage: { icons: 'listed', connectors: 'none', note: 'Known synthetic source with a red square icon and no connectors.' },
      ocrEvidence: 'evidence/ocr-source.json', ocrDecisions: [{ candidateId: 'ocr-1', status: 'accepted', inventoryIds: ['greeting'] }] };
    await freezeInventory(run, await write(inventory));
    await measureSource(run, await write({ roi: [0, 0, 50, 40], mode: 'dark', purpose: 'Measure source black rectangle.' }), 'black');
    await measureSource(run, await write({ roi: [95, 85, 145, 135], mode: 'color', color: '#ff0000', tolerance: 1, purpose: 'Measure source red square.' }), 'red');
    const scene = { width: 900, height: 700, background: '#ffffff', elements: [
      { id: 'greeting', type: 'text', x: 10, y: 70, text: 'Hello World', fontSize: 18, fontFamily: 'Arial' },
      { id: 'blackbox', type: 'rect', x: 10, y: 10, width: 30, height: 20, fill: '#000000', stroke: 'none' },
      { id: 'red-icon', type: 'image', kind: 'chart', bbox_px: [100, 90, 140, 130], reason: 'A local source crop around the complete red square.' },
    ] };
    const render = async (version, proposal = scene) => renderProposal(run, await write(proposal), version);
    const record = async response => recordReviewItem(run, await write(response));
    await fn({ directory, input, run, scene, write, render, record });
  } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-workflow-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}

function answer(item) {
  const row = { ...structuredClone(item.response), viewed: true };
  if (item.kind === 'icon') {
    Object.assign(row, { status: 'accepted', note: 'The source red square and its white margin are retained in the rendered local icon.' });
    row.edgeObservations.forEach(edge => Object.assign(edge, {
      sourceObservation: `On the ${edge.side} side of the red square, the source boundary ends beside a white margin.`,
      renderObservation: `The rendered red square retains the ${edge.side} boundary with the surrounding white margin.`,
    }));
    row.warningDecisions.forEach(warning => Object.assign(warning, { status: 'benign',
      sourceObservation: `Source warning ${warning.warningId} is an observed local contour of the synthetic red square.`,
      renderObservation: `Rendered warning ${warning.warningId} retains that same local red contour in this synthetic fixture.`,
    }));
    row.removedBandDecisions.forEach(band => Object.assign(band, { status: 'benign',
      sourceObservation: `Removed band ${band.id} contains only the white margin of this synthetic square fixture.`,
      renderObservation: `After band ${band.id} is excluded, the rendered red square remains completely below that margin.`,
    }));
  } else {
    row.summary = 'Synthetic inspection declaration for workflow integration; this test does not evaluate model perception.';
    if (item.kind === 'region') row.checks = { text: 'no_difference', shape: 'no_difference', connector: 'not_applicable', boundary: 'no_difference' };
    if (item.kind === 'global') row.checks = { crossRegionConnectors: 'not_applicable', iconCompleteness: 'no_difference', omissions: 'no_difference' };
  }
  return row;
}

async function drain(f, mutate = () => {}) {
  const visited = [];
  for (let n = 0; n < 30; n++) {
    const next = await nextReviewItem(f.run);
    if (next.kind === 'submit') return visited;
    const response = answer(next); mutate(response, next);
    await f.record(response); visited.push(next);
  }
  throw new Error('Workflow queue did not terminate');
}

test('strict workflow runs through real prepare/next/record/submit/finish with code-managed hashes and paths', async () => fixture(async f => {
  await f.render('v01');
  const initial = await prepareReview(f.run);
  assert.equal(initial.scope, 'full-grid');
  assert.equal(initial.regions.total, 4);
  const visited = await drain(f);
  assert.equal(visited[0].kind, 'overview'); assert.equal(visited.at(-1).kind, 'global');
  assert.equal(visited.filter(x => x.kind === 'region').length, 4);
  const icon = JSON.parse(await readFile(join(initial.directory, 'icons', 'red-icon.json'), 'utf8'));
  assert.match(icon.evidenceManifestSha256, /^[a-f0-9]{64}$/);
  assert.match(icon.comparisonSha256, /^[a-f0-9]{64}$/);
  assert.ok(icon.edgeObservations.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
  const submitted = await submitReview(f.run);
  assert.equal(submitted.submission.reviewStatus, 'complete');
  const final = await finishReview(f.run);
  assert.equal(final.status, 'complete');
  assert.equal(final.qualityStatus, 'not_independently_verified');
}));

test('unchanged later render reuses icon evidence, schedules no local regions and still requires a global overview', async () => fixture(async f => {
  await f.render('v01'); await prepareReview(f.run); await drain(f); await submitReview(f.run);
  // The renderer correctly rejects an identical proposal. Equivalent SVG color
  // spelling changes scene bytes while preserving the exact rendered pixels.
  const equivalent = structuredClone(f.scene); equivalent.elements.find(x => x.id === 'blackbox').fill = '#000';
  await f.render('v02', equivalent); const prepared = await prepareReview(f.run);
  assert.equal(prepared.scope, 'changed-neighborhoods-and-unresolved');
  assert.equal(prepared.regions.total, 0);
  assert.equal(prepared.icons.reused, 1);
  assert.equal(prepared.global, 'pending');
  const plan = JSON.parse(await readFile(join(prepared.directory, 'plan.json'), 'utf8'));
  assert.equal(plan.selection.changedPixels, 0);
  await assert.rejects(submitReview(f.run), /final overview/);
  const visited = await drain(f);
  assert.deepEqual(visited.map(x => x.kind), ['global'], 'No local work means one mandatory overview review, not two adjacent copies');
  await submitReview(f.run); await finishReview(f.run);
  const report = JSON.parse(await readFile(join(prepared.directory, 'regions', 'report.json'), 'utf8'));
  assert.equal(report.reviewScope, 'selected_regions');
  assert.equal(report.fullGridCoverageRecorded, false);
  assert.equal(report.coverageSummary.coveredPixels, 0);
  assert.equal(report.visualCorrectnessVerified, false);
  const changed = structuredClone(f.scene); changed.elements.find(x => x.id === 'blackbox').fill = '#111111';
  await f.render('v03', changed); const third = await prepareReview(f.run);
  assert.equal(third.scope, 'changed-neighborhoods-and-unresolved');
  assert.ok(third.regions.total > 0 && third.regions.total < 4);
  const changedPlan = JSON.parse(await readFile(join(third.directory, 'plan.json'), 'utf8'));
  assert.equal(changedPlan.selection.changedPixels, 600);
}));

test('a rejected region response can be corrected and retried without a new render or stale response collision', async () => fixture(async f => {
  await f.render('v01'); await prepareReview(f.run);
  while ((await nextReviewItem(f.run)).kind !== 'region') await f.record(answer(await nextReviewItem(f.run)));
  const item = await nextReviewItem(f.run), bad = answer(item);
  bad.summary = '';
  await assert.rejects(f.record(bad), /summary/);
  assert.equal((await nextReviewItem(f.run)).id, item.id);
  await f.record(answer(item));
  assert.notEqual((await nextReviewItem(f.run)).id, item.id);
  await drain(f); await submitReview(f.run);
  assert.equal((await finishReview(f.run)).status, 'complete');
}));

test('pending icon decisions can be completed on the same rendered version and resubmitted without consuming render budget', async () => fixture(async f => {
  await f.render('v01'); const prepared = await prepareReview(f.run);
  let pendingIcon;
  await drain(f, (response, item) => {
    if (item.kind === 'icon') {
      pendingIcon = item; response.status = 'pending';
      response.note = 'The fixture deliberately defers a semantic icon decision before the same-version recheck.';
    }
  });
  const first = await submitReview(f.run);
  assert.equal(first.submission.reviewStatus, 'incomplete');
  await assert.rejects(finishReview(f.run), /Finalization blocked/);
  await f.record(answer(pendingIcon));
  const second = await submitReview(f.run);
  assert.equal(second.submission.reviewStatus, 'complete');
  assert.equal(second.version, 'v01');
  assert.equal((await finishReview(f.run)).status, 'complete');
  const log = (await readFile(join(f.run, 'render-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.filter(x => x.event === 'success').length, 1);
  assert.equal((await workflowStatus(f.run)).directory, prepared.directory);
}));

test('an unfinished preceding partition review forces full-grid fallback on the next render', async () => fixture(async f => {
  await f.render('v01'); await prepareReview(f.run);
  // Complete local evidence but intentionally leave a meaningful uncertainty in
  // one region. It must not silently authorize skipped cells on the next render.
  let uncertain = false;
  await drain(f, (response, item) => {
    if (item.kind === 'region' && !uncertain) {
      uncertain = true; response.checks.boundary = 'uncertain';
      response.uncertain = ['The test intentionally leaves the local boundary undecided.'];
    }
  });
  const first = await submitReview(f.run);
  assert.equal(first.submission.partitionReviewComplete, false);
  await assert.rejects(finishReview(f.run), /Uncertain partition/);
  const changed = structuredClone(f.scene); changed.elements.find(x => x.id === 'blackbox').fill = '#111111';
  await f.render('v02', changed); const next = await prepareReview(f.run);
  assert.equal(next.scope, 'full-grid');
  assert.equal(next.regions.total, 4);
}));

test('reopen preserves an uncertain review and permits a fresh same-version check without another render', async () => fixture(async f => {
  await f.render('v01'); const first = await prepareReview(f.run);
  let uncertain = false;
  await drain(f, (response, item) => {
    if (item.kind === 'region' && !uncertain) {
      uncertain = true; response.checks.boundary = 'uncertain';
      response.uncertain = ['The red icon boundary needs another source/render comparison.'];
    }
  });
  await submitReview(f.run);
  const oldPath = join(first.directory, 'regions', 'report.json'), oldBytes = await readFile(oldPath);
  await assert.rejects(finishReview(f.run), /Uncertain partition/);
  const reopened = await reopenReview(f.run);
  assert.equal(reopened.version, 'v01'); assert.notEqual(reopened.directory, first.directory);
  assert.equal(reopened.scope, 'full-grid');
  assert.equal(reopened.regions.total, 4);
  await drain(f); await submitReview(f.run);
  assert.equal((await finishReview(f.run)).status, 'complete');
  assert.deepEqual(await readFile(oldPath), oldBytes);
  const renderLog = (await readFile(join(f.run, 'render-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(renderLog.filter(x => x.event === 'success').length, 1);
}));

test('imported findings close after repair, but revised pending icons cannot use an old accepted closure plan', async () => fixture(async f => {
  const incorrect = structuredClone(f.scene); incorrect.elements.find(x => x.id === 'blackbox').fill = '#111111';
  await f.render('v01', incorrect); await prepareReview(f.run);
  let found = false;
  const description = 'The native rectangle fill is gray rather than the black source fill.';
  await drain(f, (response, item) => {
    if (item.kind === 'region' && !found) {
      found = true; response.checks.shape = 'difference';
      response.findings.push({ id: 'wrong-fill', bbox: [12, 12, 35, 25], kind: 'shape', description,
        evidence: ['The source rectangle is RGB 0,0,0 while the rendered rectangle is RGB 17,17,17.'] });
    }
  });
  await submitReview(f.run);
  const initialLedger = await refreshVerificationState(f.run), issue = initialLedger.openIssues.find(x => x.description === description);
  assert.ok(issue, 'The partition finding must be registered');
  assert.ok(issue.inventoryId || issue.elementIds.length, 'Imported findings cannot lose their repair target');
  await f.render('v02'); await prepareReview(f.run); await drain(f);
  const submitted = await submitReview(f.run);
  const plan = JSON.parse(await readFile(join(submitted.submission.closureDirectory, 'plan.json'), 'utf8'));
  const row = plan.rows.find(x => x.issueId === issue.id);
  assert.equal(row.status, 'ready_for_visual_review');
  const closeInput = { decisions: [{ groupId: row.groupId, status: 'accepted', viewed: true,
    fixDescription: 'The blackbox element fill changed from RGB 17 to RGB 0; the full source rectangle is retained.' }] };
  const icon = JSON.parse(await readFile(join(submitted.directory, 'icons', 'red-icon.json'), 'utf8'));
  await f.record({ ...icon, status: 'pending', note: 'The latest observation reopens the square boundary; an old accepted review cannot override this decision.' });
  const eventsBefore = await readFile(join(f.run, 'evidence', 'events.jsonl'));
  await assert.rejects(closeReviewIssues(f.run, await f.write(closeInput)), /Icon decisions changed after submission/);
  assert.deepEqual(await readFile(join(f.run, 'evidence', 'events.jsonl')), eventsBefore, 'A stale closure attempt must not register any resolution');
  assert.ok((await refreshVerificationState(f.run)).openIssues.some(x => x.id === issue.id));
  assert.match((await workflowStatus(f.run)).next, /submit revised icon/);
  await f.record({ ...icon, note: `${icon.note} The latest recheck confirms the red boundary against the source again.` });
  const refreshed = await submitReview(f.run);
  assert.notEqual(refreshed.submission.reviewLabel, submitted.submission.reviewLabel);
  const closed = await closeReviewIssues(f.run, await f.write(closeInput));
  assert.equal(closed.resolvedCount, 1);
  assert.equal((await finishReview(f.run)).status, 'complete');
}));

test('sharing one closure evidence image does not bulk-close separate issues without explicit issue selection', async () => fixture(async f => {
  const incorrect = structuredClone(f.scene), box = incorrect.elements.find(x => x.id === 'blackbox');
  box.fill = '#111111'; box.x = 11;
  await f.render('v01', incorrect); await prepareReview(f.run);
  const descriptions = ['Black rectangle uses gray fill.', 'Black rectangle is shifted one pixel right.'];
  let found = false;
  await drain(f, (response, item) => {
    if (item.kind === 'region' && !found) {
      found = true; response.checks.shape = 'difference';
      response.findings = descriptions.map((description, index) => ({ id: `rectangle-${index}`, bbox: [10, 10, 41, 30], kind: 'shape', description,
        evidence: [index ? 'The source starts at x=10 and the candidate starts at x=11.' : 'Source RGB 0 is rendered as RGB 17.'] }));
    }
  });
  await submitReview(f.run);
  const initialLedger = await refreshVerificationState(f.run);
  const colorIssue = initialLedger.openIssues.find(x => x.description === descriptions[0]);
  const positionIssue = initialLedger.openIssues.find(x => x.description === descriptions[1]);
  assert.ok(colorIssue && positionIssue);
  const partiallyFixed = structuredClone(incorrect); partiallyFixed.elements.find(x => x.id === 'blackbox').fill = '#000000';
  await f.render('v02', partiallyFixed); await prepareReview(f.run); await drain(f);
  const submitted = await submitReview(f.run);
  const plan = JSON.parse(await readFile(join(submitted.submission.closureDirectory, 'plan.json'), 'utf8'));
  const colorRow = plan.rows.find(x => x.issueId === colorIssue.id), positionRow = plan.rows.find(x => x.issueId === positionIssue.id);
  assert.equal(colorRow.groupId, positionRow.groupId);
  const decision = { groupId: colorRow.groupId, status: 'accepted', viewed: true,
    fixDescription: 'The fill was restored to black; the one-pixel position issue has not been repaired.' };
  await assert.rejects(closeReviewIssues(f.run, await f.write({ decisions: [decision] })), /closure issue|issueIds/);
  const closed = await closeReviewIssues(f.run, await f.write({ decisions: [{ ...decision, issueIds: [colorIssue.id] }] }));
  assert.equal(closed.resolvedCount, 1);
  const ledger = await refreshVerificationState(f.run);
  assert.ok(ledger.resolvedIssues.some(x => x.id === colorIssue.id));
  assert.ok(ledger.openIssues.some(x => x.id === positionIssue.id));
  await assert.rejects(finishReview(f.run), /Open issues/);
}));

test('ambiguous finding bindings validate before side effects and superseded receipts refresh on identical resubmission', async () => fixture(async f => {
  await f.render('v01'); const prepared = await prepareReview(f.run);
  const description = 'The rectangle needs a targeted follow-up within the region containing the greeting.';
  let found = false;
  await drain(f, (response, item) => {
    if (item.kind === 'region' && !found) {
      found = true; response.checks.shape = 'difference';
      // This overlaps both text and object inventory boxes: no automatic target
      // association can know which was meant by the observation.
      response.findings.push({ id: 'ambiguous-local-target', bbox: [10, 10, 130, 76], kind: 'shape', description,
        evidence: ['The observed region contains the black rectangle and nearby greeting; the intended repair target must be stated explicitly.'] });
    }
  });
  const first = await submitReview(f.run);
  assert.equal(first.submission.unboundFindings.length, 1);
  assert.equal(first.submission.reviewStatus, 'complete');
  await assert.rejects(finishReview(f.run), /Bind all unresolved/);
  assert.equal((await refreshVerificationState(f.run)).openIssues.length, 0, 'Ambiguous evidence must not be bound to an arbitrary object');
  const binding = first.submission.unboundFindings[0];
  assert.ok(binding.candidateInventoryIds.includes('greeting'));
  assert.ok(binding.candidateInventoryIds.includes('blackbox'));
  const decisions = JSON.parse(await readFile(join(prepared.directory, 'review-template.json'), 'utf8'));
  const eventPath = join(f.run, 'evidence', 'events.jsonl'), eventsBefore = await readFile(eventPath);
  const receiptPath = join(prepared.directory, 'submission.json'), receiptBefore = await readFile(receiptPath);
  const validBinding = { key: binding.key, inventoryId: 'blackbox', elementIds: ['blackbox'] };
  const invalidBindings = [
    {},
    [{ ...validBinding, key: 'unknown-observation-key' }],
    [validBinding, validBinding],
    [{ ...validBinding, inventoryId: 'unknown-inventory-item' }],
    [{ ...validBinding, elementIds: ['unknown-scene-element'] }],
    [{ ...validBinding, elementIds: ['blackbox', 'blackbox'] }],
  ];
  for (const findingBindings of invalidBindings) {
    await assert.rejects(submitReview(f.run, await f.write({ ...decisions, findingBindings })), /findingBindings|finding binding|inventoryId|finding targets/);
    assert.deepEqual(await readFile(eventPath), eventsBefore, 'Invalid binding must not create a newer low-level review');
    assert.deepEqual(await readFile(receiptPath), receiptBefore, 'Invalid binding must preserve the last successful receipt');
  }
  const stillCurrent = await submitReview(f.run);
  assert.equal(stillCurrent.submission.reviewLabel, first.submission.reviewLabel);
  decisions.findingBindings = [{ key: binding.key, inventoryId: 'blackbox', elementIds: ['blackbox'] }];
  const second = await submitReview(f.run, await f.write(decisions));
  assert.deepEqual(second.submission.unboundFindings, []);
  assert.notEqual(second.submission.reviewLabel, first.submission.reviewLabel);
  const ledger = await refreshVerificationState(f.run), issue = ledger.openIssues.find(x => x.description === description);
  assert.equal(issue.inventoryId, 'blackbox');
  assert.deepEqual(issue.elementIds, ['blackbox']);
  const same = await submitReview(f.run, await f.write(decisions));
  assert.equal(same.submission.reviewLabel, second.submission.reviewLabel, 'Identical resubmissions should not duplicate low-level reviews');
  assert.equal((await refreshVerificationState(f.run)).openIssues.length, 1);
  await reviewVersion(f.run, 'v01', join(prepared.directory, second.submission.reviewInput), 'external-recheck');
  assert.match((await workflowStatus(f.run)).next, /superseded/);
  const refreshed = await submitReview(f.run, await f.write(decisions));
  assert.notEqual(refreshed.submission.reviewLabel, second.submission.reviewLabel, 'Matching decisions cannot reuse a receipt superseded by another review');
  const latestEvent = (await readFile(eventPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(x => x.event === 'version_review').at(-1);
  assert.equal(latestEvent.label, refreshed.submission.reviewLabel);
  const again = await submitReview(f.run, await f.write(decisions));
  assert.equal(again.submission.reviewLabel, refreshed.submission.reviewLabel);
  assert.equal((await refreshVerificationState(f.run)).openIssues.length, 1, 'Refreshing an old receipt must not duplicate the persistent defect');
}));
