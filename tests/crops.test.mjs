import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { repairImageCrops } from '../src/crops.mjs';

// Independent synthetic diagrams provide known object silhouettes. The tests
// assert retained content, margins, and uncertainty, not a particular image
// segmentation algorithm or any coordinates from the MatPlotAgent example.
const width = 180, height = 120;
async function png(body, { transparent = false } = {}) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${transparent ? '' : '<rect width="100%" height="100%" fill="white"/>'}${body}</svg>`)).ensureAlpha().png().toBuffer();
}
const icon = '<circle cx="60" cy="60" r="21" fill="#4785c4" stroke="#183b61" stroke-width="3"/><path d="M49 60 L57 68 L72 50" fill="none" stroke="white" stroke-width="4"/>';
const imageElement = (bbox = [44, 42, 75, 78], kind = 'icon') => ({ id: 'target', type: 'image', kind, bbox_px: bbox, reason: 'Preserve the detailed source object.' });
const scene = (image = imageElement(), extra = []) => ({ width, height, background: '#ffffff', elements: [image, ...extra] });

async function foregroundBounds(source, { transparent = false } = {}) {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = 0, bottom = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const offset = (y * info.width + x) * 4;
    if (data[offset + 3] <= 1 || !transparent && data[offset] >= 249 && data[offset + 1] >= 249 && data[offset + 2] >= 249) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
  }
  return [left, top, right, bottom];
}

function verifyAudit(result, original) {
  const target = result.scene.elements.find(element => element.id === 'target');
  const audit = result.audit.items.find(item => item.id === 'target');
  assert.ok(result.audit.version);
  assert.ok(Array.isArray(result.audit.unresolvedIds));
  assert.ok(audit);
  assert.equal(audit.kind, original.elements[0].kind);
  assert.ok(['repaired', 'unchanged', 'needs_review'].includes(audit.status));
  assert.deepEqual(audit.originalBox, original.elements[0].bbox_px);
  assert.deepEqual(audit.finalBox, target.bbox_px);
  assert.ok(typeof audit.reason === 'string' && audit.reason.length > 0);
  assert.equal(result.audit.unresolvedIds.includes('target'), audit.status === 'needs_review');
  assert.ok(target.bbox_px.every(Number.isInteger));
  const [left, top, right, bottom] = target.bbox_px;
  assert.ok(left >= 0 && top >= 0 && right <= width && bottom <= height && right > left && bottom > top);
  return { target, audit };
}

function containsInkWithPadding(box, ink) {
  assert.ok(box[0] <= ink[0] - 1 && box[1] <= ink[1] - 1 && box[2] >= ink[2] + 1 && box[3] >= ink[3] + 1,
    `Crop ${JSON.stringify(box)} must contain all ink ${JSON.stringify(ink)} plus a margin.`);
}

test('a truncated isolated icon recovers the complete antialiased silhouette with padding without mutating input', async () => {
  const sourcePng = await png(icon);
  const input = scene();
  const before = structuredClone(input);
  const sourceBefore = Buffer.from(sourcePng);
  const result = await repairImageCrops(input, { sourcePng, width, height });
  const { target, audit } = verifyAudit(result, before);
  assert.equal(audit.status, 'repaired');
  containsInkWithPadding(target.bbox_px, await foregroundBounds(sourcePng));
  assert.deepEqual(input, before);
  assert.deepEqual(sourcePng, sourceBefore);
});

test('a nearby letter and pale outer frame are not swallowed into the icon crop', async () => {
  const sourcePng = await png(`${icon}<rect x="14" y="12" width="144" height="96" rx="4" fill="none" stroke="#d0d8e2" stroke-width="2"/><text x="98" y="69" font-family="Arial" font-size="24" fill="#222">A</text>`);
  const native = [
    { id: 'frame', type: 'rect', x: 14, y: 12, width: 144, height: 96, fill: 'none', stroke: '#d0d8e2' },
    { id: 'label', type: 'text', x: 98, y: 69, fontSize: 24, text: 'A' },
  ];
  const input = scene(imageElement(), native);
  const result = await repairImageCrops(input, { sourcePng, width, height });
  const { target, audit } = verifyAudit(result, input);
  assert.ok(['repaired', 'needs_review'].includes(audit.status));
  assert.ok(target.bbox_px[0] > 16 && target.bbox_px[1] > 14 && target.bbox_px[2] < 98 && target.bbox_px[3] < 106);
  if (audit.status === 'repaired') containsInkWithPadding(target.bbox_px, await foregroundBounds(await png(icon)));
  else assert.deepEqual(target.bbox_px, input.elements[0].bbox_px);
  assert.deepEqual(result.scene.elements.slice(1), native);
});

test('equally plausible neighboring targets require review instead of silently choosing or merging them', async () => {
  const sourcePng = await png('<circle cx="58" cy="60" r="18" fill="#346d9d"/><circle cx="99" cy="60" r="18" fill="#346d9d"/>');
  const input = scene(imageElement([58, 43, 99, 77]));
  const result = await repairImageCrops(input, { sourcePng, width, height });
  const { target, audit } = verifyAudit(result, input);
  assert.equal(audit.status, 'needs_review');
  assert.deepEqual(target.bbox_px, input.elements[0].bbox_px);
});

test('tightening an icon crop must not discard a small detached detail already present in the proposed box', async () => {
  const sourcePng = await png('<circle cx="60" cy="48" r="20" fill="#4785c4" stroke="#183b61" stroke-width="2"/><rect x="54" y="82" width="12" height="7" rx="2" fill="#183b61"/>');
  const input = scene(imageElement([35, 24, 86, 94]));
  const result = await repairImageCrops(input, { sourcePng, width, height });
  const { target, audit } = verifyAudit(result, input);
  if (audit.status === 'needs_review') assert.deepEqual(target.bbox_px, input.elements[0].bbox_px);
  else containsInkWithPadding(target.bbox_px, await foregroundBounds(sourcePng));
});

test('low-contrast colored outer details cannot vanish when only the dark icon body is selected', async () => {
  const sourcePng = await png(`<circle cx="60" cy="60" r="30" fill="none" stroke="#eef2f6" stroke-width="3"/>${icon}`);
  const input = scene(imageElement([25, 25, 96, 96]));
  const result = await repairImageCrops(input, { sourcePng, width, height });
  const { target, audit } = verifyAudit(result, input);
  if (audit.status === 'needs_review') assert.deepEqual(target.bbox_px, input.elements[0].bbox_px);
  else containsInkWithPadding(target.bbox_px, await foregroundBounds(sourcePng));
});

test('transparent source background is not foreground and an isolated alpha icon can be recovered', async () => {
  const sourcePng = await png(icon, { transparent: true });
  const input = scene();
  const result = await repairImageCrops(input, { sourcePng, width, height });
  const { target, audit } = verifyAudit(result, input);
  assert.equal(audit.status, 'repaired');
  containsInkWithPadding(target.bbox_px, await foregroundBounds(sourcePng, { transparent: true }));
  assert.ok(target.bbox_px[2] - target.bbox_px[0] < width / 2);
  assert.ok(target.bbox_px[3] - target.bbox_px[1] < height / 2);
});

test('an icon already cut by the source canvas edge is flagged without inventing missing pixels or out-of-bounds coordinates', async () => {
  const sourcePng = await png('<circle cx="8" cy="56" r="21" fill="#4785c4" stroke="#183b61" stroke-width="3"/>', { transparent: true });
  const input = scene(imageElement([0, 39, 23, 73]));
  const result = await repairImageCrops(input, { sourcePng, width, height });
  const { target, audit } = verifyAudit(result, input);
  assert.equal(audit.status, 'needs_review');
  assert.deepEqual(target.bbox_px, input.elements[0].bbox_px);
});

test('a chart with axes, labels, and separate marks is not expanded as if it were one isolated icon', async () => {
  const sourcePng = await png('<rect x="9" y="10" width="160" height="100" fill="none" stroke="#d0d8e2"/><path d="M30 28 V91 H137" fill="none" stroke="#333" stroke-width="2"/><path d="M40 78 L63 64 L84 72 L120 40" fill="none" stroke="#2985c4" stroke-width="3"/><text x="46" y="21" font-size="13">Trial results</text><text x="57" y="107" font-size="12">Time</text>');
  for (const kind of ['chart', 'illustration']) {
    const input = scene(imageElement([29, 28, 126, 94], kind));
    const result = await repairImageCrops(input, { sourcePng, width, height });
    const { target, audit } = verifyAudit(result, input);
    assert.ok(['unchanged', 'needs_review'].includes(audit.status));
    assert.deepEqual(target.bbox_px, input.elements[0].bbox_px);
    if (audit.status === 'unchanged') assert.equal(audit.evidence?.checked, false);
  }
});
