import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { normalizeImage, validateScene, compileScene } from '../src/scene.mjs';

const dimensions = { width: 100, height: 80 };
const rect = () => ({ id: 'box', type: 'rect', x: 10, y: 10, width: 20, height: 20, fill: '#ff0000', stroke: 'none' });
const scene = elements => ({ ...dimensions, background: '#ffffff', elements: elements ?? [rect()] });
const crop = (id, box) => ({ id, type: 'image', bbox_px: box, kind: 'icon', reason: 'Detailed icon preserved from the source.' });
const white = () => sharp({ create: { ...dimensions, channels: 4, background: '#ffffff' } }).png().toBuffer();

test('scene validation refuses unknown fields, duplicate IDs, URLs and scripts', () => {
  for (const patch of [{ href: 'https://example.com/icon.png' }, { href: 'data:image/png;base64,AAAA' }, { onclick: 'alert(1)' }, { style: 'fill:red' }, { transform: 'scale(2)' }]) {
    assert.throws(() => validateScene(scene([{ ...rect(), ...patch }]), dimensions), /not supported/);
  }
  assert.throws(() => validateScene({ ...scene(), metadata: {} }, dimensions), /not supported/);
  assert.throws(() => validateScene(scene([rect(), rect()]), dimensions), /unique/);
  assert.throws(() => validateScene(scene([{ ...rect(), type: 'script' }]), dimensions), /unsupported/);
  assert.throws(() => validateScene(scene([{ ...rect(), fill: 'url(https://example.com/a)' }]), dimensions), /hex color/);
  assert.throws(() => validateScene(scene([{ ...rect(), x: NaN }]), dimensions), /must be a number/);
  assert.throws(() => validateScene(scene([{ ...rect(), width: '20' }]), dimensions), /must be a number/);
  assert.throws(() => validateScene({ ...scene(), width: 101 }, dimensions), /dimensions/);
  assert.throws(() => validateScene(scene(Array.from({ length: 401 }, (_, i) => ({ ...rect(), id: `r${i}` }))), dimensions), /1–400/);
});

test('crop limits use the rectangle union, require reasons, and reject whole-image embedding', () => {
  assert.throws(() => validateScene(scene([crop('all', [0, 0, 100, 80])]), dimensions), /40%/);
  assert.throws(() => validateScene(scene([crop('fraction', [0.5, 0, 10, 10])]), dimensions), /integer/);
  assert.throws(() => validateScene(scene([{ ...crop('icon', [0, 0, 10, 10]), reason: '' }]), dimensions), /reason/);
  assert.throws(() => validateScene(scene([crop('a', [0, 0, 40, 80]), crop('b', [60, 0, 100, 80])]), dimensions), /70%/);
  assert.doesNotThrow(() => validateScene(scene([crop('a', [0, 0, 40, 80]), crop('b', [20, 0, 60, 80])]), dimensions));
  assert.throws(() => validateScene(scene(Array.from({ length: 33 }, (_, i) => crop(`i${i}`, [0, 0, 1, 1]))), dimensions), /32 crop/);
});

test('path grammar rejects incomplete commands, injected attributes, invalid flags and unbounded numbers', () => {
  const validPath = d => scene([{ id: 'curve', type: 'path', d }]);
  for (const d of ['M 1 2 L 3', 'M 1 2 A 3 4 0 2 0 5 6', 'M0 0 <script/>', 'M0 0 L1e100 3', 'L0 0', 'M0 0 Z 1 2']) {
    assert.throws(() => validateScene(validPath(d), dimensions), /Invalid scene/);
  }
  assert.doesNotThrow(() => validateScene(validPath('M1 2 l3 -4 C1,2 3,4 5,6 A3 4 0 1 0 20 20 z'), dimensions));
});

test('text remains escaped native SVG and the compiler renders native objects', async () => {
  const sourcePng = await white();
  const input = scene([
    rect(),
    { id: 'label', type: 'text', x: 10, y: 60, text: 'A < B & "C"', fontSize: 12 },
    { id: 'oval', type: 'ellipse', cx: 60, cy: 20, rx: 5, ry: 8, fill: '#0000ff' },
    { id: 'edge', type: 'line', x1: 35, y1: 35, x2: 80, y2: 35, arrowEnd: true },
    { id: 'elbow', type: 'polyline', points: [[40, 50], [60, 50], [60, 65]], dash: [2, 3] },
    { id: 'curve', type: 'path', d: 'M75 55 Q80 45 85 55', stroke: '#00ff00' },
  ]);
  const { svg, png, stats } = await compileScene(input, { ...dimensions, sourcePng });
  assert.match(svg, /A &lt; B &amp; &quot;C&quot;/);
  assert.match(svg, /<text id="label"/);
  assert.match(svg, /marker-end="url\(#_arrow-edge-end\)"/);
  assert.equal(svg.includes('<image'), false);
  assert.deepEqual(stats, { elements: 6, texts: 1, images: 0, bitmapFraction: 0 });
  const rendered = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(rendered.info.width, 100);
  assert.equal(rendered.info.height, 80);
  const at = (20 * 100 + 20) * 4;
  assert.deepEqual([...rendered.data.subarray(at, at + 4)], [255, 0, 0, 255]);
});

test('embedded crop pixels preserve normalized source RGBA exactly, including partial alpha', async () => {
  const data = Buffer.alloc(100 * 80 * 4);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) {
    const offset = (y * 100 + x) * 4;
    data.set([x, y, (x + y) % 256, (x * 3 + y) % 256], offset);
  }
  const sourcePng = await sharp(data, { raw: { ...dimensions, channels: 4 } }).png().toBuffer();
  const { svg, stats } = await compileScene(scene([rect(), crop('icon', [10, 12, 30, 32])]), { ...dimensions, sourcePng });
  const embedded = Buffer.from(svg.match(/href="data:image\/png;base64,([^"]+)"/)[1], 'base64');
  const actual = await sharp(embedded).ensureAlpha().raw().toBuffer();
  const expected = await sharp(sourcePng).extract({ left: 10, top: 12, width: 20, height: 20 }).ensureAlpha().raw().toBuffer();
  assert.deepEqual(actual, expected);
  assert.deepEqual(stats, { elements: 2, texts: 0, images: 1, bitmapFraction: 0.05 });
  await assert.rejects(compileScene(scene(), { ...dimensions, sourcePng: Buffer.from('bad') }));
  const wrongSize = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } }).png().toBuffer();
  await assert.rejects(compileScene(scene(), { ...dimensions, sourcePng: wrongSize }), /matching the scene/);
});

test('arrow tip ends at the declared endpoint, without a stroke-width overshoot', async () => {
  const sourcePng = await white();
  const { png } = await compileScene(scene([
    { id: 'arrow', type: 'line', x1: 20, y1: 40, x2: 70, y2: 40, stroke: '#000000', strokeWidth: 4, arrowEnd: true },
  ]), { ...dimensions, sourcePng });
  const pixels = await sharp(png).removeAlpha().raw().toBuffer();
  const darkXs = [];
  for (let x = 0; x < 100; x++) {
    const offset = (40 * 100 + x) * 3;
    if (pixels[offset] < 128) darkXs.push(x);
  }
  assert.equal(Math.max(...darkXs), 69);
});

test('normalization handles JPEG EXIF rotation and strips metadata while producing sRGB PNG', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transform-svg-scene-'));
  try {
    const path = join(directory, 'oriented.jpg');
    const jpg = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#336699' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    await writeFile(path, jpg);
    const normalized = await normalizeImage(path);
    assert.equal(normalized.width, 8);
    assert.equal(normalized.height, 12);
    assert.equal(normalized.sourceInfo.orientation, 6);
    const metadata = await sharp(normalized.png).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.space, 'srgb');
    assert.equal(metadata.orientation, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(metadata.hasAlpha, true);
    const svgPath = join(directory, 'vector.svg');
    await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
    await assert.rejects(normalizeImage(svgPath), /PNG or JPEG/);
    const oversizedPath = join(directory, 'too-wide.png');
    await sharp({ create: { width: 20001, height: 1, channels: 3, background: '#ffffff' } }).png().toFile(oversizedPath);
    await assert.rejects(normalizeImage(oversizedPath), /20000 pixels per side/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
