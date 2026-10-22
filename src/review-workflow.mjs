// Keep file discovery, hashes and ledger plumbing out of model conversations.
// Observations and acceptance remain explicit agent decisions, never generated here.
import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureIconEvidence, loadIconEvidence } from './icon-evidence.mjs';
import { loadEvidenceRun, readActiveInventory, inspectObjectCropReview, reviewVersion,
  registerVersionIssues, refreshVerificationState, planIssueClosure, applyIssueClosure, finalizeVersion } from './evidence.mjs';
import { createPartitionReview, selectChangedRegions, partitionReviewStatus,
  recordPartitionReview, recordGlobalReview, finalizePartitionReview } from './partition-review.mjs';

const PROTOCOL = 'luna-review-workflow-v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => { try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const save = (path, data) => writeFile(path, json(data), { flag: 'wx' });
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const clean = s => String(s).normalize('NFC').replace(/\s+/gu, ' ').trim();
const nonempty = (s, name) => { if (typeof s !== 'string' || !s.trim()) throw new Error(`${name} must be nonempty`); return s; };
const idCheck = id => { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id ?? '')) throw new Error('Invalid item ID'); return id; };
async function renderLog(run) { return (await readFile(join(run, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
async function latestReviewLabel(run, version) {
  const path = join(run, 'evidence', 'events.jsonl');
  if (!await exists(path)) return null;
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.event === 'version_review' && row.version === version).at(-1)?.label ?? null;
}
async function latestVersion(run) {
  const version = (await renderLog(run)).filter(x => x.event === 'success').at(-1)?.version;
  if (!version) throw new Error('Render a successful version first');
  return version;
}
const packetBase = (run, version) => join(run, 'evidence', 'workflow', version);
async function activeDirectory(run, version) {
  const base = packetBase(run, version), pointer = await readJsonIfExists(join(base, 'current.json'));
  if (!pointer) return null;
  if (!/^attempt-\d{3,}$/.test(pointer.attempt)) throw new Error('Invalid workflow attempt');
  return join(base, pointer.attempt);
}
async function nextAttempt(parent, prefix) {
  await mkdir(parent, { recursive: true });
  const pattern = new RegExp(`^${prefix}(\\d+)(?:\\.json)?$`);
  const numbers = (await readdir(parent)).map(n => pattern.exec(n)?.[1]).filter(Boolean).map(Number);
  return `${prefix}${String(Math.max(0, ...numbers) + 1).padStart(3, '0')}`;
}
async function recordIcon(directory, id, row) {
  const history = join(directory, 'icons', 'history', idCheck(id));
  const attempt = await nextAttempt(history, 'record-');
  await save(join(history, `${attempt}.json`), row);
  // This is a derived current-record cache; immutable revisions remain above.
  await writeFile(join(directory, 'icons', `${id}.json`), json(row));
}
async function iconRecordsSha256(packet) {
  return hash(json(await Promise.all(packet.bundle.items.map(x => readJson(join(packet.directory, 'icons', `${x.id}.json`))))));
}
function bindCropDecision(item, decision, bundle) {
  return { ...decision, id: item.id, evidenceManifestSha256: bundle.manifestSha256,
    comparisonSha256: item.comparison.sha256,
    edgeObservations: (decision.edgeObservations ?? []).map(row => ({ ...row, sha256: item.edges.find(e => e.side === row.side)?.sha256 })),
    removedBandDecisions: (decision.removedBandDecisions ?? []).map(row => ({ ...row, sha256: item.removedBands.find(b => b.id === row.id)?.sha256 })) };
}
function cropTemplate(item) {
  return { kind: 'icon', id: item.id, viewed: false, status: 'pending', note: '',
    edgeObservations: item.edges.map(e => ({ side: e.side, sourceObservation: '', renderObservation: '' })),
    warningDecisions: item.warnings.map(w => ({ warningId: w.id, status: 'pending', bbox: w.bbox, sourceObservation: '', renderObservation: '' })),
    removedBandDecisions: item.removedBands.map(b => ({ id: b.id, status: 'pending', bbox: b.bbox, sourceObservation: '', renderObservation: '' })) };
}
function seedReview(inventory, scene, prior) {
  const elements = new Map(scene.elements.map(e => [e.id, e])), mappings = [];
  for (const item of [...inventory.texts, ...(inventory.objects ?? [])]) {
    const before = prior?.mappings?.find(m => m.inventoryId === item.id);
    const exact = scene.elements.filter(e => e.id === item.id || (e.type === 'text' && item.text && clean(e.text) === clean(item.text)));
    const ids = before?.elementIds?.every(id => elements.has(id)) ? before.elementIds : exact.length === 1 ? [exact[0].id] : [];
    if (ids.length) mappings.push({ inventoryId: item.id, elementIds: ids });
  }
  const iconChecks = (inventory.icons ?? []).map(item => {
    const before = prior?.iconChecks?.find(x => x.inventoryId === item.id);
    const exact = scene.elements.filter(e => e.id === item.id || (e.type === 'image' && JSON.stringify(e.bbox_px) === JSON.stringify(item.bbox)));
    return { inventoryId: item.id, elementIds: before?.elementIds?.every(id => elements.has(id)) ? before.elementIds : exact.length === 1 ? [exact[0].id] : [],
      status: 'pending', note: '' };
  });
  const connectorChecks = (inventory.connectors ?? []).map(item => {
    const before = prior?.connectorChecks?.find(x => x.inventoryId === item.id);
    return { ...(before ?? {}), inventoryId: item.id, lineIds: before?.lineIds?.filter(id => elements.has(id)) ?? [],
      status: 'pending', note: '' };
  });
  return { mappings, iconChecks, connectorChecks,
    instructions: 'Mappings are mechanical suggestions, not visual acceptance. Fill unresolved mappings and native icon/connector observations. Image icon checks will be derived from your per-icon decisions only when the mapping is unambiguous.' };
}

export async function prepareReview(runPath, requestedVersion, options = {}) {
  const ctx = await loadEvidenceRun(runPath), version = requestedVersion ?? await latestVersion(ctx.run);
  if (ctx.manifest.reviewProtocol !== 'object-review-v1') throw new Error('Workflow requires a new object-review-v1 closed-loop run; historical runs remain untouched');
  if (version !== await latestVersion(ctx.run)) throw new Error('Prepare the latest successful version');
  const current = await activeDirectory(ctx.run, version);
  if (current && !options.reopen) return workflowStatus(ctx.run);
  const base = packetBase(ctx.run, version), attempt = await nextAttempt(base, 'attempt-'), directory = join(base, attempt);
  const bundle = await ensureIconEvidence(ctx.run, version), active = await readActiveInventory(ctx.run);
  const scene = await readJson(join(ctx.run, version, 'scene.json'));
  const ledger = await refreshVerificationState(ctx.run);
  const successes = (await renderLog(ctx.run)).filter(x => x.event === 'success');
  const previousVersion = options.reopen && current ? version : successes.at(-2)?.version;
  let previous = null, priorReview = null, selection = null;
  if (previousVersion && await activeDirectory(ctx.run, previousVersion)) {
    previous = await loadPacket(ctx.run, previousVersion, false);
    const reportPath = join(previous.directory, 'regions', 'report.json');
    if (await exists(reportPath)) {
      const report = await readJson(reportPath);
      if (report.reviewComplete && previous.plan.inventorySha256 === active.meta.inventorySha256) {
        const requiredRois = ledger.openIssues.map(x => ({ bbox: x.roi, id: x.id, reason: 'unresolved issue' }));
        // Retain observed differences until they are linked to a resolved persistent issue.
        const allIssues = [...ledger.openIssues, ...ledger.resolvedIssues];
        for (const finding of report.findings) {
          const known = allIssues.find(x => x.description === finding.description && overlaps(x.roi, finding.bbox));
          if (!known || known.status !== 'resolved') requiredRois.push({ bbox: finding.bbox, reason: 'unresolved prior observation' });
        }
        selection = await selectChangedRegions(join(ctx.run, previousVersion, 'preview.png'), join(ctx.run, version, 'preview.png'), { requiredRois });
      }
    }
    const receipts = await readJsonIfExists(join(previous.directory, 'submission.json'));
    if (receipts) priorReview = await readJson(join(previous.directory, receipts.reviewInput));
  }
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, 'icons')); await mkdir(join(directory, 'responses'));
  const regions = await createPartitionReview(join(ctx.run, 'source.png'), join(ctx.run, version, 'preview.png'), join(directory, 'regions'),
    selection ? { selectedRegionIds: selection.regionIds, selectionEvidence: selection } : {});
  const regionManifest = await readJson(regions.manifest);
  const carriedIcons = [];
  if (previous && selection) {
    const oldBundle = await loadIconEvidence(ctx.run, previousVersion);
    for (const item of bundle.items) {
      const oldItem = oldBundle.items.find(x => x.id === item.id), oldPath = join(previous.directory, 'icons', `${item.id}.json`);
      if (!oldItem?.contentFingerprint || oldItem.contentFingerprint !== item.contentFingerprint || !await exists(oldPath)) continue;
      if (ledger.openIssues.some(x => x.elementIds.includes(item.id) || overlaps(x.roi, item.contextBox))) continue;
      const old = await readJson(oldPath);
      if (!inspectObjectCropReview(oldItem, old, oldBundle).acceptanceEligible) continue;
      const rebound = bindCropDecision(item, old, bundle);
      if (!inspectObjectCropReview(item, rebound, bundle).acceptanceEligible) continue;
      await recordIcon(directory, item.id, { ...rebound,
        carriedFrom: { version: previousVersion, recordSha256: hash(await readFile(oldPath)), contentFingerprint: item.contentFingerprint },
        viewingMode: 'unchanged_verified_content_reuse_not_new_view' });
      carriedIcons.push(item.id);
    }
  }
  const plan = { protocol: PROTOCOL, version, attempt, createdAt: new Date().toISOString(), sourceSha256: ctx.sourceSha256,
    previewSha256: bundle.previewSha256, sceneSha256: bundle.sceneSha256, inventorySha256: active.meta.inventorySha256,
    iconManifestSha256: bundle.manifestSha256, regionManifestSha256: hash(await readFile(regions.manifest)),
    previousVersion: previousVersion ?? null, scope: selection ? 'changed-neighborhoods-and-unresolved' : 'full-grid',
    selection, carriedIcons, iconIds: bundle.items.map(x => x.id), regionIds: regionManifest.regions.map(x => x.id),
    overview: regions.overview, reviewTemplate: join(directory, 'review-template.json'),
    limitations: ['Hashes bind files, not actual viewing or semantic correctness.', 'Unchanged accepted icon content can be carried with explicit provenance; unresolved regions and final overview are never silently accepted.'] };
  await save(join(directory, 'review-template.json'), seedReview(active.inventory, scene, priorReview));
  await save(join(directory, 'plan.json'), plan);
  await save(join(directory, 'plan-hash.json'), { sha256: hash(json(plan)) });
  await writeFile(join(base, 'current.json'), json({ attempt, planSha256: hash(json(plan)) }));
  return workflowStatus(ctx.run);
}
export async function reopenReview(runPath) { return prepareReview(runPath, undefined, { reopen: true }); }
async function readJsonIfExists(path) { return await exists(path) ? readJson(path) : null; }
async function loadPacket(runPath, wanted, requireLatest = true) {
  const ctx = await loadEvidenceRun(runPath), version = wanted ?? await latestVersion(ctx.run), directory = await activeDirectory(ctx.run, version);
  if (!directory) throw new Error('Prepare a workflow packet first');
  if (requireLatest && version !== await latestVersion(ctx.run)) throw new Error('Workflow packet is not the latest render');
  const bytes = await readFile(join(directory, 'plan.json')), plan = JSON.parse(bytes);
  if (hash(bytes) !== (await readJson(join(directory, 'plan-hash.json'))).sha256) throw new Error('Workflow plan changed');
  const bundle = await loadIconEvidence(ctx.run, version);
  if (plan.sourceSha256 !== ctx.sourceSha256 || plan.previewSha256 !== bundle.previewSha256 || plan.sceneSha256 !== bundle.sceneSha256
    || plan.iconManifestSha256 !== bundle.manifestSha256 || plan.regionManifestSha256 !== hash(await readFile(join(directory, 'regions', 'manifest.json')))) throw new Error('Stale workflow evidence');
  if (requireLatest && plan.inventorySha256 !== (await readActiveInventory(ctx.run)).meta.inventorySha256) throw new Error('Inventory changed after preparation; use reopen to prepare a fresh packet');
  const regionStatus = await partitionReviewStatus(join(directory, 'regions'));
  return { ctx, version, directory, plan, bundle, regionStatus };
}
async function nextFrom(packet) {
  const { directory, bundle, plan, regionStatus } = packet;
  const localWork = plan.regionIds.length > 0 || plan.iconIds.some(id => !plan.carriedIcons.includes(id));
  if (localWork && !await exists(join(directory, 'overview.json'))) return { kind: 'overview', id: 'overview', image: plan.overview,
    response: { kind: 'overview', id: 'overview', viewed: false, summary: '' } };
  for (const item of bundle.items) if (!await exists(join(directory, 'icons', `${item.id}.json`))) return {
    kind: 'icon', id: item.id, image: item.comparison.path, edges: item.edges, removedBands: item.removedBands,
    warnings: item.warnings, response: cropTemplate(item) };
  const regionId = regionStatus.pendingRegions[0];
  if (regionId) {
    const m = await readJson(join(directory, 'regions', 'manifest.json')), r = m.regions.find(x => x.id === regionId);
    return { kind: 'region', id: regionId, bbox: r.bbox, image: join(directory, 'regions', r.pair),
      response: { kind: 'region', id: regionId, viewed: false, summary: '', checks: { text: 'uncertain', shape: 'uncertain', connector: 'uncertain', boundary: 'uncertain' }, findings: [], uncertain: [] } };
  }
  if (regionStatus.globalStatus === 'pending') return { kind: 'global', id: 'global', image: plan.overview,
    response: { kind: 'global', id: 'global', viewed: false, summary: '', checks: { crossRegionConnectors: 'uncertain', iconCompleteness: 'uncertain', omissions: 'uncertain' }, findings: [], uncertain: [] } };
  return { kind: 'submit', reviewTemplate: plan.reviewTemplate, command: 'node tools/review.mjs submit RUN [DECISIONS_JSON]',
    note: 'Coverage recorded; semantic issues/pending decisions may still block completion.' };
}
export async function nextReviewItem(runPath) { return nextFrom(await loadPacket(runPath)); }
export async function workflowStatus(runPath) {
  const packet = await loadPacket(runPath), recorded = (await readdir(join(packet.directory, 'icons'))).filter(f => f.endsWith('.json'));
  const submission = await readJsonIfExists(join(packet.directory, 'submission.json'));
  const ledger = await refreshVerificationState(packet.ctx.run);
  let next;
  if (!submission) next = await nextFrom(packet);
  else if (submission.reviewLabel !== await latestReviewLabel(packet.ctx.run, packet.version)) next = 'submit again to refresh a superseded review';
  else if (submission.iconRecordsSha256 !== await iconRecordsSha256(packet)) next = 'submit revised icon decisions';
  else if (submission.unboundFindings?.length) next = 'confirm findingBindings and submit again';
  else if (!submission.partitionReviewComplete) next = 'reopen uncertain region/global checks on the same rendered version';
  else if (ledger.openIssues.length) next = 'repair or close evidenced repairs';
  else if (submission.reviewStatus === 'complete') next = 'finish';
  else next = 'correct pending/issue decisions and submit again; render only for a visual repair';
  return { protocol: PROTOCOL, version: packet.version, scope: packet.plan.scope, directory: packet.directory,
    icons: { total: packet.bundle.items.length, recorded: recorded.length, reused: packet.plan.carriedIcons.length },
    regions: { total: packet.regionStatus.totalRegions, recorded: packet.regionStatus.recordedRegions, uncertain: packet.regionStatus.uncertainRegions.length },
    global: packet.regionStatus.globalStatus, openIssues: ledger.openIssues.map(x => ({ id: x.id, kind: x.kind, description: x.description })),
    ...(submission ? { submission } : {}), next };
}
export async function recordReviewItem(runPath, responsePath) {
  const packet = await loadPacket(runPath), request = await readJson(resolve(responsePath));
  const next = await nextFrom(packet);
  const revisingIcon = request.kind === 'icon' && packet.bundle.items.some(x => x.id === request.id)
    && await exists(join(packet.directory, 'icons', `${request.id}.json`));
  if (!revisingIcon && (request.kind !== next.kind || request.id !== next.id)) throw new Error(`Next item is ${next.kind}:${next.id}; use reopen for a fresh region/global review`);
  if (request.viewed !== true) throw new Error('Explicit viewed:true is required after inspecting the returned evidence');
  if (request.kind === 'overview') {
    await save(join(packet.directory, 'overview.json'), { summary: nonempty(request.summary, 'summary'), viewed: true,
      overviewSha256: hash(await readFile(packet.plan.overview)), viewingIsAgentDeclaration: true });
  } else if (request.kind === 'icon') {
    const item = packet.bundle.items.find(x => x.id === request.id), row = bindCropDecision(item, request, packet.bundle);
    if (!['accepted', 'issue', 'pending'].includes(row.status)) throw new Error('Icon status must be accepted, issue or pending');
    nonempty(row.note, 'icon note');
    const check = inspectObjectCropReview(item, row, packet.bundle);
    if (row.status === 'accepted' && !check.acceptanceEligible) throw new Error(`Icon acceptance blocked: ${JSON.stringify(check)}`);
    await recordIcon(packet.directory, item.id, row);
  } else {
    const m = await readJson(join(packet.directory, 'regions', 'manifest.json'));
    const row = request.kind === 'region' ? { ...request, regionId: request.id, viewedPairSha256: m.regions.find(r => r.id === request.id).pairSha256 }
      : { ...request, viewedOverviewSha256: m.overview.sha256 };
    const file = join(packet.directory, 'responses', `${request.kind}-${request.id}-${hash(json(row)).slice(0, 20)}.json`);
    if (!await exists(file)) await save(file, row);
    try {
      if (request.kind === 'region') await recordPartitionReview(join(packet.directory, 'regions'), file);
      else {
        await recordGlobalReview(join(packet.directory, 'regions'), file);
        await finalizePartitionReview(join(packet.directory, 'regions'));
      }
    } catch (error) {
      // The input is preserved; use another response file through record retry.
      throw error;
    }
  }
  return { recorded: `${request.kind}:${request.id}`, next: await nextFrom(await loadPacket(runPath)) };
}

export async function submitReview(runPath, decisionsPath) {
  const p = await loadPacket(runPath), receipt = join(p.directory, 'submission.json');
  if (p.regionStatus.pendingRegions.length || p.regionStatus.globalStatus === 'pending') throw new Error('Complete the queued evidence and final overview before submit');
  for (const item of p.bundle.items) if (!await exists(join(p.directory, 'icons', `${item.id}.json`))) throw new Error(`Missing icon decision: ${item.id}`);
  const decisions = await readJson(decisionsPath ? resolve(decisionsPath) : p.plan.reviewTemplate);
  const crops = await Promise.all(p.bundle.items.map(x => readJson(join(p.directory, 'icons', `${x.id}.json`))));
  const global = await readJson(join(p.directory, 'regions', 'records', 'global.json'));
  const scene = await readJson(join(p.ctx.run, p.version, 'scene.json'));
  const iconChecks = (decisions.iconChecks ?? []).map(row => {
    const mapped = (row.elementIds ?? []).map(id => scene.elements.find(e => e.id === id));
    const reviews = mapped.map(e => e?.type === 'image' ? crops.find(c => c.id === e.id) : null);
    if (reviews.length && reviews.every(Boolean)) return { ...row,
      status: reviews.some(r => r.status === 'issue') ? 'issue' : reviews.some(r => r.status !== 'accepted') ? 'pending' : 'accepted',
      note: reviews.map(r => `${r.id}: ${r.note}`).join('; ') };
    return row;
  });
  const payload = { mappings: decisions.mappings ?? [], iconChecks, connectorChecks: decisions.connectorChecks ?? [],
    cropReviews: crops, visualReview: { viewedPreviewSha256: p.bundle.previewSha256, notes: global.summary } };
  const reportPath = join(p.directory, 'regions', 'report.json'), report = await readJson(reportPath);
  const { inventory } = await readActiveInventory(p.ctx.run);
  const inventoryRows = [...inventory.texts, ...(inventory.objects ?? []), ...(inventory.icons ?? []), ...(inventory.connectors ?? [])];
  // Validate reviewer bindings before creating a new latest review. A rejected
  // request must not leave a previous successful receipt impossible to reuse.
  const findings = new Map();
  for (const finding of report.findings) {
    const key = hash(json({ kind: clean(finding.kind), description: clean(finding.description), bbox: finding.bbox })).slice(0, 20);
    if (!findings.has(key)) findings.set(key, finding);
  }
  const bindings = decisions.findingBindings ?? [], boundKeys = new Set();
  if (!Array.isArray(bindings)) throw new Error('findingBindings must be an array');
  for (const row of bindings) {
    if (!row || !findings.has(row.key) || boundKeys.has(row.key)) throw new Error('Unknown or duplicate finding binding');
    boundKeys.add(row.key);
    if (row.inventoryId !== undefined && !inventoryRows.some(item => item.id === row.inventoryId)) throw new Error(`Unknown finding inventoryId: ${row.inventoryId}`);
    if (row.elementIds !== undefined && (!Array.isArray(row.elementIds) || new Set(row.elementIds).size !== row.elementIds.length
      || row.elementIds.some(id => !scene.elements.some(e => e.id === id)))) throw new Error(`Invalid finding targets: ${row.key}`);
  }
  const identity = hash(json({ payload, findingBindings: decisions.findingBindings ?? [], partitionReportSha256: hash(await readFile(reportPath)) }));
  const previousSubmission = await readJsonIfExists(receipt);
  if (previousSubmission?.submissionFingerprint === identity && previousSubmission.reviewLabel === await latestReviewLabel(p.ctx.run, p.version)) return workflowStatus(runPath);
  const attempt = await nextAttempt(join(p.directory, 'submissions'), 'submit-');
  const submissionDir = join(p.directory, 'submissions', attempt); await mkdir(submissionDir);
  const inputName = `submissions/${attempt}/review-input.json`, input = join(p.directory, inputName);
  await save(input, payload);
  await save(join(submissionDir, 'finding-bindings.json'), decisions.findingBindings ?? []);
  const label = `workflow-${p.version}-${p.plan.attempt}-${attempt}`;
  const reviewDir = join(p.ctx.run, 'evidence', 'reviews', label);
  const result = await reviewVersion(p.ctx.run, p.version, input, label);
  const ledger = await refreshVerificationState(p.ctx.run);
  // Only exact matching observations are deduplicated automatically. Different
  // diagnoses/locations are retained; the code cannot infer semantic equivalence.
  const additions = [], unboundFindings = [];
  for (const [key, finding] of findings) {
    if (ledger.openIssues.some(x => clean(x.description) === clean(finding.description) && overlaps(x.roi, finding.bbox))) continue;
    const explicit = (decisions.findingBindings ?? []).find(row => row.key === key);
    const candidates = inventoryRows.filter(row => Array.isArray(row.bbox) && overlaps(row.bbox, finding.bbox));
    let inventoryId = explicit?.inventoryId ?? (candidates.length === 1 ? candidates[0].id : undefined);
    if (inventoryId !== undefined && !inventoryRows.some(row => row.id === inventoryId)) throw new Error(`Unknown finding inventoryId: ${inventoryId}`);
    const mapping = [...payload.mappings, ...payload.iconChecks, ...payload.connectorChecks].find(row => row.inventoryId === inventoryId);
    const elementIds = explicit?.elementIds ?? mapping?.elementIds ?? mapping?.lineIds ?? [];
    if (!Array.isArray(elementIds) || elementIds.some(id => !scene.elements.some(e => e.id === id))) throw new Error(`Invalid finding targets: ${key}`);
    if (!inventoryId && !elementIds.length) {
      unboundFindings.push({ key, ...finding, candidateInventoryIds: candidates.map(x => x.id),
        instruction: 'Confirm inventoryId and/or elementIds in findingBindings, then submit again. Ambiguous targets are not guessed.' });
      continue;
    }
    const occurrences = [...ledger.openIssues, ...ledger.resolvedIssues].filter(x => x.id.startsWith(`visual-${key}-`)).length;
    additions.push({ id: `visual-${key}-${occurrences + 1}`, kind: 'visual', severity: 'minor', inventoryId, elementIds,
      roi: finding.bbox, description: finding.description });
  }
  if (additions.length) {
    const path = join(submissionDir, 'visual-issues.json'); await save(path, { reviewer: 'luna', issues: additions });
    await registerVersionIssues(p.ctx.run, p.version, path, `${label}-visual`);
  }
  const plan = await planIssueClosure(p.ctx.run, p.version, `${label}-closure`);
  const submission = { submissionFingerprint: identity, iconRecordsSha256: hash(json(crops)), reviewLabel: label,
    reviewInput: inputName, reviewInputSha256: hash(json(payload)), reviewStatus: result.status, unboundFindings,
    partitionReviewComplete: report.reviewComplete, closureLabel: `${label}-closure`, closureDirectory: plan.directory,
    report: join(reviewDir, 'review.json'), semanticQualityVerified: false };
  await save(join(submissionDir, 'receipt.json'), submission);
  await writeFile(receipt, json(submission));
  return workflowStatus(runPath);
}
export async function closeReviewIssues(runPath, decisionsPath) {
  const p = await loadPacket(runPath), submitted = await readJson(join(p.directory, 'submission.json'));
  if (submitted.iconRecordsSha256 !== await iconRecordsSha256(p)) throw new Error('Icon decisions changed after submission; submit again before closing issues');
  const plan = await readJson(join(submitted.closureDirectory, 'plan.json')), request = await readJson(resolve(decisionsPath));
  if (!Array.isArray(request.decisions)) throw new Error('decisions array required');
  const decisions = [], seen = new Set();
  for (const decision of request.decisions) {
    const group = plan.groups.find(g => g.id === decision.groupId);
    if (!group) throw new Error('Unknown closure group');
    // Shared pixels do not imply a shared semantic decision.
    const issueIds = decision.issueIds ?? (group.issueIds.length === 1 ? group.issueIds : []);
    if (!Array.isArray(issueIds) || !issueIds.length || issueIds.some(id => !group.issueIds.includes(id) || seen.has(id))) throw new Error('Unknown or duplicate closure issue');
    issueIds.forEach(id => seen.add(id));
    if (!['accepted', 'issue', 'pending'].includes(decision.status)) throw new Error('Invalid closure decision');
    if (decision.status === 'accepted' && decision.viewed !== true) throw new Error('View the closure comparison before accepting');
    for (const issueId of issueIds) decisions.push({ issueId, status: decision.status,
      fixDescription: decision.status === 'accepted' ? nonempty(decision.fixDescription, 'fixDescription') : decision.fixDescription ?? '',
      viewedPatchSha256: group.sha256 });
  }
  const attempts = (await readdir(p.directory)).filter(f => /^close-\d+\.json$/.test(f)).length + 1;
  const path = join(p.directory, `close-${attempts}.json`); await save(path, { planLabel: submitted.closureLabel, decisions });
  const result = await applyIssueClosure(p.ctx.run, p.version, path, `workflow-${p.version}-${p.plan.attempt}-close-${attempts}`);
  return { status: result.status, resolvedCount: result.resolvedCount, outcomes: result.outcomes, remaining: result.ledger.openIssues.length };
}
export async function finishReview(runPath) {
  const p = await loadPacket(runPath), submitted = await readJson(join(p.directory, 'submission.json'));
  if (submitted.iconRecordsSha256 !== await iconRecordsSha256(p)) throw new Error('Icon decisions changed after submission; submit again');
  if (submitted.unboundFindings?.length) throw new Error('Bind all unresolved visual findings before completion');
  if (!submitted.partitionReviewComplete) throw new Error('Uncertain partition/global observations prevent completion');
  return finalizeVersion(p.ctx.run, p.version, submitted.reviewLabel);
}
