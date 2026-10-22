import { readFile, writeFile, appendFile, mkdir, open, unlink, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const PROTOCOL = 'luna-partition-review-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const save = (path, value) => writeFile(path, value, { flag: 'wx' });
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const STATES = new Set(['no_difference', 'difference', 'uncertain', 'not_applicable']);
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const nonempty = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw new Error(`${label} must be nonempty text (at most 12000 characters)`);
  return value;
};
const labelCheck = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('Label must contain 1–64 letters, digits, _ or -');
  return value;
};
const bboxCheck = (box, width, height, label) => {
  if (!Array.isArray(box) || box.length !== 4 || box.some((n, i) => !Number.isInteger(n) || n < 0 || n > (i % 2 ? height : width)) || box[0] >= box[2] || box[1] >= box[3]) {
    throw new Error(`${label} must be a positive integer bbox [left,top,right,bottom] within the image`);
  }
  return [...box];
};
const contains = (outer, inner) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const exists = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function axisStarts(length, tile, overlap) {
  const starts = [0];
  while (starts.at(-1) + tile < length) starts.push(Math.min(starts.at(-1) + tile - overlap, length - tile));
  return starts;
}

export function partitionGrid(width, height, { tileSize = 640, overlap = 96 } = {}) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 20000) || width * height > 40_000_000) throw new Error('Image must have positive dimensions, at most 20000 per side and 40 million pixels');
  if (!Number.isInteger(tileSize) || tileSize < 64 || tileSize > 680) throw new Error('tile-size must be an integer from 64 to 680');
  if (!Number.isInteger(overlap) || overlap < 1 || overlap >= tileSize) throw new Error('overlap must be an integer from 1 to tile-size minus 1');
  const xs = axisStarts(width, tileSize, overlap), ys = axisStarts(height, tileSize, overlap);
  if (xs.length * ys.length > 1024) throw new Error('Grid exceeds 1024 regions; increase tile size or reduce overlap');
  const regions = [];
  for (const [row, y] of ys.entries()) for (const [column, x] of xs.entries()) {
    regions.push({ id: `r${String(regions.length + 1).padStart(3, '0')}`, row, column, bbox: [x, y, Math.min(x + tileSize, width), Math.min(y + tileSize, height)] });
  }
  return { regions, xStarts: xs, yStarts: ys, tileSize, overlap,
    coverageSummary: { fullCanvasCovered: true, coveredPixels: width * height, canvasPixels: width * height, rows: ys.length, columns: xs.length, regionCount: regions.length,
      cropPixelSum: regions.reduce((sum, r) => sum + (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1]), 0),
      policy: 'Fixed row-major overlapping grid; no image-content, difference, model, or answer-based selection.' } };
}

async function normalize(bytes) {
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  if (!['png', 'jpeg'].includes(meta.format)) throw new Error('Only PNG and JPEG inputs are supported');
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().toColourspace('srgb').flatten({ background: '#ffffff' }).removeAlpha().png().toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height, extension: meta.format === 'jpeg' ? '.jpg' : '.png' };
}

const pixelHash = (data, width, height) => createHash('sha256').update(`RGB:${width}:${height}:white-srgb-exif\0`).update(data).digest('hex');
const expand = (box, padding, width, height) => [Math.max(0, box[0] - padding), Math.max(0, box[1] - padding), Math.min(width, box[2] + padding), Math.min(height, box[3] + padding)];

async function normalizedPixels(input) {
  const image = await normalize(typeof input === 'string' ? await readFile(resolve(input)) : input);
  const data = await sharp(image.bytes).raw().toBuffer();
  return { ...image, data, pixelSha256: pixelHash(data, image.width, image.height) };
}

/**
 * Select repair-review cells from actual visible pixel changes. This is scheduling
 * evidence only: a difference (or its absence) does not establish visual correctness.
 * requiredRois can include unresolved issues and areas not reviewed previously.
 */
export async function selectChangedRegions(previousPng, currentPng, { tileSize = 640, overlap = 96, contextPadding = 32, requiredRois = [] } = {}) {
  if (previousPng === undefined || previousPng === null) throw new Error('A previous render is required for incremental selection; use the default full-grid review for a first render');
  if (!Number.isInteger(contextPadding) || contextPadding < 0 || contextPadding > 20000) throw new Error('contextPadding must be an integer from 0 to 20000');
  const [previous, current] = await Promise.all([normalizedPixels(previousPng), normalizedPixels(currentPng)]);
  const { width, height } = current;
  if (previous.width !== width || previous.height !== height) throw new Error('Previous and current dimensions must match after orientation normalization; use full-grid review after changing canvas dimensions');
  const grid = partitionGrid(width, height, { tileSize, overlap });
  if (!Array.isArray(requiredRois) || requiredRois.length > 1024) throw new Error('requiredRois must be an array of at most 1024 bounding boxes or {bbox,id?,reason?} objects');
  const rois = requiredRois.map((entry, index) => {
    const value = Array.isArray(entry) ? { bbox: entry } : entry;
    if (!value || typeof value !== 'object') throw new Error(`requiredRois[${index}] is invalid`);
    const bbox = bboxCheck(value.bbox, width, height, `requiredRois[${index}].bbox`);
    return { id: value.id === undefined ? `roi${index + 1}` : labelCheck(value.id), bbox,
      reason: value.reason === undefined ? 'Caller-required review area; may contain an unresolved issue or an unreviewed area.' : nonempty(value.reason, `requiredRois[${index}].reason`) };
  });
  if (new Set(rois.map(r => r.id)).size !== rois.length) throw new Error('requiredRois IDs must be unique');
  const changed = new Uint8Array(width * height);
  let changedPixels = 0;
  for (let pixel = 0, offset = 0; pixel < changed.length; pixel++, offset += 3) {
    if (previous.data[offset] !== current.data[offset] || previous.data[offset + 1] !== current.data[offset + 1] || previous.data[offset + 2] !== current.data[offset + 2]) {
      changed[pixel] = 1; changedPixels++;
    }
  }
  const hasChanges = box => {
    for (let y = box[1]; y < box[3]; y++) {
      const end = y * width + box[2];
      for (let offset = y * width + box[0]; offset < end; offset++) if (changed[offset]) return true;
    }
    return false;
  };
  const selectionReasonById = {};
  for (const region of grid.regions) {
    const reasons = [];
    if (changedPixels && hasChanges(region.bbox)) reasons.push('changed_pixels');
    else if (changedPixels && contextPadding && hasChanges(expand(region.bbox, contextPadding, width, height))) reasons.push('changed_pixel_context');
    for (const roi of rois) {
      if (intersects(region.bbox, expand(roi.bbox, contextPadding, width, height))) reasons.push(`required_roi:${roi.id}`);
    }
    if (reasons.length) selectionReasonById[region.id] = reasons;
  }
  return { mode: 'incremental', regionIds: Object.keys(selectionReasonById), changedPixels, selectionReasonById,
    previousPixelSha256: previous.pixelSha256, currentPixelSha256: current.pixelSha256, width, height, tileSize, overlap, contextPadding,
    requiredRois: rois, fullGridRegionCount: grid.regions.length,
    pixelPolicy: 'Compare every sRGB RGB channel after EXIF orientation and alpha compositing over white; exact differences, no tolerance or alignment.',
    selectionPolicy: 'Select cells intersecting any changed pixel plus contextPadding, and caller-required ROIs plus contextPadding. No overall difference bounding box is used.',
    visualCorrectnessVerified: false,
    limitations: ['Unchanged pixels can still contain pre-existing errors. Supply all unresolved and previously unreviewed areas as requiredRois.',
      'Pixel differences select inspection work; they do not prove an improvement, a fix, or the absence of errors.'] };
}

function unionCoveredPixels(regions) {
  const ys = [...new Set(regions.flatMap(r => [r.bbox[1], r.bbox[3]]))].sort((a, b) => a - b);
  let area = 0;
  for (let row = 0; row < ys.length - 1; row++) {
    const intervals = regions.filter(r => r.bbox[1] <= ys[row] && r.bbox[3] > ys[row]).map(r => [r.bbox[0], r.bbox[2]]).sort((a, b) => a[0] - b[0]);
    let left = 0, right = 0, span = 0;
    for (const interval of intervals) {
      if (interval[0] > right) { span += right - left; [left, right] = interval; }
      else right = Math.max(right, interval[1]);
    }
    span += right - left;
    area += span * (ys[row + 1] - ys[row]);
  }
  return area;
}

async function crop(bytes, bbox) {
  return sharp(bytes).extract({ left: bbox[0], top: bbox[1], width: bbox[2] - bbox[0], height: bbox[3] - bbox[1] }).png().toBuffer();
}

async function pairImage(a, b, width, height, title = '', maxWidth = null) {
  // Crop pairs stay at 1x. Only the full-canvas overview can be downscaled.
  const gap = 16, header = 36;
  const scale = maxWidth ? Math.min(1, (maxWidth - gap) / (2 * width)) : 1;
  const panelWidth = Math.max(1, Math.floor(width * scale)), panelHeight = Math.max(1, Math.floor(height * scale));
  if (scale !== 1) {
    a = await sharp(a).resize(panelWidth, panelHeight).png().toBuffer();
    b = await sharp(b).resize(panelWidth, panelHeight).png().toBuffer();
  }
  const totalWidth = panelWidth * 2 + gap;
  const labels = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${header}"><rect width="100%" height="100%" fill="#eef1f4"/><g font-family="Microsoft YaHei,Arial,sans-serif" font-size="14" fill="#17212b"><text x="8" y="24">A 原图 ${xml(title)}</text><text x="${panelWidth + gap + 8}" y="24">B 候选 ${xml(title)}</text></g></svg>`);
  return { bytes: await sharp({ create: { width: totalWidth, height: panelHeight + header, channels: 3, background: '#ffffff' } })
    .composite([{ input: labels, left: 0, top: 0 }, { input: a, left: 0, top: header }, { input: b, left: panelWidth + gap, top: header }]).png().toBuffer(),
    width: totalWidth, height: panelHeight + header, panelWidth, panelHeight, scale, headerHeight: header, gap };
}

export async function createPartitionReview(referencePath, candidatePath, outputPath, options = {}) {
  const [originalReference, originalCandidate] = await Promise.all([readFile(resolve(referencePath)), readFile(resolve(candidatePath))]);
  const [reference, candidate] = await Promise.all([normalize(originalReference), normalize(originalCandidate)]);
  if (reference.width !== candidate.width || reference.height !== candidate.height) throw new Error('Reference and candidate dimensions must match after orientation normalization; no automatic registration or resizing is performed');
  const { width, height } = reference;
  const grid = partitionGrid(width, height, options), run = resolve(outputPath);
  const selected = options.selectedRegionIds;
  const isSelectedScope = selected !== undefined;
  if (isSelectedScope && (!Array.isArray(selected) || selected.some(id => typeof id !== 'string') || new Set(selected).size !== selected.length || selected.some(id => !grid.regions.some(r => r.id === id)))) {
    throw new Error('selectedRegionIds must be an array of unique existing grid IDs; an empty array requires global overview review only');
  }
  if (!isSelectedScope && options.selectionEvidence !== undefined) throw new Error('selectionEvidence requires explicit selectedRegionIds');
  const selectedSet = isSelectedScope ? new Set(selected) : null;
  const selectedRegions = selectedSet ? grid.regions.filter(r => selectedSet.has(r.id)) : grid.regions;
  let selectionEvidence = null;
  if (options.selectionEvidence !== undefined) {
    if (!options.selectionEvidence || typeof options.selectionEvidence !== 'object' || Array.isArray(options.selectionEvidence)) throw new Error('selectionEvidence must be an object');
    selectionEvidence = JSON.parse(JSON.stringify(options.selectionEvidence));
    if (selectionEvidence.regionIds !== undefined && (!Array.isArray(selectionEvidence.regionIds) || JSON.stringify([...selectionEvidence.regionIds].sort()) !== JSON.stringify([...selected].sort()))) throw new Error('selectionEvidence regionIds do not match selectedRegionIds');
    for (const [key, expected] of Object.entries({ width, height, tileSize: grid.tileSize, overlap: grid.overlap })) {
      if (selectionEvidence[key] !== undefined && selectionEvidence[key] !== expected) throw new Error(`selectionEvidence ${key} does not match the review grid`);
    }
    if (selectionEvidence.currentPixelSha256 !== undefined) {
      const pixels = await sharp(candidate.bytes).raw().toBuffer();
      if (selectionEvidence.currentPixelSha256 !== pixelHash(pixels, width, height)) throw new Error('selectionEvidence currentPixelSha256 does not match the candidate render');
    }
  }
  const reviewScope = isSelectedScope ? 'selected_regions' : 'full_grid';
  const coveredPixels = isSelectedScope ? unionCoveredPixels(selectedRegions) : width * height;
  const coverageSummary = { ...grid.coverageSummary, fullCanvasCovered: coveredPixels === width * height, coveredPixels,
    regionCount: selectedRegions.length, fullGridRegionCount: grid.regions.length, selectedRegionCount: selectedRegions.length,
    reviewScope, unselectedRegionIds: grid.regions.filter(r => selectedSet && !selectedSet.has(r.id)).map(r => r.id),
    cropPixelSum: selectedRegions.reduce((sum, r) => sum + (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1]), 0),
    ...(isSelectedScope ? { policy: 'Only the explicitly selected fixed-grid regions receive detailed local review. The full-canvas overview remains mandatory; skipped regions are not declared reviewed.' } : {}) };
  await mkdir(run); // Existing directories are refused, including partially failed runs.
  await mkdir(join(run, 'originals'));
  await mkdir(join(run, 'regions'));
  await mkdir(join(run, 'records'));
  await mkdir(join(run, 'zooms'));
  const originals = { reference: `originals/reference${reference.extension}`, candidate: `originals/candidate${candidate.extension}` };
  await Promise.all([
    save(join(run, originals.reference), originalReference), save(join(run, originals.candidate), originalCandidate),
    save(join(run, 'reference.png'), reference.bytes), save(join(run, 'candidate.png'), candidate.bytes),
  ]);
  const overview = await pairImage(reference.bytes, candidate.bytes, width, height, '全图', 2000);
  await save(join(run, 'overview-pair.png'), overview.bytes);
  const regions = [];
  for (const region of selectedRegions) {
    const directory = join(run, 'regions', region.id);
    await mkdir(directory);
    const [a, b] = await Promise.all([crop(reference.bytes, region.bbox), crop(candidate.bytes, region.bbox)]);
    const pair = await pairImage(a, b, region.bbox[2] - region.bbox[0], region.bbox[3] - region.bbox[1], region.id);
    await Promise.all([save(join(directory, 'reference.png'), a), save(join(directory, 'candidate.png'), b), save(join(directory, 'pair.png'), pair.bytes)]);
    regions.push({ ...region, reference: `regions/${region.id}/reference.png`, candidate: `regions/${region.id}/candidate.png`, pair: `regions/${region.id}/pair.png`,
      referenceSha256: hash(a), candidateSha256: hash(b), pairSha256: hash(pair.bytes), pairGeometry: { ...pair, bytes: undefined } });
  }
  const inputs = {
    reference: { originalPath: originals.reference, originalSha256: hash(originalReference), normalizedPath: 'reference.png', normalizedSha256: hash(reference.bytes) },
    candidate: { originalPath: originals.candidate, originalSha256: hash(originalCandidate), normalizedPath: 'candidate.png', normalizedSha256: hash(candidate.bytes) },
  };
  const inputFingerprint = hash(JSON.stringify({ width, height, inputs }));
  const manifest = { protocol: PROTOCOL, createdAtUtc: new Date().toISOString(), width, height, inputFingerprint, inputs,
    normalization: 'EXIF orientation; sRGB; alpha composited over white; PNG output. No alignment, content crop, or dimension resizing.',
    grid: { tileSize: grid.tileSize, overlap: grid.overlap, xStarts: grid.xStarts, yStarts: grid.yStarts },
    reviewScope, coverageSummary, selectionEvidence,
    selectionEvidenceNote: isSelectedScope ? 'Selection evidence is supplied by the caller; candidate pixel hash and grid bindings are checked when present. It is not proof that all needed regions were selected or that any defect was fixed.' : null,
    overview: { path: 'overview-pair.png', sha256: hash(overview.bytes), ...overview, bytes: undefined }, regions,
    limitations: ['A recorded viewed hash is a model declaration, not proof of actual viewing or visual correctness.',
      'Grid coverage is pixel coverage, not proof of object, text, icon, or connector coverage.', 'This tool records differences and uncertainty; it never changes or approves an SVG.',
      ...(isSelectedScope ? ['Detailed inspection covers only selected regions. A global overview does not substitute for detailed review of skipped regions.'] : [])] };
  const manifestBytes = json(manifest);
  await save(join(run, 'manifest.json'), manifestBytes);
  await save(join(run, 'ledger.json'), json({ protocol: PROTOCOL, kind: 'immutable_initial_ledger', manifestSha256: hash(manifestBytes), inputFingerprint,
    regions: regions.map(r => ({ regionId: r.id, status: 'pending' })), globalStatus: 'pending',
    note: 'Current state is derived from append-only events.jsonl and immutable records; use the status command.' }));
  await save(join(run, 'events.jsonl'), '');
  return { run, manifest: join(run, 'manifest.json'), overview: join(run, manifest.overview.path), overviewSha256: manifest.overview.sha256,
    width, height, reviewScope, coverageSummary, regions: regions.map(r => ({ id: r.id, bbox: r.bbox, pair: join(run, r.pair), pairSha256: r.pairSha256 })) };
}

async function loadRun(runPath) {
  const run = resolve(runPath), manifestBytes = await readFile(join(run, 'manifest.json')), manifest = JSON.parse(manifestBytes), ledger = await readJson(join(run, 'ledger.json'));
  if (manifest.protocol !== PROTOCOL || ledger.protocol !== PROTOCOL || ledger.manifestSha256 !== hash(manifestBytes) || ledger.inputFingerprint !== manifest.inputFingerprint) throw new Error('Manifest or initial ledger fingerprint changed');
  if (hash(JSON.stringify({ width: manifest.width, height: manifest.height, inputs: manifest.inputs })) !== manifest.inputFingerprint) throw new Error('Input fingerprint does not match manifest');
  const images = {};
  for (const key of ['reference', 'candidate']) {
    const spec = manifest.inputs[key];
    const [original, normalized] = await Promise.all([readFile(join(run, spec.originalPath)), readFile(join(run, spec.normalizedPath))]);
    if (hash(original) !== spec.originalSha256 || hash(normalized) !== spec.normalizedSha256) throw new Error(`${key} input hash changed`);
    images[key] = normalized;
  }
  const lines = (await readFile(join(run, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const events = [], records = [];
  let previous = null;
  for (const [index, line] of lines.entries()) {
    const event = JSON.parse(line), { eventSha256, ...payload } = event;
    if (eventSha256 !== hash(JSON.stringify(payload)) || event.sequence !== index + 1 || event.previousEventSha256 !== previous || event.inputFingerprint !== manifest.inputFingerprint || event.manifestSha256 !== ledger.manifestSha256) throw new Error('Review event chain/fingerprint changed');
    if (!/^records\/(?:r\d{3,4}|global)\.json$/.test(event.record)) throw new Error('Invalid event record path');
    const recordBytes = await readFile(join(run, event.record));
    if (hash(recordBytes) !== event.recordSha256) throw new Error('Immutable review record changed');
    const record = JSON.parse(recordBytes);
    if (record.inputFingerprint !== manifest.inputFingerprint || record.manifestSha256 !== ledger.manifestSha256) throw new Error('Review record input fingerprint changed');
    records.push(record); events.push(event); previous = eventSha256;
  }
  const regionRecords = records.filter(r => r.kind === 'region'), globalRecords = records.filter(r => r.kind === 'global');
  if (new Set(regionRecords.map(r => r.regionId)).size !== regionRecords.length || globalRecords.length > 1) throw new Error('Duplicate review records');
  return { run, manifest, ledger, events, records, images, regionRecords, globalRecord: globalRecords[0] ?? null };
}

async function locked(runPath, fn) {
  const run = resolve(runPath), lockPath = join(run, '.review.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error('Review run is locked by another operation'); throw error; }
  try { return await fn(await loadRun(run)); } finally { await lock.close(); await unlink(lockPath); }
}

async function assertMutable(ctx) {
  if (await exists(join(ctx.run, 'report.json'))) throw new Error('Run is finalized; create a new run to review a revision');
}

async function verifyAsset(ctx, relative, expected) {
  const bytes = await readFile(join(ctx.run, relative));
  if (hash(bytes) !== expected) throw new Error(`Evidence image hash changed: ${relative}`);
}

function validateChecks(value, keys, aliases = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('checks must be an object');
  const result = {};
  for (const key of keys) {
    const aliased = aliases[key] && value[aliases[key]];
    if (value[key] !== undefined && aliased !== undefined && value[key] !== aliased) throw new Error(`Conflicting check aliases: ${key}`);
    const state = value[key] ?? aliased;
    if (!STATES.has(state)) throw new Error(`checks.${key} must be no_difference, difference, uncertain, or not_applicable`);
    result[key] = state;
  }
  const allowed = new Set([...keys, ...Object.values(aliases)]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unknown checks key');
  return result;
}

function validateFindings(value, ctx, scope) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('findings must be an array of at most 100 items');
  const ids = new Set();
  return value.map((finding, index) => {
    if (!finding || typeof finding !== 'object') throw new Error('Each finding must be an object');
    const id = finding.id === undefined ? `f${String(index + 1).padStart(3, '0')}` : labelCheck(finding.id);
    if (ids.has(id)) throw new Error(`Duplicate finding ID: ${id}`);
    ids.add(id);
    const bbox = bboxCheck(finding.bbox, ctx.manifest.width, ctx.manifest.height, `finding ${id} bbox`);
    if (!contains(scope, bbox)) throw new Error(`Finding ${id} bbox is outside the reviewed region; inspect a zoom and report a cross-region finding in global review`);
    const evidence = typeof finding.evidence === 'string' ? [finding.evidence] : finding.evidence;
    if (!Array.isArray(evidence) || !evidence.length || evidence.length > 20) throw new Error('Each finding requires observed evidence text');
    evidence.forEach(item => nonempty(item, 'finding evidence'));
    return { id, bbox, kind: nonempty(finding.kind, 'finding kind'), description: nonempty(finding.description, 'finding description'), evidence };
  });
}

function validateUncertain(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('uncertain must be an array of concrete uncertainty descriptions');
  return value.map(item => nonempty(item, 'uncertainty'));
}

function statusFrom(checks, findings, uncertain) {
  const states = Object.values(checks);
  if (states.includes('difference') && findings.length === 0) throw new Error('A difference check requires at least one localized finding with evidence');
  if (findings.length && !states.includes('difference')) throw new Error('Findings require at least one difference check');
  if (states.includes('uncertain') || uncertain.length) return 'uncertain';
  return findings.length ? 'checked_with_findings' : 'checked_no_difference';
}

async function appendRecord(ctx, record, relative) {
  const recordBytes = json({ protocol: PROTOCOL, recordedAtUtc: new Date().toISOString(), inputFingerprint: ctx.manifest.inputFingerprint, manifestSha256: ctx.ledger.manifestSha256, ...record });
  await save(join(ctx.run, relative), recordBytes);
  const payload = { protocol: PROTOCOL, sequence: ctx.events.length + 1, recordedAtUtc: new Date().toISOString(), previousEventSha256: ctx.events.at(-1)?.eventSha256 ?? null,
    inputFingerprint: ctx.manifest.inputFingerprint, manifestSha256: ctx.ledger.manifestSha256, record: relative, recordSha256: hash(recordBytes) };
  const event = { ...payload, eventSha256: hash(JSON.stringify(payload)) };
  await appendFile(join(ctx.run, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  return { ...JSON.parse(recordBytes), record: join(ctx.run, relative), eventSha256: event.eventSha256 };
}

export async function recordPartitionReview(runPath, recordPath) {
  const submitted = await readJson(resolve(recordPath));
  return locked(runPath, async ctx => {
    await assertMutable(ctx);
    const region = ctx.manifest.regions.find(r => r.id === submitted.regionId);
    if (!region) throw new Error('Unknown regionId');
    if (ctx.regionRecords.some(r => r.regionId === region.id)) throw new Error('Region already recorded; records cannot be overwritten or revised in this run');
    if (ctx.globalRecord) throw new Error('Global review already recorded; use a new run for a revised review');
    if (submitted.viewedPairSha256 !== region.pairSha256) throw new Error('viewedPairSha256 must match the actual region pair image');
    await Promise.all([verifyAsset(ctx, region.pair, region.pairSha256), verifyAsset(ctx, region.reference, region.referenceSha256), verifyAsset(ctx, region.candidate, region.candidateSha256)]);
    const checks = validateChecks(submitted.checks, ['text', 'shape', 'connector', 'boundary'], { text: '文字', shape: '图形', connector: '连线', boundary: '边界' });
    const findings = validateFindings(submitted.findings, ctx, region.bbox), uncertain = validateUncertain(submitted.uncertain);
    const record = { kind: 'region', regionId: region.id, bbox: region.bbox, viewedPairSha256: submitted.viewedPairSha256, summary: nonempty(submitted.summary, 'summary'), checks, findings, uncertain,
      status: statusFrom(checks, findings, uncertain), viewingIsModelDeclaration: true };
    return appendRecord(ctx, record, `records/${region.id}.json`);
  });
}

export async function recordGlobalReview(runPath, recordPath) {
  const submitted = await readJson(resolve(recordPath));
  return locked(runPath, async ctx => {
    await assertMutable(ctx);
    if (ctx.globalRecord) throw new Error('Global review already recorded; records cannot be overwritten');
    const pending = ctx.manifest.regions.filter(r => !ctx.regionRecords.some(record => record.regionId === r.id));
    if (pending.length) throw new Error(`Global review requires all regions first; pending: ${pending.map(r => r.id).join(', ')}`);
    if (submitted.viewedOverviewSha256 !== ctx.manifest.overview.sha256) throw new Error('viewedOverviewSha256 must match the actual full-canvas overview');
    await verifyAsset(ctx, ctx.manifest.overview.path, ctx.manifest.overview.sha256);
    const checks = validateChecks(submitted.checks, ['crossRegionConnectors', 'iconCompleteness', 'omissions']);
    const findings = validateFindings(submitted.findings, ctx, [0, 0, ctx.manifest.width, ctx.manifest.height]), uncertain = validateUncertain(submitted.uncertain);
    return appendRecord(ctx, { kind: 'global', viewedOverviewSha256: submitted.viewedOverviewSha256, summary: nonempty(submitted.summary, 'summary'), checks, findings, uncertain,
      status: statusFrom(checks, findings, uncertain), viewingIsModelDeclaration: true }, 'records/global.json');
  });
}

function summarize(ctx) {
  const byId = new Map(ctx.regionRecords.map(r => [r.regionId, r]));
  const regions = ctx.manifest.regions.map(r => ({ regionId: r.id, bbox: r.bbox, status: byId.get(r.id)?.status ?? 'pending', findingCount: byId.get(r.id)?.findings.length ?? 0 }));
  const pending = regions.filter(r => r.status === 'pending').map(r => r.regionId);
  const uncertainRegions = regions.filter(r => r.status === 'uncertain').map(r => r.regionId);
  return { run: ctx.run, inputFingerprint: ctx.manifest.inputFingerprint, reviewScope: ctx.manifest.reviewScope ?? 'full_grid',
    coverageSummary: ctx.manifest.coverageSummary, selectionEvidence: ctx.manifest.selectionEvidence ?? null,
    totalRegions: regions.length, fullGridRegionCount: ctx.manifest.coverageSummary.fullGridRegionCount ?? regions.length, recordedRegions: byId.size, pendingRegions: pending,
    uncertainRegions, globalStatus: ctx.globalRecord?.status ?? 'pending', findingCount: ctx.records.reduce((sum, record) => sum + record.findings.length, 0),
    findingCountNote: 'Observations across overlapping regions may repeat; this is not a unique-defect count or an accuracy score.',
    regions, declarationOnly: true, limits: ctx.manifest.limitations };
}

export async function partitionReviewStatus(runPath) {
  return summarize(await loadRun(runPath));
}

export async function finalizePartitionReview(runPath) {
  return locked(runPath, async ctx => {
    await assertMutable(ctx);
    const status = summarize(ctx);
    if (status.pendingRegions.length || !ctx.globalRecord) throw new Error(`Cannot finalize incomplete coverage: pending regions ${status.pendingRegions.join(', ') || 'none'}; global ${status.globalStatus}`);
    // Recheck every reviewed visual, not only the pair referenced by the last event.
    await verifyAsset(ctx, ctx.manifest.overview.path, ctx.manifest.overview.sha256);
    for (const region of ctx.manifest.regions) await Promise.all([verifyAsset(ctx, region.pair, region.pairSha256), verifyAsset(ctx, region.reference, region.referenceSha256), verifyAsset(ctx, region.candidate, region.candidateSha256)]);
    const hasUncertainty = status.uncertainRegions.length > 0 || status.globalStatus === 'uncertain';
    const report = { protocol: PROTOCOL, finalizedAtUtc: new Date().toISOString(), ...status,
      status: hasUncertainty ? 'review_incomplete_uncertain' : status.findingCount ? 'review_complete_with_findings' : 'review_complete_no_reported_findings',
      coverageRecorded: true, fullGridCoverageRecorded: status.reviewScope === 'full_grid', reviewComplete: !hasUncertainty, visualCorrectnessVerified: false,
      findings: ctx.records.flatMap(record => record.findings.map(f => ({ review: record.regionId ?? 'global', ...f }))),
      uncertainty: ctx.records.filter(record => record.status === 'uncertain').map(record => ({ review: record.regionId ?? 'global', checks: record.checks, notes: record.uncertain })),
      eventsSha256: hash(await readFile(join(ctx.run, 'events.jsonl'))),
      note: `Complete means recorded inspection coverage only${status.reviewScope === 'selected_regions' ? ' for the selected regions and global overview; skipped regions were not inspected in detail' : ''}. Findings are model claims, not independently verified defects. No SVG was fixed or accepted.` };
    await save(join(ctx.run, 'report.json'), json(report));
    return { ...report, report: join(ctx.run, 'report.json') };
  });
}

export async function zoomPartitionReview(runPath, bbox, label) {
  labelCheck(label);
  return locked(runPath, async ctx => {
    await assertMutable(ctx);
    const box = bboxCheck(bbox, ctx.manifest.width, ctx.manifest.height, 'zoom bbox'), directory = join(ctx.run, 'zooms', label);
    // A model-selected context crop supplements the scheduled grid; it never marks any region checked.
    await mkdir(directory);
    const [a, b] = await Promise.all([crop(ctx.images.reference, box), crop(ctx.images.candidate, box)]);
    const pair = await pairImage(a, b, box[2] - box[0], box[3] - box[1], label);
    await Promise.all([save(join(directory, 'reference.png'), a), save(join(directory, 'candidate.png'), b), save(join(directory, 'pair.png'), pair.bytes)]);
    const metadata = { protocol: PROTOCOL, inputFingerprint: ctx.manifest.inputFingerprint, manifestSha256: ctx.ledger.manifestSha256, bbox: box,
      pairSha256: hash(pair.bytes), sourcePixelScale: 1, gridCoverageChanged: false };
    await save(join(directory, 'zoom.json'), json(metadata));
    return { ...metadata, reference: join(directory, 'reference.png'), candidate: join(directory, 'candidate.png'), pair: join(directory, 'pair.png') };
  });
}
