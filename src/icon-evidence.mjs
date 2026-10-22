import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Pixel risks are review prompts, never a claim that a semantic icon is cut.
const PROTOCOL = 'luna-icon-review-v1';
const MAX_PIXELS = 40_000_000;
const SIDES = ['left', 'top', 'right', 'bottom'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const positive = b => b[2] > b[0] && b[3] > b[1];
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safeId = id => `${String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}-${hash(String(id)).slice(0, 10)}`;
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const scaleFor = box => Math.max(box[2] - box[0], box[3] - box[1]) <= 160 ? 4
  : Math.max(box[2] - box[0], box[3] - box[1]) <= 320 ? 2 : 1;

function validateBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((v, i) => !Number.isInteger(v) || v < 0 || v > (i % 2 ? height : width)) || !positive(box)) throw new Error('Icon evidence needs a valid integer source bbox');
  return [...box];
}
function padded(box, amount, width, height) {
  return [Math.max(0, box[0] - amount), Math.max(0, box[1] - amount), Math.min(width, box[2] + amount), Math.min(height, box[3] + amount)];
}
function extractSpec(box) { return { left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1] }; }
function successPrefix(events, version) {
  const matches = events.map((row, index) => ({ row, index })).filter(({ row }) => row.event === 'success' && row.version === version);
  if (matches.length !== 1) throw new Error(`Icon evidence requires exactly one successful render for ${version}`);
  return events.slice(0, matches[0].index + 1);
}
async function versionFiles(run, version, sourceSha256) {
  const files = Object.fromEntries(await Promise.all(['scene.json', 'preview.png', 'stats.json', 'crop-audit.json', 'result.svg']
    .map(async name => [name, await readFile(join(run, version, name))])));
  const stats = JSON.parse(files['stats.json']), scene = JSON.parse(files['scene.json']), audit = JSON.parse(files['crop-audit.json']);
  if (stats.version !== version || stats.sourceSha256 !== sourceSha256
    || stats.sceneSha256 !== hash(files['scene.json']) || stats.previewSha256 !== hash(files['preview.png'])
    || stats.svgSha256 !== hash(files['result.svg'])) throw new Error(`Rendered input hashes are stale for ${version}`);
  return { scene, stats, audit, preview: files['preview.png'], hashes: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) };
}
async function context(runPath, version) {
  if (!/^v\d{2}$/.test(version)) throw new Error('Invalid icon evidence version');
  const run = resolve(runPath), manifestBytes = await readFile(join(run, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  if (manifest.protocol !== 'luna-local-render-v1') throw new Error('Unsupported render manifest');
  const source = await readFile(join(run, 'source.png')), sourceSha256 = hash(source);
  if (sourceSha256 !== manifest.sourceSha256) throw new Error('Normalized source hash changed');
  const metadata = await sharp(source, { limitInputPixels: MAX_PIXELS }).metadata();
  const { width, height } = metadata;
  if (width !== manifest.width || height !== manifest.height) throw new Error('Source dimensions changed');
  const events = (await readFile(join(run, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const prefix = successPrefix(events, version), priorEvents = prefix.slice(0, -1).filter(row => row.event === 'success');
  const previousVersion = priorEvents.at(-1)?.version ?? null;
  const current = await versionFiles(run, version, sourceSha256);
  const previous = previousVersion ? await versionFiles(run, previousVersion, sourceSha256) : null;
  const previewMeta = await sharp(current.preview, { limitInputPixels: MAX_PIXELS }).metadata();
  if (previewMeta.width !== width || previewMeta.height !== height || current.scene.width !== width || current.scene.height !== height) throw new Error('Preview/scene dimensions differ from source');
  const ids = new Set();
  for (const item of current.scene.elements.filter(row => row.type === 'image')) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new Error('Image IDs must be unique nonempty strings');
    ids.add(item.id); validateBox(item.bbox_px, width, height);
  }
  const bindings = { sourceSha256, runManifestSha256: hash(manifestBytes), renderHistoryPrefixSha256: hash(json(prefix)),
    current: current.hashes, previousVersion, previous: previous?.hashes ?? null };
  return { run, version, manifest, source, sourceSha256, width, height, current, previous, previousVersion, bindings,
    directory: join(run, 'evidence', 'icon-reviews', version) };
}

// Estimate a local background from the context perimeter. This conservative
// heuristic deliberately exposes false positives for human/model resolution.
function backgroundRgb(raw, width, box) {
  const bins = new Map();
  const sample = (x, y) => {
    const offset = (y * width + x) * 3, color = [raw[offset], raw[offset + 1], raw[offset + 2]];
    const key = color.map(v => Math.floor(v / 16)).join(',');
    const row = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
    row.count++; color.forEach((v, i) => { row.sum[i] += v; }); bins.set(key, row);
  };
  for (let x = box[0]; x < box[2]; x++) { sample(x, box[1]); sample(x, box[3] - 1); }
  for (let y = box[1] + 1; y < box[3] - 1; y++) { sample(box[0], y); sample(box[2] - 1, y); }
  const mode = [...bins.values()].sort((a, b) => b.count - a.count)[0];
  return mode.sum.map(v => Math.round(v / mode.count));
}
function measure(raw, width, box, background, other) {
  let foregroundPixels = 0, changedPixels = 0, foregroundChangedPixels = 0;
  let bounds = [box[2], box[3], box[0], box[1]];
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) {
    const offset = (y * width + x) * 3;
    const fg = Math.max(...background.map((v, c) => Math.abs(raw[offset + c] - v))) >= 24;
    if (fg) foregroundPixels++;
    const changed = other && [0, 1, 2].some(c => Math.abs(raw[offset + c] - other[offset + c]) > 18);
    if (changed) {
      changedPixels++;
      if (fg) {
        foregroundChangedPixels++;
        bounds = [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x + 1), Math.max(bounds[3], y + 1)];
      }
    }
  }
  return { foregroundPixels, changedPixels, foregroundChangedPixels, foregroundChangedBox: positive(bounds) ? bounds : null,
    backgroundRgb: background, foregroundTolerance: 24, renderDifferenceTolerance: 18 };
}
function removedRectangles(old, next) {
  if (!old) return [];
  const middleTop = Math.max(old[1], next[1]), middleBottom = Math.min(old[3], next[3]);
  return [
    ['top', [old[0], old[1], old[2], Math.min(old[3], next[1])]],
    ['bottom', [old[0], Math.max(old[1], next[3]), old[2], old[3]]],
    ['left', [old[0], middleTop, Math.min(old[2], next[0]), middleBottom]],
    ['right', [Math.max(old[0], next[2]), middleTop, old[2], middleBottom]],
  ].filter(([, box]) => positive(box));
}
function edgeBoxes(box, width, height) {
  const [l, t, r, b] = box;
  return { left: [Math.max(0, l - 4), Math.max(0, t - 4), Math.min(width, l + 4), Math.min(height, b + 4)],
    top: [Math.max(0, l - 4), Math.max(0, t - 4), Math.min(width, r + 4), Math.min(height, t + 4)],
    right: [Math.max(0, r - 4), Math.max(0, t - 4), Math.min(width, r + 4), Math.min(height, b + 4)],
    bottom: [Math.max(0, l - 4), Math.max(0, b - 4), Math.min(width, r + 4), Math.min(height, b + 4)] };
}
function boundaryBox(box, side) {
  const [l, t, r, b] = box;
  return { left: [l, t, l + 1, b], top: [l, t, r, t + 1], right: [r - 1, t, r, b], bottom: [l, b - 1, r, b] }[side];
}
function riskMetadata(ctx, element, previousBox, sourceRaw, finalRaw) {
  const bbox = [...element.bbox_px], encompassing = previousBox ? union(bbox, previousBox) : bbox;
  const contextBox = padded(encompassing, Math.max(12, Math.min(32, Math.round(Math.max(encompassing[2] - encompassing[0], encompassing[3] - encompassing[1]) * .2))), ctx.width, ctx.height);
  const scale = scaleFor(contextBox), background = backgroundRgb(sourceRaw, ctx.width, contextBox), warnings = [];
  const edges = SIDES.map(side => ({ side, bbox: edgeBoxes(bbox, ctx.width, ctx.height)[side] }));
  for (const { side } of edges) {
    const boundary = boundaryBox(bbox, side), measurement = measure(sourceRaw, ctx.width, boundary, background);
    if (measurement.foregroundPixels) warnings.push({ id: `edge-touch-${side}`, kind: 'edge-touch', side, bbox: boundary,
      description: 'Source foreground-like pixels touch the adopted crop boundary. They may belong to this icon or a neighboring object; inspect both sides of the boundary.', measurement });
    if ((side === 'left' && bbox[0] === 0) || (side === 'top' && bbox[1] === 0)
      || (side === 'right' && bbox[2] === ctx.width) || (side === 'bottom' && bbox[3] === ctx.height)) warnings.push({
      id: `source-boundary-${side}`, kind: 'source-boundary', side, bbox: boundary, description: 'The crop reaches the original canvas edge; pixels outside the source cannot establish completeness.',
      measurement: { canvasWidth: ctx.width, canvasHeight: ctx.height } });
  }
  const removedBands = removedRectangles(previousBox, bbox).map(([side, box]) => {
    const measurement = measure(sourceRaw, ctx.width, box, background);
    if (measurement.foregroundPixels) warnings.push({ id: `shrink-foreground-${side}`, kind: 'shrink-foreground', side, bbox: box,
      description: 'The new crop discards foreground-like source pixels retained in the previous successful version. Verify whether the removed pixels are icon details or unrelated neighbors.', measurement });
    return { id: `removed-${side}`, side, bbox: box, displayBox: padded(box, 8, ctx.width, ctx.height), previousBox, measurement };
  });
  const difference = measure(sourceRaw, ctx.width, bbox, background, finalRaw);
  if (difference.foregroundChangedPixels) warnings.push({ id: 'render-difference', kind: 'render-difference', bbox: difference.foregroundChangedBox,
    description: 'The final SVG render changes foreground-like source pixels inside this adopted crop. Later native objects may cover it; inspect the actual final render.', measurement: difference });
  const audit = (ctx.current.audit.items ?? []).find(row => row.id === element.id);
  if (!audit || audit.status === 'needs_review' || audit.automaticSuggestionStatus === 'needs_review' || audit.evidence?.confidence === 'unresolved') warnings.push({
    id: 'automatic-ambiguous', kind: 'automatic-ambiguous', bbox, description: audit?.reason ?? 'No automatic crop audit is available for this image; semantic boundaries require review.',
    measurement: { auditStatus: audit?.status ?? null, automaticSuggestionStatus: audit?.automaticSuggestionStatus ?? null, auditReason: audit?.reason ?? null } });
  return { bbox, previousBox, contextBox, scale, edges, removedBands, warnings };
}
function checker(width, height) {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, v = ((x >> 3) + (y >> 3)) % 2 ? 216 : 236;
    raw[i] = raw[i + 1] = raw[i + 2] = v; raw[i + 3] = 255;
  }
  return sharp(raw, { raw: { width, height, channels: 4 } });
}
async function artifact(path, bytes) {
  await writeFile(path, bytes, { flag: 'wx' });
  return { path, sha256: hash(bytes) };
}
async function pixelHash(bytes, box) {
  const { data, info } = await sharp(bytes).extract(extractSpec(box)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return hash(Buffer.concat([Buffer.from(`${info.width},${info.height},${info.channels}\n`), data]));
}
async function fingerprints(ctx, element, metadata) {
  const { bbox, contextBox, scale, warnings, removedBands } = metadata;
  const sourceContextSha256 = await pixelHash(ctx.source, contextBox);
  const renderedContextSha256 = await pixelHash(ctx.current.preview, contextBox);
  const adoptedSha256 = await pixelHash(ctx.source, bbox);
  const contentFingerprint = hash(json({ id: element.id, kind: element.kind, bbox, contextBox, scale,
    sourceContextSha256, renderedContextSha256, adoptedSha256, warnings,
    removedBands: removedBands.map(({ id, side, bbox, displayBox, previousBox, measurement }) => ({ id, side, bbox, displayBox, previousBox, measurement })) }));
  return { sourceContextSha256, renderedContextSha256, adoptedSha256, contentFingerprint };
}
async function triptych(ctx, bbox, box, scale, path, highlights = []) {
  const spec = extractSpec(box), width = spec.width, height = spec.height;
  const source = await sharp(ctx.source).extract(spec).png().toBuffer();
  const adopted = intersect(bbox, box);
  let middle = checker(width, height);
  if (positive(adopted)) middle = middle.composite([{ input: await sharp(ctx.source).extract(extractSpec(adopted)).png().toBuffer(),
    left: adopted[0] - box[0], top: adopted[1] - box[1] }]);
  const panels = [source, await middle.png().toBuffer(), await sharp(ctx.current.preview).extract(spec).png().toBuffer()];
  const panelWidth = width * scale, panelHeight = height * scale, gutter = 12, header = 32;
  const sheetWidth = panelWidth * 3 + gutter * 2, sheetHeight = panelHeight + header;
  const overlays = await Promise.all(panels.map(async (bytes, i) => ({ input: await sharp(bytes).resize(panelWidth, panelHeight, { kernel: 'nearest' }).png().toBuffer(), left: i * (panelWidth + gutter), top: header })));
  // Labels are outside source pixels; the raw comparison never has outlines.
  const labels = ['SOURCE CONTEXT', 'ADOPTED SOURCE CROP', 'FINAL SVG RENDER'].map((title, i) =>
    `<text x="${i * (panelWidth + gutter) + 2}" y="14" font-size="11">${title}</text>`).join('');
  overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="${header}"><g font-family="Arial" fill="#111827">${labels}<text x="2" y="28" font-size="10">${xml(`${box.join(',')} · ${scale}x nearest · identical coordinates/scale`)}</text></g></svg>`), left: 0, top: 0 });
  const bytes = await sharp({ create: { width: sheetWidth, height: sheetHeight, channels: 4, background: '#fff' } }).composite(overlays).png().toBuffer();
  const file = await artifact(path, bytes), layout = { header, gutter, panelWidth, panelHeight, panelOffsets: [0, panelWidth + gutter, 2 * (panelWidth + gutter)] };
  let annotated;
  if (highlights.length) {
    const rectangles = highlights.flatMap(({ box: mark, color }) => [0, 1, 2].map(i => {
      const b = intersect(mark, box);
      if (!positive(b)) return '';
      return `<rect x="${i * (panelWidth + gutter) + (b[0] - box[0]) * scale}" y="${header + (b[1] - box[1]) * scale}" width="${(b[2] - b[0]) * scale}" height="${(b[3] - b[1]) * scale}" fill="none" stroke="${color}" stroke-width="1"/>`;
    })).join('');
    annotated = await artifact(path.replace(/\.png$/, '-annotated.png'), await sharp(bytes).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="${sheetHeight}">${rectangles}</svg>`), left: 0, top: 0 }]).png().toBuffer());
  }
  return { ...file, bbox: box, scale, layout, ...(annotated ? { annotated } : {}) };
}

export async function ensureIconEvidence(runPath, version) {
  const ctx = await context(runPath, version), manifestPath = join(ctx.directory, 'manifest.json');
  try { await readFile(manifestPath); return loadIconEvidence(runPath, version); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(join(ctx.run, 'evidence', 'icon-reviews'), { recursive: true });
  // A partial old directory is never silently reused or overwritten.
  await mkdir(ctx.directory);
  const sourceRaw = await sharp(ctx.source).flatten({ background: ctx.current.scene.background ?? '#fff' }).removeAlpha().raw().toBuffer();
  const finalRaw = await sharp(ctx.current.preview).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer();
  const old = new Map((ctx.previous?.scene.elements ?? []).filter(row => row.type === 'image').map(row => [row.id, row]));
  const items = [];
  for (const element of ctx.current.scene.elements.filter(row => row.type === 'image')) {
    const metadata = riskMetadata(ctx, element, old.get(element.id)?.bbox_px ?? null, sourceRaw, finalRaw);
    const { bbox, previousBox, contextBox, scale, warnings } = metadata;
    const directory = join(ctx.directory, safeId(element.id));
    await mkdir(directory);
    const comparison = await triptych(ctx, bbox, contextBox, scale, join(directory, 'comparison.png'), [{ box: bbox, color: '#e11d48' }, ...(previousBox ? [{ box: previousBox, color: '#2563eb' }] : [])]);
    const edges = [], removedBands = [];
    for (const { side, bbox: box } of metadata.edges) {
      const edge = await triptych(ctx, bbox, box, scaleFor(box), join(directory, `edge-${side}.png`));
      edges.push({ side, ...edge });
    }
    for (const band of metadata.removedBands) {
      const { side, bbox: box, displayBox } = band;
      const file = await triptych(ctx, bbox, displayBox, scaleFor(displayBox), join(directory, `removed-${side}.png`), [{ box, color: '#e11d48' }]);
      removedBands.push({ ...file, ...band });
    }
    items.push({ id: element.id, kind: element.kind, bbox, previousBox, contextBox, scale, comparison,
      annotated: comparison.annotated, edges, removedBands, warnings,
      ...await fingerprints(ctx, element, metadata),
      pixelRiskPolicy: 'Warnings measure pixel risks, not icon semantics. A lack of warnings is not proof of completeness.' });
  }
  const manifest = { protocol: PROTOCOL, version, directory: ctx.directory, createdAt: new Date().toISOString(),
    sourceSha256: ctx.sourceSha256, previewSha256: ctx.current.hashes['preview.png'], sceneSha256: ctx.current.hashes['scene.json'],
    previousVersion: ctx.previousVersion, previousPreviewSha256: ctx.previous?.hashes['preview.png'] ?? null,
    previousSceneSha256: ctx.previous?.hashes['scene.json'] ?? null, width: ctx.width, height: ctx.height, bindings: ctx.bindings, items,
    limitations: ['Background/foreground and pixel differences are conservative heuristics, not semantic segmentation.',
      'Three columns always share source coordinates and integer nearest-neighbor scale. Large objects remain at 1x; there is no downsampled aggregate sheet.',
      'The middle column is the actual adopted source crop at its original location, with checkerboard outside it. The right column is the saved final SVG preview.',
      'Raw comparison and edge PNGs have no outlines over content; annotations are separate files.'] };
  const bytes = json(manifest);
  await writeFile(manifestPath, bytes, { flag: 'wx' });
  return { ...manifest, manifestSha256: hash(bytes) };
}

function artifacts(item) {
  const files = [item.comparison, item.annotated, ...item.edges, ...item.removedBands];
  return files.flatMap(file => file ? [file, ...(file.annotated ? [file.annotated] : [])] : []);
}
function assertPanelArtifact(file, path, box, scale, annotated) {
  const panelWidth = (box[2] - box[0]) * scale, panelHeight = (box[3] - box[1]) * scale;
  const layout = { header: 32, gutter: 12, panelWidth, panelHeight, panelOffsets: [0, panelWidth + 12, 2 * (panelWidth + 12)] };
  if (file?.path !== path || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || file.scale !== scale || !same(file.layout, layout)
    || annotated && file.annotated?.path !== path.replace(/\.png$/, '-annotated.png')
    || !annotated && file.annotated !== undefined) throw new Error('Icon evidence panel path/layout changed');
}
export async function loadIconEvidence(runPath, version) {
  const ctx = await context(runPath, version), bytes = await readFile(join(ctx.directory, 'manifest.json')), manifest = JSON.parse(bytes);
  if (manifest.protocol !== PROTOCOL || manifest.version !== version || manifest.directory !== ctx.directory || manifest.width !== ctx.width || manifest.height !== ctx.height
    || !same(manifest.bindings, ctx.bindings) || manifest.sourceSha256 !== ctx.sourceSha256
    || manifest.previewSha256 !== ctx.current.hashes['preview.png'] || manifest.sceneSha256 !== ctx.current.hashes['scene.json']
    || manifest.previousVersion !== ctx.previousVersion || manifest.previousPreviewSha256 !== (ctx.previous?.hashes['preview.png'] ?? null)
    || manifest.previousSceneSha256 !== (ctx.previous?.hashes['scene.json'] ?? null)) throw new Error('Icon evidence has stale input hashes');
  const images = ctx.current.scene.elements.filter(row => row.type === 'image');
  if (!Array.isArray(manifest.items) || manifest.items.length !== images.length) throw new Error('Icon evidence image inventory changed');
  const checked = new Map();
  const sourceRaw = await sharp(ctx.source).flatten({ background: ctx.current.scene.background ?? '#fff' }).removeAlpha().raw().toBuffer();
  const finalRaw = await sharp(ctx.current.preview).flatten({ background: '#fff' }).removeAlpha().raw().toBuffer();
  const old = new Map((ctx.previous?.scene.elements ?? []).filter(row => row.type === 'image').map(row => [row.id, row]));
  for (const [index, item] of manifest.items.entries()) {
    if (item.id !== images[index].id || !same(item.bbox, images[index].bbox_px) || ![1, 2, 4].includes(item.scale)
      || !same(item.edges.map(edge => edge.side), SIDES) || new Set(item.warnings.map(w => w.id)).size !== item.warnings.length
      || new Set(item.removedBands.map(row => row.id)).size !== item.removedBands.length) throw new Error('Invalid icon evidence inventory/schema');
    const metadata = riskMetadata(ctx, images[index], old.get(item.id)?.bbox_px ?? null, sourceRaw, finalRaw);
    for (const key of ['bbox', 'previousBox', 'contextBox', 'scale', 'warnings']) if (!same(item[key], metadata[key])) throw new Error(`Icon evidence ${key} changed`);
    const actualBands = item.removedBands.map(({ id, side, bbox, displayBox, previousBox, measurement }) => ({ id, side, bbox, displayBox, previousBox, measurement }));
    if (!same(actualBands, metadata.removedBands) || !same(item.edges.map(({ side, bbox }) => ({ side, bbox })), metadata.edges)) throw new Error('Icon evidence edge/removed-band geometry changed');
    const expectedHashes = await fingerprints(ctx, images[index], metadata);
    for (const [key, value] of Object.entries(expectedHashes)) if (item[key] !== value) throw new Error(`Icon evidence ${key} changed`);
    const directory = join(ctx.directory, safeId(item.id));
    assertPanelArtifact(item.comparison, join(directory, 'comparison.png'), metadata.contextBox, metadata.scale, true);
    if (!same(item.comparison.bbox, metadata.contextBox) || !same(item.annotated, item.comparison.annotated)) throw new Error('Icon comparison references changed');
    for (const edge of item.edges) assertPanelArtifact(edge, join(directory, `edge-${edge.side}.png`), edge.bbox, scaleFor(edge.bbox), false);
    for (const band of item.removedBands) assertPanelArtifact(band, join(directory, `removed-${band.side}.png`), band.displayBox, scaleFor(band.displayBox), true);
    for (const file of artifacts(item)) {
      const target = resolve(file.path), rel = relative(ctx.directory, target);
      if (!isAbsolute(file.path) || !rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Icon evidence artifact escapes its version directory');
      if (checked.has(target)) {
        if (checked.get(target) !== file.sha256) throw new Error('Conflicting icon evidence artifact hashes');
        continue;
      }
      checked.set(target, file.sha256);
      if (hash(await readFile(target)) !== file.sha256) throw new Error(`Icon evidence artifact hash changed: ${file.path}`);
    }
  }
  return { ...manifest, manifestSha256: hash(bytes) };
}
