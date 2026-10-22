import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { validateStructureInventory, checkStructure } from './structure.mjs';
import { ensureIconEvidence, loadIconEvidence } from './icon-evidence.mjs';

const PROTOCOL = 'luna-evidence-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const save = (path, value) => writeFile(path, value, { flag: 'wx' });
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const normal = value => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
// A text string in the scene is not evidence of visible source content.
// This intentionally checks only definite style/content invisibility, not
// contrast, occlusion, font glyph coverage or off-canvas geometry.
function invisibleTextReasons(element) {
  const reasons = [];
  const visiblePaint = value => typeof value === 'string' && value !== 'none'
    && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
    && (value.length !== 9 || parseInt(value.slice(7, 9), 16) > 0);
  if ((element.opacity ?? 1) <= 0) reasons.push('zero-opacity');
  if (!visiblePaint(element.fill ?? '#000000') && !(visiblePaint(element.stroke ?? 'none') && (element.strokeWidth ?? 1) > 0)) reasons.push('no-visible-fill-or-stroke');
  if ((element.fontSize ?? 0) <= 0) reasons.push('zero-font-size');
  if (!element.text.replace(/[\s\p{Cf}]/gu, '')) reasons.push('no-visible-text-characters');
  return reasons;
}
const nonempty = (value, label) => { if (typeof value !== 'string' || !value.trim() || value.length > 10000) throw new Error(`${label} must be nonempty text`); return value; };
const labelCheck = value => { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Label must contain 1–64 letters, digits, _ or -'); return value; };
const versionCheck = (value, max = 12) => { if (!/^v(?:0[1-9]|1[0-2])$/.test(value) || Number(value.slice(1)) > max) throw new Error(`Version must be v01 through v${String(max).padStart(2, '0')}`); return value; };
const boxCheck = (box, width, height, label) => {
  if (!Array.isArray(box) || box.length !== 4 || box.some((v, i) => !Number.isInteger(v) || v < 0 || v > (i % 2 ? height : width)) || box[0] >= box[2] || box[1] >= box[3]) throw new Error(`${label} must be an integer source bbox [left,top,right,bottom] with positive area`);
  return [...box];
};
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export async function loadEvidenceRun(runPath) {
  const run = resolve(runPath), manifest = await readJson(join(run, 'manifest.json'));
  if (manifest.protocol !== 'luna-local-render-v1') throw new Error('Unsupported run manifest');
  const source = await readFile(join(run, 'source.png'));
  if (hash(source) !== manifest.sourceSha256) throw new Error('Normalized source hash changed');
  const meta = await sharp(source).metadata();
  if (meta.width !== manifest.width || meta.height !== manifest.height) throw new Error('Source dimensions changed');
  return { run, manifest, source, width: manifest.width, height: manifest.height, sourceSha256: manifest.sourceSha256 };
}

async function evidenceDirectory(run) {
  const root = join(run, 'evidence');
  await mkdir(root, { recursive: true });
  await save(join(root, 'README.md'), '# Execution evidence\n\nFrozen inventory, actual source-pixel measurements, and version-specific review records. Evidence hashes detect stale files; visual/crop review statements remain agent declarations, not proof of perception or quality.\n').catch(error => { if (error.code !== 'EEXIST') throw error; });
  return root;
}
async function event(run, row) {
  await evidenceDirectory(run);
  await appendFile(join(run, 'evidence', 'events.jsonl'), `${JSON.stringify({ protocol: PROTOCOL, time: new Date().toISOString(), ...row })}\n`);
}
async function events(run) {
  try { return (await readFile(join(run, 'evidence', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function validateInventory(inventory, ctx) {
  if (!inventory || !Array.isArray(inventory.texts) || !inventory.texts.length || inventory.texts.length > 1000) throw new Error('Inventory requires 1–1000 source text entries');
  const ids = new Set();
  for (const [kind, rows] of [['texts', inventory.texts], ['objects', inventory.objects ?? []]]) {
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error(`Invalid inventory ${kind}`);
    for (const row of rows) {
      labelCheck(row.id);
      if (ids.has(row.id)) throw new Error(`Duplicate inventory ID: ${row.id}`);
      ids.add(row.id);
      boxCheck(row.bbox, ctx.width, ctx.height, row.id);
      nonempty(kind === 'texts' ? row.text : row.kind, `${row.id} ${kind === 'texts' ? 'text' : 'kind'}`);
    }
  }
  if (inventory.ocrDecisions !== undefined && !Array.isArray(inventory.ocrDecisions)) throw new Error('ocrDecisions must be an array');
  if (ctx.manifest.repairRequired) validateStructureInventory(inventory, ctx);
  return inventory;
}

async function validateOcr(inventory, ctx) {
  if (!inventory.ocrEvidence) {
    if (ctx.manifest.evidenceRequired) throw new Error('Required evidence inventory must reference ocrEvidence and review every OCR candidate');
    return null;
  }
  if (!/^evidence\/ocr-[A-Za-z0-9_-]+\.json$/.test(inventory.ocrEvidence)) throw new Error('ocrEvidence must name evidence/ocr-LABEL.json within this run');
  const bytes = await readFile(join(ctx.run, inventory.ocrEvidence)), ocr = JSON.parse(bytes);
  if (ocr.sourceSha256 !== ctx.sourceSha256 || ocr.width !== ctx.width || ocr.height !== ctx.height || !Array.isArray(ocr.candidates)) throw new Error('OCR evidence source hash, dimensions or candidates do not match this run');
  const candidates = new Map(), textIds = new Map(inventory.texts.map(row => [row.id, row.text]));
  for (const candidate of ocr.candidates) {
    nonempty(candidate.id, 'OCR candidate ID'); nonempty(candidate.text, 'OCR candidate text');
    if (candidates.has(candidate.id)) throw new Error(`Duplicate OCR candidate: ${candidate.id}`);
    boxCheck(candidate.bbox, ctx.width, ctx.height, `OCR ${candidate.id}`); candidates.set(candidate.id, candidate);
  }
  if (!Array.isArray(inventory.ocrDecisions)) throw new Error('OCR evidence requires ocrDecisions for every candidate');
  const decisions = new Set();
  for (const decision of inventory.ocrDecisions) {
    if (!candidates.has(decision.candidateId) || decisions.has(decision.candidateId) || !['accepted', 'corrected', 'rejected'].includes(decision.status)) throw new Error(`Unknown/duplicate OCR candidate decision or status: ${decision.candidateId}`);
    const ids = decision.inventoryIds ?? [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !textIds.has(id))) throw new Error(`OCR decision ${decision.candidateId} has invalid inventoryIds`);
    if (decision.status === 'rejected') nonempty(decision.note, `Rejected OCR ${decision.candidateId} note`);
    else {
      if (!ids.length) throw new Error(`OCR ${decision.candidateId} requires at least one inventory text ID`);
      if (decision.status === 'corrected') nonempty(decision.note, `Corrected OCR ${decision.candidateId} note`);
      if (decision.status === 'accepted' && ![' ', ''].some(separator => normal(ids.map(id => textIds.get(id)).join(separator)) === normal(candidates.get(decision.candidateId).text))) throw new Error(`Accepted OCR ${decision.candidateId} does not match its inventory text; record corrected with a note if OCR is wrong`);
    }
    decisions.add(decision.candidateId);
  }
  const missing = [...candidates.keys()].filter(id => !decisions.has(id));
  if (missing.length) throw new Error(`OCR candidates lack decisions: ${missing.join(', ')}`);
  return { path: inventory.ocrEvidence, sha256: hash(bytes), candidateCount: candidates.size,
    decisionCounts: Object.fromEntries(['accepted', 'corrected', 'rejected'].map(status => [status, inventory.ocrDecisions.filter(row => row.status === status).length])),
    note: 'OCR is an independent candidate list, not exhaustive ground truth; decisions remain agent declarations.' };
}

export async function freezeInventory(runPath, inventoryPath) {
  const ctx = await loadEvidenceRun(runPath);
  const renderEvents = (await readFile(join(ctx.run, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  if (renderEvents.some(row => row.event === 'attempt')) throw new Error('Inventory must be frozen before the first render attempt');
  const inventory = validateInventory(await readJson(resolve(inventoryPath)), ctx), ocr = await validateOcr(inventory, ctx);
  const root = await evidenceDirectory(ctx.run), bytes = json(inventory), inventorySha256 = hash(bytes);
  // Exclusive creation prevents a later draft from silently replacing the inventory.
  await save(join(root, 'inventory.json'), bytes);
  const meta = { protocol: PROTOCOL, frozenAt: new Date().toISOString(), sourceSha256: ctx.sourceSha256,
    inventorySha256, textCount: inventory.texts.length, objectCount: inventory.objects?.length ?? 0, ocr,
    note: 'Human/model source transcription, not an automatically established exhaustive ground truth.' };
  await save(join(root, 'inventory-meta.json'), json(meta));
  await event(ctx.run, { event: 'inventory_frozen', ...meta });
  return { ...meta, inventory: join(root, 'inventory.json') };
}

async function frozenInventory(ctx) {
  const root = join(ctx.run, 'evidence');
  const bytes = await readFile(join(root, 'inventory.json')).catch(error => { if (error.code === 'ENOENT') throw new Error('Evidence requires a frozen source inventory'); throw error; });
  const meta = await readJson(join(root, 'inventory-meta.json'));
  if (meta.sourceSha256 !== ctx.sourceSha256 || meta.inventorySha256 !== hash(bytes)) throw new Error('Frozen inventory is stale or changed');
  if (!(await events(ctx.run)).some(row => row.event === 'inventory_frozen' && row.inventorySha256 === meta.inventorySha256 && row.sourceSha256 === ctx.sourceSha256)) throw new Error('Frozen inventory has no matching execution event');
  let activeBytes = bytes, activeMeta = meta;
  for (const revision of (await events(ctx.run)).filter(row => row.event === 'inventory_amended')) {
    labelCheck(revision.label);
    const revisionPath = join(root, 'revisions', revision.label);
    const next = await readFile(join(revisionPath, 'inventory.json')), nextMeta = await readJson(join(revisionPath, 'meta.json'));
    if (nextMeta.previousInventorySha256 !== activeMeta.inventorySha256 || nextMeta.inventorySha256 !== hash(next) || revision.inventorySha256 !== hash(next) || revision.metaSha256 !== hash(json(nextMeta)) || nextMeta.sourceSha256 !== ctx.sourceSha256) throw new Error('Inventory amendment chain is stale or changed');
    activeBytes = next; activeMeta = nextMeta;
  }
  const inventory = validateInventory(JSON.parse(activeBytes), ctx), ocr = await validateOcr(inventory, ctx);
  if (ocr?.sha256 !== activeMeta.ocr?.sha256) throw new Error('Frozen OCR evidence is stale or changed');
  return { inventory, meta: activeMeta };
}

// Read-only access to the validated amendment chain; callers must not rebuild
// an inventory from the first frozen file after a source correction.
export async function readActiveInventory(runPath) {
  return frozenInventory(await loadEvidenceRun(runPath));
}

const strictObjectReview = ctx => ctx.manifest.reviewProtocol === 'object-review-v1';
const observationKey = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '') : '';
function usefulObservation(value) {
  if (typeof value !== 'string' || [...value.trim()].length < 8 || value.length > 10000) return false;
  // This catches empty stock acceptance, not deceptive or incorrect prose.
  return !/^(?:主体完整(?:可见)?|图标完整(?:可见)?|无问题|检查通过|没有问题|与原图一致|完整无截断|looks?good|noissues?|nodifference|allgood|(?:the)?(?:full|entire|complete)?(?:icon|subject)(?:is)?(?:fully)?(?:visible|complete|intact))[.!。！]*$/iu.test(observationKey(value));
}
function withinEvidenceBox(value, expected, ctx) {
  try {
    const box = boxCheck(value, ctx.width, ctx.height, 'Observation bbox');
    return box[0] >= expected[0] && box[1] >= expected[1] && box[2] <= expected[2] && box[3] <= expected[3];
  } catch { return false; }
}

// An evidence-completeness gate. Pixel warnings are risk signals; the model
// still owns the semantic verdict. Missing evidence is never a new defect.
function objectReviewChecks(ctx, evidence, cropReviews) {
  const signatures = new Map(), rows = evidence.items.map(item => {
    const submitted = cropReviews.get(item.id), missing = [], decisions = [], edgeChecks = [];
    const require = (condition, code) => { if (!condition) missing.push(code); };
    require(Boolean(submitted), 'missing_crop_review');
    require(submitted?.evidenceManifestSha256 === evidence.manifestSha256, 'missing_or_stale_evidence_manifest');
    require(submitted?.comparisonSha256 === item.comparison.sha256, 'missing_or_stale_three_column_evidence');
    const inspect = (input, expected, kind, id) => {
      const errors = [];
      if (!input) errors.push('missing_decision');
      else {
        if (!['benign', 'issue', 'pending'].includes(input.status)) errors.push('invalid_decision');
        if (input.status !== 'pending') {
          if (!usefulObservation(input.sourceObservation)) errors.push('source_observation_required');
          if (!usefulObservation(input.renderObservation)) errors.push('render_observation_required');
          if (!withinEvidenceBox(input.bbox, expected.bbox, ctx)) errors.push('observation_bbox_outside_evidence');
        }
        if (kind === 'removed-band' && input.sha256 !== expected.sha256) errors.push('missing_or_stale_removed_band');
      }
      const checked = { kind, id, status: input?.status ?? 'pending', bbox: input?.bbox ?? null, sourceObservation: input?.sourceObservation ?? null,
        renderObservation: input?.renderObservation ?? null, errors };
      if (input && input.status !== 'pending' && !errors.length) {
        const signature = `${observationKey(input.sourceObservation)}|${observationKey(input.renderObservation)}`;
        if (!signatures.has(signature)) signatures.set(signature, []);
        signatures.get(signature).push({ itemId: item.id, checked });
      }
      decisions.push(checked);
      if (errors.length) missing.push(`${kind}:${id}:${errors.join(',')}`);
      return checked;
    };
    const edges = Array.isArray(submitted?.edgeObservations) ? submitted.edgeObservations : [];
    for (const edge of item.edges) {
      const entries = edges.filter(row => row?.side === edge.side), input = entries[0], errors = [];
      if (entries.length !== 1) errors.push('one_observation_per_edge_required');
      if (input?.sha256 !== edge.sha256) errors.push('missing_or_stale_edge_evidence');
      if (!usefulObservation(input?.sourceObservation)) errors.push('source_observation_required');
      if (!usefulObservation(input?.renderObservation)) errors.push('render_observation_required');
      const checked = { kind: 'edge', id: edge.side, side: edge.side, errors, sourceObservation: input?.sourceObservation ?? null, renderObservation: input?.renderObservation ?? null };
      edgeChecks.push(checked);
      if (!errors.length) {
        const signature = `${observationKey(input.sourceObservation)}|${observationKey(input.renderObservation)}`;
        if (!signatures.has(signature)) signatures.set(signature, []);
        signatures.get(signature).push({ itemId: item.id, checked });
      }
      if (errors.length) missing.push(`edge:${edge.side}:${errors.join(',')}`);
    }
    if (edges.some(row => !item.edges.some(edge => edge.side === row?.side))) missing.push('unknown_edge_observation');
    for (const [field, expectedRows, idField, kind] of [
      ['warningDecisions', item.warnings, 'warningId', 'warning'],
      ['removedBandDecisions', item.removedBands, 'id', 'removed-band'],
    ]) {
      const inputs = Array.isArray(submitted?.[field]) ? submitted[field] : [];
      for (const expected of expectedRows) {
        const entries = inputs.filter(row => row?.[idField] === expected.id);
        if (entries.length > 1) missing.push(`${kind}:${expected.id}:duplicate_decision`);
        inspect(entries[0], expected, kind, expected.id);
      }
      if (inputs.some(row => !expectedRows.some(expected => expected.id === row?.[idField]))) missing.push(`${kind}:unknown_decision`);
    }
    return { id: item.id, bbox: item.bbox, warnings: item.warnings, comparison: item.comparison, edges: item.edges, removedBands: item.removedBands,
      agentReview: submitted ?? null, objectReview: { evidenceManifestSha256: evidence.manifestSha256, missing, edgeChecks, decisions } };
  });
  // Identical generic verdicts cannot batch-dismiss distinct automatic risks.
  // Reusing prose for a warning and its matching removed-band evidence on the
  // same icon is harmless; distinct warnings or distinct icons need specificity.
  for (const matches of signatures.values()) if (matches.length > 1 &&
    (new Set(matches.map(row => row.itemId)).size > 1 || matches.filter(row => row.checked.kind === 'warning').length > 1 || matches.filter(row => row.checked.kind === 'edge').length > 1)) {
    for (const { itemId, checked } of matches) {
      checked.errors.push('repeated_warning_template');
      rows.find(row => row.id === itemId).objectReview.missing.push(`${checked.kind}:${checked.id}:repeated_warning_template`);
    }
  }
  for (const row of rows) {
    const check = row.objectReview;
    check.pending = row.agentReview?.status === 'pending' || check.decisions.some(item => item.status === 'pending');
    check.declaredIssue = row.agentReview?.status === 'issue' || check.decisions.some(item => item.status === 'issue');
    check.acceptanceEligible = row.agentReview?.status === 'accepted' && !check.missing.length && !check.pending && !check.declaredIssue;
    check.status = check.missing.length || check.pending ? 'incomplete' : check.declaredIssue ? 'issue' : check.acceptanceEligible ? 'accepted' : 'incomplete';
  }
  return rows;
}

export function inspectObjectCropReview(item, row, bundle) {
  return objectReviewChecks({ width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
    { ...bundle, items: [item] }, new Map(row ? [[item.id, row]] : []))[0].objectReview;
}

async function validateStoredObjectReview(ctx, version, report) {
  if (!strictObjectReview(ctx)) return;
  const evidence = await loadIconEvidence(ctx.run, version);
  if (report.reviewProtocol !== 'object-review-v1' || report.iconEvidenceManifestSha256 !== evidence.manifestSha256) throw new Error('Object review evidence is missing, stale or changed');
  const checks = objectReviewChecks(ctx, evidence, new Map(report.cropChecks.map(row => [row.id, row.agentReview])));
  if (checks.length !== report.cropChecks.length || checks.some(row => hash(json(row.objectReview)) !== hash(json(report.cropChecks.find(saved => saved.id === row.id)?.objectReview)))) throw new Error('Object review gate results are missing or changed');
}

function rgbColor(value) {
  if (!/^#[0-9a-f]{6}$/i.test(value ?? '')) throw new Error('Measurement color must be #RRGGBB');
  return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
}
function validateSpec(input, ctx) {
  if (!input || !['dark', 'color', 'difference'].includes(input.mode)) throw new Error('Measurement mode must be dark, color or difference');
  const spec = { roi: boxCheck(input.roi, ctx.width, ctx.height, 'Measurement roi'), purpose: nonempty(input.purpose, 'Measurement purpose'), mode: input.mode };
  for (const key of ['threshold', 'tolerance']) if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 255)) throw new Error(`${key} must be in [0,255]`);
  if (input.mode === 'dark') spec.threshold = input.threshold ?? 200;
  else { spec.tolerance = input.tolerance ?? 20; if (input.color !== undefined || input.mode === 'color') { rgbColor(input.color); spec.color = input.color.toLowerCase(); } }
  return spec;
}

async function pixelMeasurement(ctx, spec) {
  const [left, top, right, bottom] = spec.roi, width = right - left, height = bottom - top;
  const roi = await sharp(ctx.source).extract({ left, top, width, height }).png().toBuffer();
  const raw = await sharp(roi).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer();
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  const backgroundRgb = spec.color ? rgbColor(spec.color) : [0, 1, 2].map(c => corners.map(p => raw[p * 3 + c]).sort((a, b) => a - b)[2]);
  const edges = { left: 0, top: 0, right: 0, bottom: 0 }, colors = new Map();
  let count = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 3, rgb = [raw[p], raw[p + 1], raw[p + 2]], distance = Math.max(...rgb.map((v, i) => Math.abs(v - backgroundRgb[i])));
    const matching = spec.mode === 'dark' ? .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] < spec.threshold : spec.mode === 'color' ? distance <= spec.tolerance : distance > spec.tolerance;
    const color = `#${rgb.map(v => (Math.round(v / 16) * 16 > 255 ? 255 : Math.round(v / 16) * 16).toString(16).padStart(2, '0')).join('')}`;
    colors.set(color, (colors.get(color) ?? 0) + 1);
    if (!matching) continue;
    count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    if (!x) edges.left++; if (!y) edges.top++; if (x === width - 1) edges.right++; if (y === height - 1) edges.bottom++;
  }
  if (!count || count === width * height) throw new Error('Measurement mask must contain both matching and nonmatching source pixels; blank/uniform masks do not establish bounds');
  const pad = Math.max(12, Math.round(Math.max(width, height) * .10));
  const contextBox = [Math.max(0, left - pad), Math.max(0, top - pad), Math.min(ctx.width, right + pad), Math.min(ctx.height, bottom + pad)];
  const cw = contextBox[2] - contextBox[0], ch = contextBox[3] - contextBox[1];
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}"><rect x="${left - contextBox[0]}" y="${top - contextBox[1]}" width="${width}" height="${height}" fill="none" stroke="#ef4444" stroke-width="1"/><rect x="0" y="0" width="${Math.min(cw, 360)}" height="17" fill="white" fill-opacity=".9"/><text x="3" y="12" font-size="11" font-family="Arial" fill="black">ROI ${spec.roi.join(', ')} — source coordinates</text></svg>`;
  const contextPng = await sharp(ctx.source).extract({ left: contextBox[0], top: contextBox[1], width: cw, height: ch }).composite([{ input: Buffer.from(overlay) }]).png().toBuffer();
  return { roi, contextPng, values: { pixelCount: width * height, matchingPixelCount: count,
    foregroundBbox: [left + minX, top + minY, left + maxX + 1, top + maxY + 1], edgeCounts: edges,
    foregroundTouchesRoi: Object.values(edges).some(Boolean), backgroundRgb: spec.mode === 'dark' ? null : backgroundRgb,
    dominantQuantizedColors: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([color, pixels]) => ({ color, pixels })), contextBox,
    note: 'A measured pixel mask; its bbox and boundary contacts do not identify semantic objects or prove completeness. Alpha is composited on white for measurement.' } };
}

export async function measureSource(runPath, specPath, label) {
  labelCheck(label);
  const ctx = await loadEvidenceRun(runPath), spec = validateSpec(await readJson(resolve(specPath)), ctx);
  const measured = await pixelMeasurement(ctx, spec);
  const root = await evidenceDirectory(ctx.run), path = join(root, 'measurements', label);
  await mkdir(join(root, 'measurements'), { recursive: true }); await mkdir(path);
  const result = { protocol: PROTOCOL, type: 'pixel_measurement', createdAt: new Date().toISOString(), label,
    sourceSha256: ctx.sourceSha256, specSha256: hash(json(spec)), spec, ...measured.values,
    roiSha256: hash(measured.roi), contextSha256: hash(measured.contextPng) };
  await save(join(path, 'roi.png'), measured.roi); await save(join(path, 'context.png'), measured.contextPng);
  const bytes = json(result); await save(join(path, 'measurement.json'), bytes);
  await event(ctx.run, { event: 'pixel_measurement', label, sourceSha256: ctx.sourceSha256, specSha256: result.specSha256, resultSha256: hash(bytes) });
  return { ...result, directory: path, roi: join(path, 'roi.png'), context: join(path, 'context.png') };
}

export async function assertEvidenceReady(runPath) {
  const ctx = await loadEvidenceRun(runPath), frozen = await frozenInventory(ctx), log = await events(ctx.run), specs = new Set(), measurements = [];
  for (const record of log.filter(row => row.event === 'pixel_measurement')) {
    labelCheck(record.label);
    const path = join(ctx.run, 'evidence', 'measurements', record.label), bytes = await readFile(join(path, 'measurement.json'));
    const measured = JSON.parse(bytes);
    if (hash(bytes) !== record.resultSha256 || measured.sourceSha256 !== ctx.sourceSha256 || record.sourceSha256 !== ctx.sourceSha256 || measured.specSha256 !== hash(json(validateSpec(measured.spec, ctx))) || measured.specSha256 !== record.specSha256) throw new Error(`Stale or changed measurement: ${record.label}`);
    if (hash(await readFile(join(path, 'roi.png'))) !== measured.roiSha256 || hash(await readFile(join(path, 'context.png'))) !== measured.contextSha256) throw new Error(`Measurement images changed: ${record.label}`);
    if (!(measured.matchingPixelCount > 0 && measured.matchingPixelCount < measured.pixelCount)) throw new Error(`Invalid pixel evidence: ${record.label}`);
    // Relabeling the same mask purpose is not a second measurement.
    const { purpose, ...pixelSpec } = measured.spec;
    specs.add(hash(json(pixelSpec))); measurements.push(record.label);
  }
  if (specs.size < 2) throw new Error(`Evidence requires at least 2 distinct actual pixel measurements; found ${specs.size}`);
  return { sourceSha256: ctx.sourceSha256, inventorySha256: frozen.meta.inventorySha256, distinctMeasurements: specs.size, measurements };
}

async function loadVersion(ctx, version) {
  versionCheck(version, ctx.manifest.maxRenderAttempts);
  const path = join(ctx.run, version), [sceneBytes, preview, stats, auditBytes, svg] = await Promise.all([
    readFile(join(path, 'scene.json')), readFile(join(path, 'preview.png')), readJson(join(path, 'stats.json')), readFile(join(path, 'crop-audit.json')), readFile(join(path, 'result.svg'))]);
  if (stats.sourceSha256 !== ctx.sourceSha256 || hash(sceneBytes) !== stats.sceneSha256 || hash(preview) !== stats.previewSha256 || hash(svg) !== stats.svgSha256) throw new Error('Render artifacts or source changed since rendering');
  return { path, scene: JSON.parse(sceneBytes), stats, audit: JSON.parse(auditBytes), hashes: { sceneSha256: hash(sceneBytes), previewSha256: hash(preview), svgSha256: hash(svg), cropAuditSha256: hash(auditBytes) } };
}

async function cropContacts(ctx, images, audit) {
  if (!images.length) return { rows: [], sheet: null };
  const { data } = await sharp(ctx.source).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = 660, rowHeight = 190, height = 35 + images.length * rowHeight, overlays = [], labels = ['<text x="10" y="21" font-size="13">Expanded source context (green bbox) / actual adopted crop</text>'], rows = [];
  const pixel = (x, y) => [...data.subarray((y * ctx.width + x) * 3, (y * ctx.width + x) * 3 + 3)];
  const different = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) > 12;
  for (const [index, element] of images.entries()) {
    const box = boxCheck(element.bbox_px, ctx.width, ctx.height, element.id), [l, t, r, b] = box, counts = { left: 0, top: 0, right: 0, bottom: 0 };
    const pad = Math.max(12, Math.round(Math.max(r - l, b - t) * .20)), context = [Math.max(0, l - pad), Math.max(0, t - pad), Math.min(ctx.width, r + pad), Math.min(ctx.height, b + pad)];
    const corners = [[context[0], context[1]], [context[2] - 1, context[1]], [context[0], context[3] - 1], [context[2] - 1, context[3] - 1]].map(([x, y]) => pixel(x, y));
    const background = [0, 1, 2].map(c => corners.map(rgb => rgb[c]).sort((a, b) => a - b)[2]), foreground = { left: 0, top: 0, right: 0, bottom: 0 };
    for (let y = t; y < b; y++) { if (l > 0 && different(pixel(l, y), pixel(l - 1, y))) counts.left++; if (r < ctx.width && different(pixel(r - 1, y), pixel(r, y))) counts.right++; }
    for (let x = l; x < r; x++) { if (t > 0 && different(pixel(x, t), pixel(x, t - 1))) counts.top++; if (b < ctx.height && different(pixel(x, b - 1), pixel(x, b))) counts.bottom++; }
    for (let y = t; y < b; y++) { if (different(pixel(l, y), background)) foreground.left++; if (different(pixel(r - 1, y), background)) foreground.right++; }
    for (let x = l; x < r; x++) { if (different(pixel(x, t), background)) foreground.top++; if (different(pixel(x, b - 1), background)) foreground.bottom++; }
    const item = audit.items.find(row => row.id === element.id), touchesSourceEdge = l === 0 || t === 0 || r === ctx.width || b === ctx.height;
    const warnings = [];
    if (Object.values(counts).some(Boolean)) warnings.push('Source color changes across at least one crop boundary; inspect for clipping or a deliberate exact boundary.');
    if (Object.values(foreground).some(Boolean)) warnings.push('Nonbackground source pixels touch a crop boundary under the local corner-background estimate; inspect silhouette completeness.');
    if (touchesSourceEdge) warnings.push('Crop reaches the source edge; missing content outside the source cannot be checked.');
    if (item?.status === 'needs_review') warnings.push(`Automatic icon check unresolved: ${item.reason}`);
    if (!item?.evidence?.checked) warnings.push('Automatic icon segmentation did not check this image kind; visual review is required.');
    rows.push({ id: element.id, kind: element.kind, bbox: box, sourceBoundaryColorChangeCounts: counts, sourceBoundaryForegroundCounts: foreground, estimatedContextBackgroundRgb: background, touchesSourceEdge, automaticStatus: item?.status ?? 'missing', warnings });
    const y = 35 + index * rowHeight;
    labels.push(`<text x="10" y="${y + 16}" font-size="12">${xml(element.id)} (${xml(element.kind)}) [${box.join(', ')}]</text>`);
    for (const [cell, region] of [context, box].entries()) {
      const rw = region[2] - region[0], rh = region[3] - region[1], scale = Math.min(310 / rw, 155 / rh), dw = Math.max(1, Math.round(rw * scale)), dh = Math.max(1, Math.round(rh * scale));
      let crop = await sharp(ctx.source).extract({ left: region[0], top: region[1], width: rw, height: rh }).resize(dw, dh).png().toBuffer();
      if (cell === 0) crop = await sharp(crop).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${dw}" height="${dh}"><rect x="${(l - region[0]) * dw / rw}" y="${(t - region[1]) * dh / rh}" width="${(r - l) * dw / rw}" height="${(b - t) * dh / rh}" fill="none" stroke="#16a34a" stroke-width="1.5"/></svg>`) }]).png().toBuffer();
      overlays.push({ input: crop, left: 10 + cell * 330 + Math.floor((310 - dw) / 2), top: y + 25 + Math.floor((155 - dh) / 2) });
    }
  }
  overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="Arial" fill="#111827">${labels.join('')}</g></svg>`), left: 0, top: 0 });
  return { rows, sheet: await sharp({ create: { width, height, channels: 4, background: '#fff' } }).composite(overlays).png().toBuffer() };
}

export async function reviewVersion(runPath, version, reviewPath, label) {
  labelCheck(label);
  const ctx = await loadEvidenceRun(runPath), { inventory, meta } = await frozenInventory(ctx), rendered = await loadVersion(ctx, version), review = await readJson(resolve(reviewPath));
  if (!Array.isArray(review.mappings) || !Array.isArray(review.cropReviews)) throw new Error('Review requires mappings and cropReviews arrays');
  if (review.visualReview?.viewedPreviewSha256 !== rendered.hashes.previewSha256) throw new Error('visualReview viewedPreviewSha256 is missing or stale');
  const visualNotes = review.visualReview.notes;
  if (!(typeof visualNotes === 'string' && visualNotes.trim() || Array.isArray(visualNotes) && visualNotes.length && visualNotes.every(v => typeof v === 'string' && v.trim()))) throw new Error('visualReview notes must be nonempty text or a nonempty text array');
  const elements = new Map(rendered.scene.elements.map(e => [e.id, e])), byInventory = new Map(), inventoryIds = new Set([...inventory.texts, ...(inventory.objects ?? [])].map(e => e.id)), usedText = new Set();
  for (const mapping of review.mappings) {
    if (!inventoryIds.has(mapping.inventoryId) || byInventory.has(mapping.inventoryId)) throw new Error(`Unknown/duplicate inventory mapping: ${mapping.inventoryId}`);
    if (!Array.isArray(mapping.elementIds) || !mapping.elementIds.length || new Set(mapping.elementIds).size !== mapping.elementIds.length || mapping.elementIds.some(id => !elements.has(id))) throw new Error(`Mapping ${mapping.inventoryId} contains missing/duplicate elements`);
    byInventory.set(mapping.inventoryId, mapping.elementIds);
  }
  const texts = inventory.texts.map(row => {
    const ids = byInventory.get(row.id) ?? [], mapped = ids.map(id => elements.get(id));
    for (const e of mapped.filter(e => e.type === 'text')) { if (usedText.has(e.id)) throw new Error(`Native text element mapped twice: ${e.id}`); usedText.add(e.id); }
    const actual = mapped.filter(e => e.type === 'text').map(e => e.text), matches = mapped.length && mapped.every(e => e.type === 'text') && [actual.join(' '), actual.join('')].some(text => normal(text) === normal(row.text));
    const invisibleElementIds = mapped.filter(e => e.type === 'text' && invisibleTextReasons(e).length).map(e => e.id);
    return { inventoryId: row.id, expected: row.text, elementIds: ids, actual, invisibleElementIds,
      status: !ids.length ? 'missing' : invisibleElementIds.length ? 'invisible' : matches ? 'matched' : 'mismatch' };
  });
  const objects = (inventory.objects ?? []).map(row => ({ inventoryId: row.id, kind: row.kind, elementIds: byInventory.get(row.id) ?? [], status: byInventory.has(row.id) ? 'mapped_agent_declaration' : 'missing' }));
  const images = rendered.scene.elements.filter(e => e.type === 'image'), imageIds = new Set(images.map(e => e.id)), cropReviews = new Map();
  for (const row of review.cropReviews) {
    if (!imageIds.has(row.id) || cropReviews.has(row.id) || !(ctx.manifest.repairRequired ? ['accepted', 'issue', 'pending'] : ['accepted', 'issue']).includes(row.status)) throw new Error(`Unknown/duplicate crop ID or invalid status: ${row.id}`);
    nonempty(row.note, `Crop ${row.id} note`); cropReviews.set(row.id, row);
  }
  const iconEvidence = strictObjectReview(ctx) ? await ensureIconEvidence(ctx.run, version) : null;
  const contacts = iconEvidence ? { sheet: null } : await cropContacts(ctx, images, rendered.audit);
  const cropRows = iconEvidence ? objectReviewChecks(ctx, iconEvidence, cropReviews) : contacts.rows.map(row => ({ ...row, agentReview: cropReviews.get(row.id) ?? null }));
  const missingTexts = texts.filter(row => row.status === 'missing').map(row => row.inventoryId), mismatchedTexts = texts.filter(row => row.status === 'mismatch').map(row => row.inventoryId), missingObjects = objects.filter(row => row.status === 'missing').map(row => row.inventoryId);
  const invisibleTexts = rendered.scene.elements.filter(e => e.type === 'text').map(e => ({ id: e.id, text: e.text,
    inventoryIds: texts.filter(row => row.elementIds.includes(e.id)).map(row => row.inventoryId), reasons: invisibleTextReasons(e) })).filter(row => row.reasons.length);
  const extraTexts = rendered.scene.elements.filter(e => e.type === 'text' && !usedText.has(e.id)).map(e => ({ id: e.id, text: e.text, invisibleReasons: invisibleTextReasons(e) })), missingCropReviews = images.filter(e => !cropReviews.has(e.id)).map(e => e.id);
  const issues = mismatchedTexts.length + extraTexts.length + invisibleTexts.length + cropRows.filter(row => row.warnings.length || row.agentReview?.status === 'issue').length;
  const incomplete = missingTexts.length || missingObjects.length || missingCropReviews.length || texts.some(row => row.status === 'invisible');
  const structure = ctx.manifest.repairRequired ? checkStructure(inventory, rendered.scene, review, ctx) : null;
  const actualDefects = [...texts.filter(row => row.status !== 'matched' && (!strictObjectReview(ctx) || row.status !== 'missing')).map(row => `text:${row.inventoryId}:${row.status}`),
    ...invisibleTexts.map(row => `invisible:${row.id}`), ...cropRows.filter(row => iconEvidence ? row.objectReview.declaredIssue : row.agentReview?.status === 'issue').map(row => `crop:${row.id}`),
    ...(structure?.issues ?? []).filter(row => !row.incomplete).map(row => row.id)];
  const reviewIncomplete = Boolean(incomplete || cropRows.some(row => iconEvidence ? row.objectReview.status === 'incomplete' : row.agentReview?.status === 'pending') || (structure?.issues ?? []).some(row => row.incomplete));
  const result = { protocol: PROTOCOL, createdAt: new Date().toISOString(), label, version, sourceSha256: ctx.sourceSha256, inventorySha256: meta.inventorySha256, ...rendered.hashes,
    status: ctx.manifest.repairRequired ? (reviewIncomplete ? 'incomplete' : actualDefects.length ? 'complete_with_issues' : 'complete') : incomplete ? 'incomplete' : issues ? 'complete_with_issues' : 'complete', acceptance: 'pending', qualityStatus: 'not_independently_verified',
    textChecks: texts, objectChecks: objects, missingTexts, mismatchedTexts, invisibleTexts, missingObjects, extraTexts, missingCropReviews, cropChecks: cropRows,
    visualReview: { ...review.visualReview, evidenceType: 'agent_declaration_only' },
    limitations: ['Text completeness is relative to the frozen agent-transcribed inventory, which can itself omit source content.', 'Text visibility checks reject definite zero opacity/paint/size or empty display content; they do not establish contrast, glyph availability, location, occlusion or legibility.', 'Text matches do not validate location, typeface, style, overlap or legibility.', 'Object mappings and visual/crop reviews are agent declarations. Boundary warnings are pixel evidence, not semantic clipping verdicts.'] };
  if (structure || iconEvidence) Object.assign(result, { ...(structure ? { structure } : {}), actualDefects, reviewIncomplete });
  if (iconEvidence) Object.assign(result, { reviewProtocol: 'object-review-v1', iconEvidenceManifestSha256: iconEvidence.manifestSha256,
    iconEvidenceDirectory: iconEvidence.directory, objectReviewLimitation: 'Hash, per-edge observation, local warning decisions and duplicate templates are checked. Semantic correctness and whether evidence was actually viewed remain agent declarations.' });
  const root = await evidenceDirectory(ctx.run), path = join(root, 'reviews', label);
  await mkdir(join(root, 'reviews'), { recursive: true }); await mkdir(path);
  await save(join(path, 'submitted-review.json'), json(review));
  if (contacts.sheet) { result.cropContactSheetSha256 = hash(contacts.sheet); await save(join(path, 'crop-contact-sheet.png'), contacts.sheet); }
  if (structure) result.structureContactSheets = await structureContacts(ctx, rendered, iconEvidence ? structure.reviewRegions.filter(row => row.kind !== 'icon') : structure.reviewRegions, path);
  const bytes = json(result); await save(join(path, 'review.json'), bytes);
  await event(ctx.run, { event: 'version_review', label, version, sourceSha256: ctx.sourceSha256, reviewSha256: hash(bytes), status: result.status });
  if (ctx.manifest.repairRequired) {
    await autoRegisterReviewIssues(ctx, rendered, inventory, result);
    await writeOpenIssues(ctx);
  }
  return { ...result, report: join(path, 'review.json'), cropContactSheet: contacts.sheet ? join(path, 'crop-contact-sheet.png') : null,
    ...(iconEvidence ? { iconComparisons: iconEvidence.items.map(row => ({ id: row.id, ...row.comparison })) } : {}) };
}

export async function finalizeVersion(runPath, version, label) {
  labelCheck(label); versionCheck(version);
  const ctx = await loadEvidenceRun(runPath), evidence = await assertEvidenceReady(runPath), rendered = await loadVersion(ctx, version), path = join(ctx.run, 'evidence', 'reviews', label);
  const bytes = await readFile(join(path, 'review.json')), report = JSON.parse(bytes);
  if (report.version !== version || report.sourceSha256 !== ctx.sourceSha256 || report.inventorySha256 !== evidence.inventorySha256 || Object.entries(rendered.hashes).some(([k, v]) => report[k] !== v)) throw new Error('Review does not match the final version/source/inventory');
  if (!(await events(ctx.run)).some(row => row.event === 'version_review' && row.label === label && row.reviewSha256 === hash(bytes))) throw new Error('Review changed or lacks its execution event');
  if (report.cropContactSheetSha256 && hash(await readFile(join(path, 'crop-contact-sheet.png'))) !== report.cropContactSheetSha256) throw new Error('Crop contact sheet changed');
  for (const sheet of report.structureContactSheets ?? []) if (hash(await readFile(join(path, sheet.file))) !== sheet.sha256) throw new Error('Structure contact sheet changed');
  await validateStoredObjectReview(ctx, version, report);
  if (ctx.manifest.repairRequired) {
    const renderLog = (await readFile(join(ctx.run, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const latest = (await events(ctx.run)).filter(row => row.event === 'version_review' && row.version === version).at(-1);
    const ledger = await writeOpenIssues(ctx);
    const reasons = [];
    if (renderLog.filter(row => row.event === 'success').at(-1)?.version !== version) reasons.push('The latest successful rendered version is required');
    if (latest?.label !== label) reasons.push('The latest review of this version is required');
    if (report.status !== 'complete' || report.reviewIncomplete || report.actualDefects?.length || (strictObjectReview(ctx) && report.cropChecks.some(row => !row.objectReview?.acceptanceEligible))) reasons.push('Latest review contains missing checks or actual defects');
    if (ledger.openIssues.length) reasons.push(`Open issues must be repaired and rechecked: ${ledger.openIssues.map(row => row.id).join(', ')}`);
    if (reasons.length) { await event(ctx.run, { event: 'finalization_blocked', version, label, reasons }); throw new Error(`Finalization blocked: ${reasons.join('; ')}. See evidence/open-issues.json`); }
  }
  const final = { protocol: PROTOCOL, finalizedAt: new Date().toISOString(), version, reviewLabel: label, status: report.status, acceptance: 'pending', qualityStatus: 'not_independently_verified', evidence,
    ...rendered.hashes, reviewSha256: hash(bytes), missingTexts: report.missingTexts, mismatchedTexts: report.mismatchedTexts, invisibleTexts: report.invisibleTexts ?? [], extraTexts: report.extraTexts, missingObjects: report.missingObjects, missingCropReviews: report.missingCropReviews,
    cropIssueIds: report.cropChecks.filter(row => ctx.manifest.repairRequired ? row.agentReview?.status === 'issue' : row.warnings.length || row.agentReview?.status === 'issue').map(row => row.id), note: 'Finalization records completed checks and disclosed issues; it does not certify visual fidelity or user acceptance.' };
  let finalPath = join(rendered.path, 'final-verification.json');
  try { await save(finalPath, json(final)); }
  catch (error) {
    if (!ctx.manifest.repairRequired || error.code !== 'EEXIST') throw error;
    finalPath = join(rendered.path, `final-verification-${label}.json`); await save(finalPath, json(final));
  }
  await event(ctx.run, { event: 'finalized', version, label, status: final.status, finalPath, finalSha256: hash(json(final)) });
  if (ctx.manifest.repairRequired) await writeOpenIssues(ctx);
  return { ...final, report: finalPath };
}

// Issue files and resolution files are immutable. The ledger is reconstructed
// from their hash-bound events; open-issues.json is only a regenerable summary.
async function issueLedger(ctx) {
  const rows = new Map();
  for (const record of await events(ctx.run)) {
    if (!['issues_registered', 'issues_resolved'].includes(record.event)) continue;
    labelCheck(record.label);
    const path = record.event === 'issues_registered' ? join(ctx.run, 'evidence', 'issues', record.label, 'issues.json') : join(ctx.run, 'evidence', 'resolutions', record.label, 'resolved.json');
    const bytes = await readFile(path), item = JSON.parse(bytes);
    if (hash(bytes) !== record.recordSha256 || item.sourceSha256 !== ctx.sourceSha256) throw new Error('Issue or resolution evidence changed');
    if (record.event === 'issues_registered') for (const issue of item.issues) {
      if (rows.has(issue.id)) throw new Error(`Duplicate persistent issue ID: ${issue.id}`);
      rows.set(issue.id, { ...issue, status: 'open', registeredLabel: record.label });
    } else for (const resolution of item.resolutions) {
      const issue = rows.get(resolution.issueId);
      if (!issue || issue.status !== 'open') throw new Error(`Unknown or already resolved ledger issue: ${resolution.issueId}`);
      Object.assign(issue, { status: 'resolved', resolution: { ...resolution, label: record.label, version: item.version } });
    }
  }
  return [...rows.values()];
}
async function writeOpenIssues(ctx) {
  const issues = await issueLedger(ctx), result = { protocol: PROTOCOL, updatedAt: new Date().toISOString(), sourceSha256: ctx.sourceSha256,
    status: issues.some(row => row.status === 'open') ? 'repair_required' : 'no_open_issues',
    openIssues: issues.filter(row => row.status === 'open'), resolvedIssues: issues.filter(row => row.status === 'resolved'),
    limitation: 'An empty ledger means no known unresolved issue; it is not evidence that every source defect was detected.' };
  await evidenceDirectory(ctx.run); await writeFile(join(ctx.run, 'evidence', 'open-issues.json'), json(result));
  const log = await events(ctx.run), lastFinal = log.findLastIndex(row => row.event === 'finalized');
  const reopened = log.slice(lastFinal + 1).some(row => ['issues_registered', 'inventory_amended', 'version_review', 'issues_resolved'].includes(row.event));
  const renderLog = (await readFile(join(ctx.run, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse), lastRendered = renderLog.filter(row => row.event === 'success').at(-1);
  const newerRender = lastFinal >= 0 && lastRendered && lastRendered.version !== log[lastFinal].version;
  await writeFile(join(ctx.run, 'evidence', 'current-verification.json'), json({ protocol: PROTOCOL,
    status: lastFinal < 0 ? 'not_finalized' : reopened || newerRender || result.openIssues.length ? 'invalidated_requires_finalization' : 'finalized',
    latestFinalization: lastFinal < 0 ? null : log[lastFinal], openIssueIds: result.openIssues.map(row => row.id),
    note: 'Version final-verification files are immutable historical snapshots. A later issue, inventory amendment, or review invalidates the current finalization until finalized again.' }));
  return result;
}
export async function refreshVerificationState(runPath) { return writeOpenIssues(await loadEvidenceRun(runPath)); }
const inventoryRows = inventory => [...inventory.texts, ...(inventory.objects ?? []), ...(inventory.icons ?? []), ...(inventory.connectors ?? [])];
function inventoryBox(row, ctx) {
  if (row.bbox) return boxCheck(row.bbox, ctx.width, ctx.height, row.id);
  const pad = 12;
  return [Math.max(0, Math.floor(Math.min(row.from[0], row.to[0]) - pad)), Math.max(0, Math.floor(Math.min(row.from[1], row.to[1]) - pad)),
    Math.min(ctx.width, Math.ceil(Math.max(row.from[0], row.to[0]) + pad)), Math.min(ctx.height, Math.ceil(Math.max(row.from[1], row.to[1]) + pad))];
}
async function rawPatch(png, roi) {
  return sharp(png).extract({ left: roi[0], top: roi[1], width: roi[2] - roi[0], height: roi[3] - roi[1] }).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer();
}
async function registerIssues(ctx, version, submitted, label, automatic = false) {
  labelCheck(label);
  if (!['luna', 'independent'].includes(submitted.reviewer)) throw new Error('Issue reviewer must be luna or independent (a declared role, not verified identity)');
  if (!Array.isArray(submitted.issues) || !submitted.issues.length || submitted.issues.length > 1000) throw new Error('issues must contain 1–1000 entries');
  const rendered = await loadVersion(ctx, version), { inventory, meta } = await frozenInventory(ctx), known = new Set((await issueLedger(ctx)).map(row => row.id));
  const inventoryById = new Map(inventoryRows(inventory).map(row => [row.id, row]));
  const elements = new Map(rendered.scene.elements.map(row => [row.id, row])), preview = await readFile(join(rendered.path, 'preview.png'));
  const issues = [];
  for (const input of submitted.issues) {
    labelCheck(input.id); if (known.has(input.id)) throw new Error(`Duplicate issue ID: ${input.id}`); known.add(input.id);
    if (!['critical', 'minor'].includes(input.severity)) throw new Error(`Invalid issue severity: ${input.id}`);
    labelCheck(input.kind); nonempty(input.description, 'Issue description');
    if (input.inventoryId !== undefined && !inventoryById.has(input.inventoryId)) throw new Error(`Unknown issue inventory ID: ${input.inventoryId}`);
    if (!Array.isArray(input.elementIds) || new Set(input.elementIds).size !== input.elementIds.length || input.elementIds.some(id => !elements.has(id))) throw new Error(`Issue ${input.id} elementIds must identify unique existing elements; use an empty array for a missing object`);
    const roi = boxCheck(input.roi, ctx.width, ctx.height, `Issue ${input.id} ROI`);
    issues.push({ id: input.id, kind: input.kind, inventoryId: input.inventoryId, elementIds: [...input.elementIds], roi, description: input.description,
      severity: input.severity, ...(input.code ? { code: input.code } : {}), automatic, reviewer: submitted.reviewer,
      ...(input.semanticKey && automatic ? { semanticKey: input.semanticKey } : {}),
      discoveredAt: new Date().toISOString(), discoveredVersion: version, inventorySha256: meta.inventorySha256,
      ...rendered.hashes, sourcePatchSha256: hash(await rawPatch(ctx.source, roi)), discoveredPatchSha256: hash(await rawPatch(preview, roi)),
      discoveryElements: input.elementIds.map(id => elements.get(id)) });
  }
  const root = await evidenceDirectory(ctx.run), path = join(root, 'issues', label);
  await mkdir(join(root, 'issues'), { recursive: true }); await mkdir(path);
  const result = { protocol: PROTOCOL, createdAt: new Date().toISOString(), version, sourceSha256: ctx.sourceSha256, issues,
    note: 'Issue discovery is a model/reviewer declaration with bound artifacts; role is not cryptographically verified.' };
  const bytes = json(result); await save(join(path, 'issues.json'), bytes);
  await event(ctx.run, { event: 'issues_registered', label, version, recordSha256: hash(bytes), issueIds: issues.map(row => row.id) });
  await writeOpenIssues(ctx); return { ...result, report: join(path, 'issues.json') };
}
export async function registerVersionIssues(runPath, version, issuesPath, label) {
  return registerIssues(await loadEvidenceRun(runPath), version, await readJson(resolve(issuesPath)), label);
}
async function autoRegisterReviewIssues(ctx, rendered, inventory, report) {
  const existing = await issueLedger(ctx), byId = new Map(inventoryRows(inventory).map(row => [row.id, row])), proposals = [];
  const add = (base, kind, inventoryId, elementIds, roi, description, code) => {
    const ids = elementIds.filter(id => rendered.scene.elements.some(e => e.id === id)).sort();
    // Generic reviewer-declared issues need a defect description and location,
    // whereas deterministic codes already identify the condition. A different
    // warning on the same icon must not be merged with an unrelated open issue.
    const semanticKey = strictObjectReview(ctx) ? hash(json({ target: inventoryId ?? ids, kind: ['crop', 'icon'].includes(kind) ? 'icon' : kind,
      code: ['declared_issue', 'crop_issue'].includes(code) ? 'declared_issue' : code, ...(inventoryId ? {} : { elementIds: ids }), roi,
      ...(['declared_issue', 'crop_issue'].includes(code) ? { declaration: observationKey(description) } : {}) })) : null;
    const prefix = `auto-${(semanticKey ?? hash(base)).slice(0, 20)}`;
    // Repeated reports cannot erase an open defect. A later regression opens a
    // new occurrence while preserving the prior repair evidence.
    if (existing.some(row => row.id.startsWith(prefix) && row.status === 'open') || proposals.some(row => row.id.startsWith(prefix))) return;
    const occurrence = existing.filter(row => row.id.startsWith(prefix)).length + 1;
    proposals.push({ id: `${prefix}-${occurrence}`, kind, inventoryId, elementIds: ids, roi, description, severity: 'critical', code, ...(semanticKey ? { semanticKey } : {}) });
  };
  for (const row of report.textChecks.filter(row => row.status !== 'matched' && (!strictObjectReview(ctx) || row.status !== 'missing'))) add(`text:${row.inventoryId}`, 'text', row.inventoryId, row.elementIds, inventoryBox(byId.get(row.inventoryId), ctx), `Text ${row.inventoryId} is ${row.status}; expected ${row.expected}`, row.status);
  for (const row of report.cropChecks.filter(row => row.agentReview?.status === 'issue' || row.objectReview?.declaredIssue)) {
    const associated = report.structure?.icons.find(icon => icon.elementIds.includes(row.id));
    const decisions = row.objectReview?.decisions.filter(decision => decision.kind === 'warning' && decision.status === 'issue') ?? [];
    if (decisions.length) for (const decision of decisions) {
      const warning = row.warnings.find(item => item.id === decision.id);
      add(`crop:${row.id}:${decision.id}`, 'crop', associated?.inventoryId, [row.id], warning.bbox,
        `${decision.sourceObservation ?? warning.description} / ${decision.renderObservation ?? 'Reviewer declares a defect; observations require completion.'}`, `warning-${warning.id}`);
    }
    else add(`crop:${row.id}`, 'crop', associated?.inventoryId, [row.id], associated ? inventoryBox(byId.get(associated.inventoryId), ctx) : row.bbox, row.agentReview.note, 'crop_issue');
  }
  for (const row of report.structure?.issues ?? []) {
    if (row.incomplete || !byId.has(row.inventoryId)) continue;
    add(`structure:${row.inventoryId}:${row.code}`, row.kind, row.inventoryId, row.elementIds ?? [], inventoryBox(byId.get(row.inventoryId), ctx), row.message, row.code);
  }
  if (proposals.length) await registerIssues(ctx, report.version, { reviewer: 'luna', issues: proposals }, `review-${hash(report.label).slice(0, 20)}`, true);
}
async function validatedReview(ctx, version, label) {
  labelCheck(label);
  const rendered = await loadVersion(ctx, version), { meta } = await frozenInventory(ctx), path = join(ctx.run, 'evidence', 'reviews', label);
  const bytes = await readFile(join(path, 'review.json')), report = JSON.parse(bytes), log = await events(ctx.run);
  if (report.version !== version || report.sourceSha256 !== ctx.sourceSha256 || report.inventorySha256 !== meta.inventorySha256 || Object.entries(rendered.hashes).some(([key, value]) => report[key] !== value)) throw new Error('Review does not match the current version/source/inventory');
  if (!log.some(row => row.event === 'version_review' && row.label === label && row.reviewSha256 === hash(bytes))) throw new Error('Review changed or lacks its execution event');
  if (report.cropContactSheetSha256 && hash(await readFile(join(path, 'crop-contact-sheet.png'))) !== report.cropContactSheetSha256) throw new Error('Crop contact sheet changed');
  for (const sheet of report.structureContactSheets ?? []) if (hash(await readFile(join(path, sheet.file))) !== sheet.sha256) throw new Error('Structure contact sheet changed');
  await validateStoredObjectReview(ctx, version, report);
  if (log.filter(row => row.event === 'version_review' && row.version === version).at(-1)?.label !== label) throw new Error('Use the latest review for this version');
  return { report, rendered, reviewSha256: hash(bytes) };
}
async function structureContacts(ctx, rendered, regions, path) {
  const preview = await readFile(join(rendered.path, 'preview.png')), results = [];
  for (let first = 0; first < regions.length; first += 20) {
    const rows = regions.slice(first, first + 20), width = 700, rowHeight = 190, height = 35 + rows.length * rowHeight, overlays = [];
    const labels = ['<text x="10" y="22" font-size="13">Source context / rendered context — red rectangle is inventoried region</text>'];
    for (const [i, row] of rows.entries()) {
      const bbox = row.sourceBbox, pad = 18, box = [Math.max(0, Math.floor(bbox[0] - pad)), Math.max(0, Math.floor(bbox[1] - pad)), Math.min(ctx.width, Math.ceil(bbox[2] + pad)), Math.min(ctx.height, Math.ceil(bbox[3] + pad))];
      const rw = box[2] - box[0], rh = box[3] - box[1], scale = Math.min(330 / rw, 155 / rh), dw = Math.max(1, Math.round(rw * scale)), dh = Math.max(1, Math.round(rh * scale)), top = 35 + i * rowHeight;
      labels.push(`<text x="10" y="${top + 17}" font-size="12">${xml(row.inventoryId)} (${xml(row.kind)})</text>`);
      for (const [cell, png] of [ctx.source, preview].entries()) {
        const rect = `<svg xmlns="http://www.w3.org/2000/svg" width="${dw}" height="${dh}"><rect x="${(bbox[0] - box[0]) * dw / rw}" y="${(bbox[1] - box[1]) * dh / rh}" width="${(bbox[2] - bbox[0]) * dw / rw}" height="${(bbox[3] - bbox[1]) * dh / rh}" stroke="#ef4444" stroke-width="1" fill="none"/></svg>`;
        const crop = await sharp(png).extract({ left: box[0], top: box[1], width: rw, height: rh }).resize(dw, dh).composite([{ input: Buffer.from(rect) }]).png().toBuffer();
        overlays.push({ input: crop, left: 10 + cell * 350 + Math.floor((330 - dw) / 2), top: top + 25 + Math.floor((155 - dh) / 2) });
      }
    }
    overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="Arial" fill="#111">${labels.join('')}</g></svg>`), left: 0, top: 0 });
    const bytes = await sharp({ create: { width, height, channels: 4, background: '#fff' } }).composite(overlays).png().toBuffer(), file = `structure-contact-sheet-${String(results.length + 1).padStart(2, '0')}.png`;
    await save(join(path, file), bytes); results.push({ file, sha256: hash(bytes), inventoryIds: rows.map(row => row.inventoryId) });
  }
  return results;
}
export async function assertPreviousReviewed(runPath) {
  const ctx = await loadEvidenceRun(runPath);
  if (!ctx.manifest.repairRequired) return null;
  const renderLog = (await readFile(join(ctx.run, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const previous = renderLog.filter(row => row.event === 'success').at(-1);
  if (!previous) return null;
  const latest = (await events(ctx.run)).filter(row => row.event === 'version_review' && row.version === previous.version).at(-1);
  if (!latest) throw new Error(`Previous successful version ${previous.version} requires a review before another render`);
  await validatedReview(ctx, previous.version, latest.label);
  return { previousVersion: previous.version, reviewLabel: latest.label };
}

async function validateSourceRecheck(ctx, prior, inventory, submitted) {
  if (submitted?.viewedSourceSha256 !== ctx.sourceSha256 || !Array.isArray(submitted.checks) || !submitted.checks.length || submitted.checks.length > 1000) throw new Error('Luna amendment requires sourceRecheck with current viewedSourceSha256 and 1–1000 checks');
  const before = new Map(inventoryRows(prior).map(row => [row.id, row])), after = new Map(inventoryRows(inventory).map(row => [row.id, row]));
  const changedIds = [...new Set([...before.keys(), ...after.keys()])].filter(id => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)));
  const checked = new Set(), records = [], log = await events(ctx.run);
  for (const check of submitted.checks) {
    labelCheck(check.inventoryId); labelCheck(check.measurementLabel); nonempty(check.note, 'Source recheck note');
    if (checked.has(check.inventoryId) || (!before.has(check.inventoryId) && !after.has(check.inventoryId))) throw new Error('Source recheck has a duplicate or unknown inventory ID');
    const path = join(ctx.run, 'evidence', 'measurements', check.measurementLabel), bytes = await readFile(join(path, 'measurement.json')), measured = JSON.parse(bytes);
    if (!log.some(row => row.event === 'pixel_measurement' && row.label === check.measurementLabel && row.resultSha256 === hash(bytes)) || measured.sourceSha256 !== ctx.sourceSha256 || measured.specSha256 !== hash(json(validateSpec(measured.spec, ctx)))) throw new Error('Source recheck measurement is stale, changed or not executed');
    if (check.viewedContextSha256 !== measured.contextSha256 || hash(await readFile(join(path, 'context.png'))) !== measured.contextSha256 || hash(await readFile(join(path, 'roi.png'))) !== measured.roiSha256) throw new Error('Source recheck context/ROI is changed or viewedContextSha256 is missing or stale');
    const context = boxCheck(measured.contextBox, ctx.width, ctx.height, 'Source recheck context');
    for (const item of [before.get(check.inventoryId), after.get(check.inventoryId)].filter(Boolean)) {
      const bbox = item.bbox ?? [Math.min(item.from[0], item.to[0]), Math.min(item.from[1], item.to[1]), Math.max(item.from[0], item.to[0]), Math.max(item.from[1], item.to[1])];
      if (bbox[0] < context[0] || bbox[1] < context[1] || bbox[2] > context[2] || bbox[3] > context[3]) throw new Error(`Source recheck context must contain old and updated bounds for ${item.id}`);
    }
    checked.add(check.inventoryId);
    records.push({ inventoryId: check.inventoryId, measurementLabel: check.measurementLabel, measurementSha256: hash(bytes), viewedContextSha256: check.viewedContextSha256, note: check.note });
  }
  if (changedIds.some(id => !checked.has(id))) throw new Error(`Source recheck requires checks for every changed inventory item: ${changedIds.filter(id => !checked.has(id)).join(', ')}`);
  return { viewedSourceSha256: ctx.sourceSha256, checks: records, limitation: 'Bound source pixels and declared viewing establish an auditable self-recheck, not independent review or semantic truth.' };
}

export async function amendInventory(runPath, amendmentPath, label) {
  labelCheck(label);
  const ctx = await loadEvidenceRun(runPath), prior = await frozenInventory(ctx), request = await readJson(resolve(amendmentPath));
  if (!ctx.manifest.repairRequired) throw new Error('Inventory amendment is available only in closed-loop mode');
  if (!['luna', 'independent'].includes(request.reviewer)) throw new Error('Amendment reviewer must be luna or independent (declared role, not verified identity)');
  nonempty(request.reason, 'Amendment reason'); nonempty(request.evidenceNote, 'Amendment evidenceNote');
  const inventory = validateInventory(request.inventory, ctx), ocr = await validateOcr(inventory, ctx);
  const sourceRecheck = request.reviewer === 'luna' ? await validateSourceRecheck(ctx, prior.inventory, inventory, request.sourceRecheck) : null;
  for (const kind of ['icons', 'objects']) {
    const nextIds = new Set((inventory[kind] ?? []).map(row => row.id));
    for (const row of prior.inventory[kind] ?? []) if (!nextIds.has(row.id)) throw new Error(`Cannot remove ${kind} inventory ID to bypass checks: ${row.id}`);
  }
  const retiredConnectors = (prior.inventory.connectors ?? []).filter(row => !(inventory.connectors ?? []).some(next => next.id === row.id)).map(row => row.id);
  if (retiredConnectors.length || request.retiredConnectorIds?.length) {
    if (!Array.isArray(request.retiredConnectorIds) || retiredConnectors.some(id => !request.retiredConnectorIds.includes(id)) || request.retiredConnectorIds.some(id => !retiredConnectors.includes(id))) throw new Error('Every removed connector ID must be explicitly listed in retiredConnectorIds');
    nonempty(request.retirementReason, 'Connector retirementReason');
  }
  const retired = prior.inventory.texts.filter(row => !inventory.texts.some(next => next.id === row.id)).map(row => row.id);
  if (retired.length) {
    if (!Array.isArray(request.retiredTextIds) || retired.some(id => !request.retiredTextIds.includes(id)) || request.retiredTextIds.some(id => !retired.includes(id))) throw new Error('Every removed text ID must be explicitly listed in retiredTextIds');
    nonempty(request.retirementReason, 'Text retirementReason');
  }
  const root = await evidenceDirectory(ctx.run), path = join(root, 'revisions', label), bytes = json(inventory);
  if (hash(bytes) === prior.meta.inventorySha256) throw new Error('Inventory amendment must actually change the inventory');
  await mkdir(join(root, 'revisions'), { recursive: true }); await mkdir(path);
  const meta = { protocol: PROTOCOL, amendedAt: new Date().toISOString(), sourceSha256: ctx.sourceSha256, previousInventorySha256: prior.meta.inventorySha256,
    inventorySha256: hash(bytes), textCount: inventory.texts.length, objectCount: inventory.objects?.length ?? 0, ocr,
    reason: request.reason, evidenceNote: request.evidenceNote, reviewer: request.reviewer, ...(sourceRecheck ? { sourceRecheck } : {}), retiredTextIds: retired, retiredConnectorIds: retiredConnectors, retirementReason: request.retirementReason,
    note: 'Append-only correction of a source interpretation; prior issues remain open and prior reviews become stale. Reviewer role is a declaration.' };
  await save(join(path, 'inventory.json'), bytes); await save(join(path, 'meta.json'), json(meta));
  await event(ctx.run, { event: 'inventory_amended', label, sourceSha256: ctx.sourceSha256, inventorySha256: meta.inventorySha256, previousInventorySha256: meta.previousInventorySha256, metaSha256: hash(json(meta)) });
  await writeOpenIssues(ctx);
  return { ...meta, path };
}

async function validateInventoryCorrection(ctx, issue, inventory, meta) {
  if (!issue.automatic || !issue.inventoryId || !['text', 'icon', 'connector'].includes(issue.kind)) throw new Error('inventory-correction is limited to automatically detected mismatches against a corrected source inventory');
  if (issue.inventorySha256 === meta.inventorySha256 || !(meta.reviewer === 'independent' || meta.reviewer === 'luna' && meta.sourceRecheck)) throw new Error('inventory-correction requires a later independent or evidenced Luna inventory amendment');
  const roots = [join(ctx.run, 'evidence'), ...(await events(ctx.run)).filter(row => row.event === 'inventory_amended').map(row => join(ctx.run, 'evidence', 'revisions', row.label))];
  let original;
  for (const root of roots) {
    const bytes = await readFile(join(root, 'inventory.json'));
    if (hash(bytes) === issue.inventorySha256) { original = JSON.parse(bytes); break; }
  }
  if (!original) throw new Error('Cannot verify the inventory used at issue discovery');
  const before = inventoryRows(original).find(row => row.id === issue.inventoryId), after = inventoryRows(inventory).find(row => row.id === issue.inventoryId);
  if (!before) throw new Error('Issue inventory item was not present at discovery');
  const fields = issue.kind === 'text' ? ['text'] : issue.kind === 'icon' ? ['bbox', 'representation'] : ['from', 'to', 'heads', 'tolerance'];
  if (after && fields.every(key => JSON.stringify(before[key]) === JSON.stringify(after[key]))) throw new Error('inventory-correction must change the relevant source interpretation, not only notes or unrelated entries');
  if (!after && !((issue.kind === 'text' && meta.retiredTextIds?.includes(issue.inventoryId) || issue.kind === 'connector' && meta.retiredConnectorIds?.includes(issue.inventoryId)) && meta.retirementReason)) throw new Error('Only explicitly retired erroneous text or connector may be absent after inventory correction');
  return { previousInventorySha256: issue.inventorySha256, inventorySha256: meta.inventorySha256, before, after: after ?? null, reason: meta.reason, evidenceNote: meta.evidenceNote, reviewer: meta.reviewer, ...(meta.sourceRecheck ? { sourceRecheck: meta.sourceRecheck } : {}), retired: !after,
    limitation: 'The reviewer role, source interpretation and viewed-patch acceptance are declarations, not a proof of semantic correctness. Luna self-recheck is not independent review.' };
}

function acceptedIssueTarget(issue, report, scene, inventory, allowedRetiredIds = new Set()) {
  const elements = new Map(scene.elements.map(row => [row.id, row]));
  let ids = [...issue.elementIds];
  if (issue.inventoryId) {
    const text = report.textChecks.find(row => row.inventoryId === issue.inventoryId), icon = report.structure?.icons.find(row => row.inventoryId === issue.inventoryId), connector = report.structure?.connectors.find(row => row.inventoryId === issue.inventoryId);
    const check = text ?? icon ?? connector ?? report.objectChecks.find(row => row.inventoryId === issue.inventoryId);
    if (!check || !['matched', 'accepted', 'mapped_agent_declaration'].includes(check.status)) throw new Error(`Issue ${issue.id} target is not accepted in the new review`);
    ids = check.elementIds;
  }
  const waivedRetiredElementIds = ids.filter(id => !elements.has(id) && allowedRetiredIds.has(id));
  ids = ids.filter(id => !waivedRetiredElementIds.includes(id));
  if (!ids.length || ids.some(id => !elements.has(id))) throw new Error(`Issue ${issue.id} target cannot be deleted or remain missing`);
  for (const id of ids) {
    const e = elements.get(id);
    if ((e.opacity ?? 1) <= 0 || (e.type === 'text' && invisibleTextReasons(e).length)) throw new Error(`Issue ${issue.id} target cannot be hidden`);
    const painted = value => /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value ?? '') && (value.length !== 9 || parseInt(value.slice(7), 16) > 0);
    if (!['text', 'image'].includes(e.type) && !painted(e.fill ?? 'none') && !(painted(e.stroke ?? '#000000') && (e.strokeWidth ?? 1) > 0)) throw new Error(`Issue ${issue.id} target cannot have invisible paint`);
    if (e.type === 'image') {
      const checked = report.cropChecks.find(row => row.id === id);
      if (checked?.agentReview?.status !== 'accepted' || report.reviewProtocol === 'object-review-v1' && !checked.objectReview?.acceptanceEligible) throw new Error(`Issue ${issue.id} crop needs an accepted new review with complete object evidence`);
    }
  }
  if (issue.kind === 'crop' && !ids.some(id => elements.get(id).type === 'image') && !(inventory.icons ?? []).some(row => row.id === issue.inventoryId && row.representation === 'vector')) throw new Error(`Issue ${issue.id} crop target cannot disappear`);
  return { targets: ids.map(id => elements.get(id)), waivedRetiredElementIds };
}
async function resolutionPatch(ctx, oldPng, newPng, roi, title) {
  const rw = roi[2] - roi[0], rh = roi[3] - roi[1], width = 960, dh = Math.max(80, Math.min(460, Math.round(rh * Math.min(300 / rw, 440 / rh)))), height = dh + 56;
  const layers = [], labels = ['Source', 'Discovered version', 'Repaired version'];
  for (const [i, png] of [ctx.source, oldPng, newPng].entries()) {
    const b = await sharp(png).extract({ left: roi[0], top: roi[1], width: rw, height: rh }).resize(300, dh, { fit: 'contain', background: '#fff' }).png().toBuffer();
    layers.push({ input: b, left: 10 + i * 320, top: 46 });
  }
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="Arial" fill="#111"><text x="10" y="16" font-size="12">${xml(title)} · ROI ${roi.join(', ')}</text>${labels.map((label, i) => `<text x="${10 + i * 320}" y="36" font-size="12">${label}</text>`).join('')}</g></svg>`), left: 0, top: 0 });
  return sharp({ create: { width, height, channels: 4, background: '#fff' } }).composite(layers).png().toBuffer();
}
const unionBox = boxes => [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
const containsPoint = (box, x, y) => x >= box[0] && y >= box[1] && x < box[2] && y < box[3];
const canonicalElements = rows => rows.slice().sort((a, b) => a.id.localeCompare(b.id)).map(element => Object.fromEntries(Object.entries(element).filter(([key]) => key !== 'reason').sort(([a], [b]) => a.localeCompare(b))));
async function discoveryInventory(ctx, issue) {
  const roots = [join(ctx.run, 'evidence'), ...(await events(ctx.run)).filter(row => row.event === 'inventory_amended').map(row => join(ctx.run, 'evidence', 'revisions', row.label))];
  for (const root of roots) {
    const bytes = await readFile(join(root, 'inventory.json'));
    if (hash(bytes) === issue.inventorySha256) return JSON.parse(bytes);
  }
  throw new Error('Cannot verify the inventory used at issue discovery');
}
// Context is derived from bound artifacts, never a caller-supplied expansion.
// The original ROI and its hashes remain immutable and are checked separately.
async function repairRegion(ctx, issue, targets, inventory) {
  const oldImages = issue.discoveryElements.filter(e => e.type === 'image'), images = targets.filter(e => e.type === 'image');
  if (!['crop', 'icon'].includes(issue.kind) || !oldImages.length && !images.length) return { roi: issue.roi, contextPad: 0, boundaryCrops: null };
  const oldInventory = await discoveryInventory(ctx, issue);
  const sourceBoxes = [oldInventory, inventory].flatMap(value => {
    const item = inventoryRows(value).find(row => row.id === issue.inventoryId);
    return item?.bbox ? [item.bbox] : [];
  });
  const anchor = unionBox([issue.roi, ...sourceBoxes]);
  // A moved/huge crop cannot turn a local issue into an arbitrary whole-image check.
  const allowance = Math.max(24, Math.ceil(Math.max(anchor[2] - anchor[0], anchor[3] - anchor[1]) * .5));
  const cropBoxes = [...oldImages, ...images].map(e => boxCheck(e.bbox_px, ctx.width, ctx.height, 'Adopted crop'));
  // An oversized discovery crop is the defect being repaired and is already
  // hash-bound. Limiting it here would permanently trap its original issue.
  // Only the proposed current footprint must obey the local expansion limit.
  if (images.some(({ bbox_px: b }) => b[0] < anchor[0] - allowance || b[1] < anchor[1] - allowance || b[2] > anchor[2] + allowance || b[3] > anchor[3] + allowance)) throw new Error('Current crop repair exceeds the bounded local source context; inspect the object rather than enlarging a closure crop arbitrarily');
  const bounds = unionBox([anchor, ...cropBoxes]), pad = 8;
  return { roi: [Math.max(0, bounds[0] - pad), Math.max(0, bounds[1] - pad), Math.min(ctx.width, bounds[2] + pad), Math.min(ctx.height, bounds[3] + pad)],
    contextPad: pad, sourceBoxes, adoptedDiscoveryBoxes: oldImages.map(e => e.bbox_px), adoptedCurrentBoxes: images.map(e => e.bbox_px),
    boundaryCrops: oldImages.length && images.length ? { old: oldImages, current: images } : null };
}
async function latestResolutionContext(runPath, version) {
  const ctx = await loadEvidenceRun(runPath);
  const renderLog = (await readFile(join(ctx.run, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  if (renderLog.filter(row => row.event === 'success').at(-1)?.version !== version) throw new Error('Issue closure requires the latest successful rendered version');
  const ledger = await issueLedger(ctx), frozen = await frozenInventory(ctx);
  return { ctx, ledger, ...frozen, allowedRetiredIds: new Set(ledger.filter(row => row.status === 'resolved' && row.resolution?.inventoryCorrection?.retired === true).flatMap(row => row.elementIds)) };
}
async function prepareIssueResolution(state, version, row) {
  const { ctx, ledger, inventory, meta, allowedRetiredIds } = state;
  const issue = ledger.find(issue => issue.id === row.issueId);
  if (!issue || issue.status !== 'open') throw new Error(`Unknown or already resolved issue ID: ${row.issueId}`);
  labelCheck(row.reviewLabel);
  const resolutionType = row.resolutionType ?? 'render-repair';
  if (!['render-repair', 'inventory-correction'].includes(resolutionType)) throw new Error('resolutionType must be render-repair or inventory-correction');
  if (resolutionType === 'render-repair' && Number(version.slice(1)) <= Number(issue.discoveredVersion.slice(1))) throw new Error(`Issue ${issue.id} requires a later rendered version, not the discovery version`);
  if (Number(version.slice(1)) < Number(issue.discoveredVersion.slice(1))) throw new Error('A resolution cannot use an older render');
  const correction = resolutionType === 'inventory-correction' ? await validateInventoryCorrection(ctx, issue, inventory, meta) : null;
  const { report, rendered, reviewSha256 } = await validatedReview(ctx, version, row.reviewLabel);
  const { targets, waivedRetiredElementIds } = correction?.retired ? { targets: [], waivedRetiredElementIds: [] } : acceptedIssueTarget(issue, report, rendered.scene, inventory, allowedRetiredIds);
  if (correction?.retired && rendered.scene.elements.some(element => issue.elementIds.includes(element.id))) throw new Error('A retired erroneous text target must actually be removed from the scene, not hidden');
  const old = await loadVersion(ctx, issue.discoveredVersion);
  if (old.hashes.sceneSha256 !== issue.sceneSha256 || old.hashes.previewSha256 !== issue.previewSha256) throw new Error('Discovery artifacts changed');
  const [oldPng, newPng] = await Promise.all([readFile(join(old.path, 'preview.png')), readFile(join(rendered.path, 'preview.png'))]);
  const originalOld = await rawPatch(oldPng, issue.roi), originalNew = await rawPatch(newPng, issue.roi);
  if (hash(originalOld) !== issue.discoveredPatchSha256 || hash(await rawPatch(ctx.source, issue.roi)) !== issue.sourcePatchSha256) throw new Error('Discovery/source ROI hashes changed');
  const region = await repairRegion(ctx, issue, targets, inventory), oldRaw = await rawPatch(oldPng, region.roi), newRaw = await rawPatch(newPng, region.roi);
  const sourceRaw = await rawPatch(ctx.source, region.roi), width = region.roi[2] - region.roi[0];
  let changedPixels = 0, originalRoiChangedPixels = 0, targetBoundaryChangedPixels = 0;
  for (let p = 0; p < oldRaw.length / 3; p++) {
    if (!oldRaw.subarray(p * 3, p * 3 + 3).some((v, i) => v !== newRaw[p * 3 + i])) continue;
    changedPixels++;
    const x = region.roi[0] + p % width, y = region.roi[1] + Math.floor(p / width);
    if (containsPoint(issue.roi, x, y)) originalRoiChangedPixels++;
    if (region.boundaryCrops) {
      const was = region.boundaryCrops.old.some(e => containsPoint(e.bbox_px, x, y)), now = region.boundaryCrops.current.some(e => containsPoint(e.bbox_px, x, y));
      // With source-aligned image crops, a changed crop footprint must expose or
      // remove source pixels. Context changes alone, reason edits and ID swaps
      // cannot satisfy this gate. This is still not a semantic repair verdict.
      const painted = was && !now ? oldRaw : !was && now ? newRaw : null;
      if (painted && painted.subarray(p * 3, p * 3 + 3).every((v, i) => Math.abs(v - sourceRaw[p * 3 + i]) <= 1)) targetBoundaryChangedPixels++;
    }
  }
  if (!changedPixels && !correction) throw new Error(`Issue ${issue.id} has no actual pixel change within its ROI/review context`);
  const comparableTargets = rows => canonicalElements(rows.filter(element => !waivedRetiredElementIds.includes(element.id)));
  if (!correction && hash(json(comparableTargets(targets))) === hash(json(comparableTargets(issue.discoveryElements)))) throw new Error(`Issue ${issue.id} target elements did not change; unrelated changes or removal of retired elements cannot close it`);
  if (!correction && region.boundaryCrops && !targetBoundaryChangedPixels) throw new Error(`Issue ${issue.id} has no changed source pixels at the target crop boundary; unrelated context changes cannot close it`);
  const record = { issueId: issue.id, resolutionType, ...(correction ? { inventoryCorrection: correction } : {}), reviewLabel: row.reviewLabel, reviewSha256,
    sourceSha256: ctx.sourceSha256, inventorySha256: meta.inventorySha256, ...rendered.hashes, roi: issue.roi, reviewRoi: region.roi,
    regionPolicy: region.contextPad ? 'bound-crop-union-plus-8px-v1' : 'original-issue-roi',
    ...(region.contextPad ? { sourceBoxes: region.sourceBoxes, adoptedDiscoveryBoxes: region.adoptedDiscoveryBoxes, adoptedCurrentBoxes: region.adoptedCurrentBoxes } : {}),
    changedPixels, originalRoiChangedPixels, targetBoundaryChangedPixels: region.boundaryCrops ? targetBoundaryChangedPixels : null,
    sourcePatchSha256: issue.sourcePatchSha256, oldPatchSha256: hash(originalOld), newPatchSha256: hash(originalNew),
    reviewSourcePatchSha256: hash(sourceRaw), reviewOldPatchSha256: hash(oldRaw), reviewNewPatchSha256: hash(newRaw),
    targetElementIds: targets.map(row => row.id), targetElementsSha256: hash(json(targets)), ...(waivedRetiredElementIds.length ? { waivedRetiredElementIds } : {}),
    note: 'Bound target/region changes and a new accepted review are checked; patch viewing and semantic correctness remain agent declarations.' };
  return { issue, record, oldPng, newPng };
}
export async function resolveVersionIssues(runPath, version, resolutionPath, label) {
  labelCheck(label);
  const state = await latestResolutionContext(runPath, version), { ctx } = state, request = await readJson(resolve(resolutionPath));
  if (!Array.isArray(request.resolutions) || !request.resolutions.length || request.resolutions.length > 1000) throw new Error('resolutions requires 1–1000 entries');
  const ids = new Set(), prepared = [], patches = [];
  for (const row of request.resolutions) {
    if (ids.has(row.issueId)) throw new Error(`Duplicate resolution issue ID: ${row.issueId}`); ids.add(row.issueId);
    nonempty(row.fixDescription, 'Resolution fixDescription');
    const item = await prepareIssueResolution(state, version, row);
    const patch = await resolutionPatch(ctx, item.oldPng, item.newPng, item.record.reviewRoi, item.issue.id);
    prepared.push({ ...item.record, fixDescription: row.fixDescription, patchSha256: hash(patch) });
    patches.push(patch);
  }
  const root = await evidenceDirectory(ctx.run), path = join(root, 'resolutions', label), body = { protocol: PROTOCOL, version, sourceSha256: ctx.sourceSha256, resolutions: prepared };
  await mkdir(join(root, 'resolutions'), { recursive: true });
  let fresh = false;
  try { await mkdir(path); fresh = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fresh) {
    for (const [i, row] of prepared.entries()) await save(join(path, `${row.issueId}.png`), patches[i]);
    await save(join(path, 'prepared.json'), json(body));
    await event(ctx.run, { event: 'resolution_prepared', label, version, recordSha256: hash(json(body)), issueIds: prepared.map(row => row.issueId) });
  } else {
    if (hash(await readFile(join(path, 'prepared.json'))) !== hash(json(body))) throw new Error('Prepared resolution is stale or changed; use a new label after changing inputs/review');
    for (const row of prepared) if (hash(await readFile(join(path, `${row.issueId}.png`))) !== row.patchSha256) throw new Error('Resolution patch changed');
  }
  const missing = prepared.filter((row, i) => request.resolutions[i].viewedPatchSha256 !== row.patchSha256);
  if (missing.length) {
    if (request.resolutions.some(row => row.viewedPatchSha256)) throw new Error('viewedPatchSha256 is missing or stale for one or more resolution patches');
    return { status: 'pending_visual_review', directory: path, patches: prepared.map(row => ({ issueId: row.issueId, path: join(path, `${row.issueId}.png`), sha256: row.patchSha256 })), instructions: 'View each source/discovery/repaired patch, then add viewedPatchSha256 to the matching resolution and rerun the same label. No issue has been closed.' };
  }
  if (fresh) throw new Error('Prepare and view the actual patches before submitting viewedPatchSha256');
  const closed = { ...body, resolvedAt: new Date().toISOString(), resolutions: prepared.map((row, i) => ({ ...row, viewedPatchSha256: request.resolutions[i].viewedPatchSha256 })) };
  const bytes = json(closed); await save(join(path, 'resolved.json'), bytes);
  await event(ctx.run, { event: 'issues_resolved', label, version, recordSha256: hash(bytes), issueIds: prepared.map(row => row.issueId) });
  return { status: 'resolved', ...closed, ledger: await writeOpenIssues(ctx), report: join(path, 'resolved.json') };
}

// A plan prepares visual evidence, not acceptance. Each persistent ID survives
// grouping, and a blocked item cannot prevent another item from being reviewed.
export async function planIssueClosure(runPath, version, label) {
  labelCheck(label);
  const state = await latestResolutionContext(runPath, version), { ctx, ledger, meta } = state;
  const latest = (await events(ctx.run)).filter(row => row.event === 'version_review' && row.version === version).at(-1);
  if (!latest) throw new Error('Review the latest rendered version before planning closure');
  const current = await validatedReview(ctx, version, latest.label), rows = [], groups = new Map();
  for (const issue of ledger.filter(row => row.status === 'open')) {
    let prepared, blockedReason, correctionReason;
    try { prepared = await prepareIssueResolution(state, version, { issueId: issue.id, reviewLabel: latest.label }); }
    catch (error) {
      blockedReason = error.message;
      if (issue.automatic && issue.inventorySha256 !== meta.inventorySha256) {
        try { prepared = await prepareIssueResolution(state, version, { issueId: issue.id, reviewLabel: latest.label, resolutionType: 'inventory-correction' }); }
        catch (correctionError) { correctionReason = correctionError.message; }
      }
    }
    let roi, oldPng, newPng, targets;
    if (prepared) ({ oldPng, newPng } = prepared, roi = prepared.record.reviewRoi, targets = prepared.record.targetElementIds);
    else {
      const old = await loadVersion(ctx, issue.discoveredVersion);
      if (old.hashes.sceneSha256 !== issue.sceneSha256 || old.hashes.previewSha256 !== issue.previewSha256) throw new Error('Discovery artifacts changed');
      [oldPng, newPng] = await Promise.all([readFile(join(old.path, 'preview.png')), readFile(join(current.rendered.path, 'preview.png'))]);
      if (hash(await rawPatch(oldPng, issue.roi)) !== issue.discoveredPatchSha256 || hash(await rawPatch(ctx.source, issue.roi)) !== issue.sourcePatchSha256) throw new Error('Discovery/source ROI hashes changed');
      targets = issue.elementIds;
      try { roi = (await repairRegion(ctx, issue, current.rendered.scene.elements.filter(e => targets.includes(e.id)), state.inventory)).roi; }
      catch { roi = issue.roi; }
    }
    const key = hash(json({ discoveredVersion: issue.discoveredVersion, roi, targets: targets.slice().sort() })).slice(0, 20);
    if (!groups.has(key)) {
      const patch = await resolutionPatch(ctx, oldPng, newPng, roi, `Targets: ${targets.join(', ') || issue.inventoryId || issue.id}`);
      groups.set(key, { id: key, file: `group-${key}.png`, sha256: hash(patch), roi, discoveredVersion: issue.discoveredVersion, issueIds: [], patch });
    }
    groups.get(key).issueIds.push(issue.id);
    rows.push({ issueId: issue.id, description: issue.description, kind: issue.kind, inventoryId: issue.inventoryId ?? null, discoveredVersion: issue.discoveredVersion,
      status: prepared ? 'ready_for_visual_review' : 'blocked', groupId: key,
      ...(prepared ? { prepared: prepared.record } : { blockedReason, ...(correctionReason ? { inventoryCorrectionBlockedReason: correctionReason } : {}) }) });
  }
  const root = await evidenceDirectory(ctx.run), path = join(root, 'closure-plans', label);
  await mkdir(join(root, 'closure-plans'), { recursive: true }); await mkdir(path);
  for (const group of groups.values()) await save(join(path, group.file), group.patch);
  const body = { protocol: PROTOCOL, createdAt: new Date().toISOString(), version, reviewLabel: latest.label, reviewSha256: current.reviewSha256,
    sourceSha256: ctx.sourceSha256, inventorySha256: meta.inventorySha256, ...current.rendered.hashes, rows,
    groups: [...groups.values()].map(({ patch, ...group }) => group),
    instructions: 'Inspect every relevant source/discovery/current patch. ready_for_visual_review is eligibility, not acceptance. Copy decisions.template.json, select only corrected issue IDs, set status accepted, write the specific fixDescription, and supply that group sha256 as viewedPatchSha256. Keep uncorrected entries pending/issue. closure-apply closes only individually validated, explicitly accepted entries; finalize still requires zero open issues and a complete latest review.' };
  const bytes = json(body); await save(join(path, 'plan.json'), bytes);
  const template = { planLabel: label, decisions: rows.map(row => ({ issueId: row.issueId, status: 'pending', fixDescription: '' })) };
  await save(join(path, 'decisions.template.json'), json(template));
  await event(ctx.run, { event: 'closure_plan_prepared', label, version, recordSha256: hash(bytes), issueIds: rows.map(row => row.issueId) });
  return { status: 'pending_visual_review', directory: path, plan: join(path, 'plan.json'), decisionsTemplate: join(path, 'decisions.template.json'),
    readyCount: rows.filter(row => row.status === 'ready_for_visual_review').length, blockedCount: rows.filter(row => row.status === 'blocked').length,
    rows: rows.map(({ prepared, ...row }) => row), groups: body.groups.map(group => ({ ...group, path: join(path, group.file) })), instructions: body.instructions };
}

export async function applyIssueClosure(runPath, version, decisionPath, label) {
  labelCheck(label);
  const request = await readJson(resolve(decisionPath)); labelCheck(request.planLabel);
  const state = await latestResolutionContext(runPath, version), { ctx, ledger } = state;
  const planPath = join(ctx.run, 'evidence', 'closure-plans', request.planLabel), bytes = await readFile(join(planPath, 'plan.json')), plan = JSON.parse(bytes);
  if (plan.version !== version || plan.sourceSha256 !== ctx.sourceSha256 || plan.inventorySha256 !== state.meta.inventorySha256 || !(await events(ctx.run)).some(row => row.event === 'closure_plan_prepared' && row.label === request.planLabel && row.recordSha256 === hash(bytes))) throw new Error('Closure plan is stale or changed; prepare a new plan');
  const current = await validatedReview(ctx, version, plan.reviewLabel);
  if (current.reviewSha256 !== plan.reviewSha256 || Object.entries(current.rendered.hashes).some(([key, value]) => plan[key] !== value)) throw new Error('Closure plan review/render is stale or changed; prepare a new plan');
  for (const group of plan.groups) if (hash(await readFile(join(planPath, group.file))) !== group.sha256) throw new Error('Closure plan patch changed');
  if (!Array.isArray(request.decisions) || !request.decisions.length || request.decisions.length > 1000) throw new Error('decisions requires 1–1000 entries');
  const ids = new Set();
  for (const decision of request.decisions) {
    if (ids.has(decision.issueId) || !plan.rows.some(row => row.issueId === decision.issueId) || !['accepted', 'pending', 'issue'].includes(decision.status)) throw new Error('Decision has an unknown/duplicate issue ID or invalid status');
    ids.add(decision.issueId);
  }
  const accepted = [], outcomes = [];
  for (const decision of request.decisions) {
    const planned = plan.rows.find(row => row.issueId === decision.issueId), issue = ledger.find(row => row.id === decision.issueId);
    if (issue?.status === 'resolved') { outcomes.push({ issueId: decision.issueId, status: 'already_resolved' }); continue; }
    if (decision.status !== 'accepted') { outcomes.push({ issueId: decision.issueId, status: 'left_open', decision: decision.status }); continue; }
    try {
      if (!planned.prepared) throw new Error(`Plan item is blocked: ${planned.blockedReason}`);
      nonempty(decision.fixDescription, 'Resolution fixDescription');
      const group = plan.groups.find(row => row.id === planned.groupId);
      if (decision.viewedPatchSha256 !== group.sha256) throw new Error('viewedPatchSha256 is missing or stale; inspect the actual group patch before accepting');
      const fresh = await prepareIssueResolution(state, version, { issueId: decision.issueId, reviewLabel: plan.reviewLabel, resolutionType: planned.prepared.resolutionType });
      if (hash(json(fresh.record)) !== hash(json(planned.prepared))) throw new Error('Planned item evidence is stale; prepare a new plan');
      accepted.push({ ...fresh.record, fixDescription: decision.fixDescription, patchSha256: group.sha256, viewedPatchSha256: group.sha256,
        visualDecision: 'accepted', planLabel: request.planLabel, planSha256: hash(bytes), groupId: group.id });
      outcomes.push({ issueId: decision.issueId, status: 'resolved' });
    } catch (error) { outcomes.push({ issueId: decision.issueId, status: 'blocked', reason: error.message }); }
  }
  const root = await evidenceDirectory(ctx.run), path = join(root, 'resolutions', label);
  await mkdir(join(root, 'resolutions'), { recursive: true }); await mkdir(path);
  await save(join(path, 'decisions.json'), json({ request, outcomes }));
  if (accepted.length) {
    for (const row of accepted) {
      const group = plan.groups.find(group => group.id === row.groupId);
      await save(join(path, `${row.issueId}.png`), await readFile(join(planPath, group.file)));
    }
    const body = { protocol: PROTOCOL, version, sourceSha256: ctx.sourceSha256, resolutions: accepted }, closed = { ...body, resolvedAt: new Date().toISOString() };
    await save(join(path, 'prepared.json'), json(body)); await save(join(path, 'resolved.json'), json(closed));
    await event(ctx.run, { event: 'issues_resolved', label, version, recordSha256: hash(json(closed)), issueIds: accepted.map(row => row.issueId) });
  }
  await event(ctx.run, { event: 'closure_plan_applied', label, version, planLabel: request.planLabel, resolvedIssueIds: accepted.map(row => row.issueId), outcomes });
  const nextLedger = await writeOpenIssues(ctx);
  return { status: !accepted.length ? 'none_resolved' : nextLedger.openIssues.length ? 'partially_resolved' : 'resolved', resolvedCount: accepted.length,
    outcomes, ledger: nextLedger, directory: path, instructions: 'Unselected, pending, blocked and still-defective items remain open. Continue fixes and latest reviews; prepare a new plan after another render/review/inventory revision. A still-current plan may close another subset with a new apply label. Run finalize only after every issue is closed.' };
}
