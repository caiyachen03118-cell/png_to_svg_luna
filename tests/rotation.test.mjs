import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';
import { compileScene, validateScene } from '../src/scene.mjs';

const dimensions = { width: 512, height: 512 };
const label = patch => ({ id: 'label', type: 'text', x: 220, y: 220, text: 'Rotate',
  fontFamily: 'Arial', fontSize: 32, fill: '#000000', ...patch });
const scene = element => ({ ...dimensions, background: '#ffffff', elements: [element] });
const sourcePng = await sharp({ create: { ...dimensions, channels: 4, background: '#ffffff' } }).png().toBuffer();
const compile = element => compileScene(scene(element), { ...dimensions, sourcePng });

async function inkBox(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 3] >= 128) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  assert.ok(right >= left && bottom >= top, 'text must actually render');
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

test('rotation accepts only finite numeric degrees in [-360,360], and only on text', () => {
  for (const rotation of [-360, -90, -12.5, 0, 90, 360]) {
    const valid = validateScene(scene(label({ rotation })), dimensions);
    assert.equal(valid.elements[0].rotation, rotation);
  }
  for (const rotation of [-360.01, 360.01, NaN, Infinity, -Infinity, null, '90', [], {}]) {
    assert.throws(() => validateScene(scene(label({ rotation })), dimensions), /rotation must be a number/);
  }
  const unsupported = [
    { type: 'rect', x: 1, y: 1, width: 20, height: 20 },
    { type: 'ellipse', cx: 30, cy: 30, rx: 10, ry: 10 },
    { type: 'line', x1: 10, y1: 10, x2: 30, y2: 10 },
    { type: 'polyline', points: [[10, 10], [30, 10]] },
    { type: 'path', d: 'M10 10 L30 10' },
    { type: 'image', bbox_px: [10, 10, 30, 30], kind: 'icon', reason: 'Fixture icon.' },
  ];
  for (const element of unsupported) {
    assert.throws(() => validateScene(scene({ id: 'object', ...element, rotation: 90 }), dimensions), /rotation is not supported/);
  }
});

test('zero and omitted rotation preserve horizontal rendering and editable escaped text', async () => {
  const text = `A < B & "C" 'D'`;
  const plain = await compile(label({ text }));
  const zero = await compile(label({ text, rotation: 0 }));
  assert.deepEqual(zero.png, plain.png);
  assert.doesNotMatch(plain.svg, /transform=/);
  assert.match(zero.svg, /<text id="label"[^>]*transform="rotate\(0 220 220\)"/);
  assert.match(zero.svg, /A &lt; B &amp; &quot;C&quot; &apos;D&apos;/);
  assert.equal((zero.svg.match(/<text /g) ?? []).length, 1);
  assert.doesNotMatch(zero.svg, /<image|<path/);
});

test('+90 and -90 rotate actual glyph bounds around the declared baseline anchor', async () => {
  const horizontal = await inkBox((await compile(label())).png);
  assert.ok(horizontal.width > horizontal.height * 3, 'fixture is visibly wider than tall');
  for (const rotation of [90, -90]) {
    const actual = await inkBox((await compile(label({ rotation }))).png);
    assert.ok(actual.height > actual.width * 3, `${rotation} text must be vertical`);
    // Rotate pixel centers rather than rectangle edges. The -1 accounts for
    // the half-pixel position when an axis reverses at an integer pivot.
    const expected = rotation === 90 ? {
      left: 440 - horizontal.bottom - 1, right: 440 - horizontal.top - 1,
      top: horizontal.left, bottom: horizontal.right,
    } : {
      left: horizontal.top, right: horizontal.bottom,
      top: 440 - horizontal.right - 1, bottom: 440 - horizontal.left - 1,
    };
    for (const key of ['left', 'top', 'right', 'bottom']) {
      assert.ok(Math.abs(actual[key] - expected[key]) <= 1,
        `${rotation} ${key}: ${actual[key]} must follow pivot geometry ${expected[key]}`);
    }
  }
});

test('rotated native text matches independent translate/rotate pivot rendering with text styling intact', async () => {
  for (const rotation of [90, -90, 27.5]) {
    const input = label({ x: 256, y: 252, text: `A < B & "C"`, rotation,
      fontWeight: 700, fontStyle: 'italic', textAnchor: 'end', letterSpacing: 1.5 });
    const actual = await compile(input);
    assert.match(actual.svg, new RegExp(`transform="rotate\\(${rotation} 256 252\\)"`));
    assert.match(actual.svg, /font-weight="700" font-style="italic" text-anchor="end" letter-spacing="1.5"/);
    assert.match(actual.svg, /A &lt; B &amp; &quot;C&quot;/);
    const referenceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <rect width="512" height="512" fill="#ffffff"/>
      <g transform="translate(256 252) rotate(${rotation})">
        <text x="0" y="0" fill="#000000" stroke="none" font-family="Arial" font-size="32"
          font-weight="700" font-style="italic" text-anchor="end" letter-spacing="1.5"
          xml:space="preserve">A &lt; B &amp; &quot;C&quot;</text>
      </g></svg>`;
    const expected = new Resvg(referenceSvg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng();
    const [actualPixels, expectedPixels] = await Promise.all([
      sharp(actual.png).ensureAlpha().raw().toBuffer(),
      sharp(expected).ensureAlpha().raw().toBuffer(),
    ]);
    assert.deepEqual(actualPixels, expectedPixels, `${rotation}: rendered glyphs must retain the same baseline pivot`);
  }
});
