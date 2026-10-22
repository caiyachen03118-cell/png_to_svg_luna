import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compileScene } from '../src/scene.mjs';

const width = 200, height = 200;
const sourcePng = await sharp({ create: { width, height, channels: 4, background: '#ffffff' } }).png().toBuffer();
async function raster(element) {
  const result = await compileScene({ width, height, background: '#ffffff', elements: [
    { id: 'arrow', fill: 'none', stroke: '#000000', strokeWidth: 2, ...element },
  ] }, { sourcePng, width, height });
  assert.doesNotMatch(result.svg, /auto-start-reverse/);
  const pixels = await sharp(result.png).removeAlpha().raw().toBuffer();
  return (x, y) => pixels[(Math.round(y) * width + Math.round(x)) * 3] < 128;
}

// At an arrow tip the raster wedge must narrow toward the outward direction.
// Sampling actual black pixels catches the prior marker rotation bug, which
// valid SVG XML/string assertions alone did not detect.
function checkTip(black, tip, outward) {
  const [tx, ty] = tip, [dx, dy] = outward, px = -dy, py = dx;
  const across = distance => {
    let count = 0;
    for (let s = -19; s <= 19; s++) if (black(tx - dx * distance + px * s, ty - dy * distance + py * s)) count++;
    return count;
  };
  assert.ok(across(12) >= across(3) + 6, `Arrow must narrow toward tip ${tip} facing ${outward}`);
  for (let distance = 2; distance <= 6; distance++) for (let s = -19; s <= 19; s++) {
    assert.equal(black(tx + dx * distance + px * s, ty + dy * distance + py * s), false,
      `Arrow must not extend beyond endpoint ${tip} facing ${outward}`);
  }
  assert.ok(across(1) > 0 || across(2) > 0, 'Arrow reaches its declared endpoint within antialiasing tolerance');
}

for (const [name, start, end, direction] of [
  ['right', [60, 100], [140, 100], [1, 0]],
  ['left', [140, 100], [60, 100], [-1, 0]],
  ['down', [100, 60], [100, 140], [0, 1]],
  ['up', [100, 140], [100, 60], [0, -1]],
]) {
  for (const mode of ['start', 'end', 'both']) test(`raster arrow ${mode} on ${name}-going line preserves direction and endpoint`, async () => {
    const arrowStart = mode !== 'end', arrowEnd = mode !== 'start';
    const black = await raster({ type: 'line', x1: start[0], y1: start[1], x2: end[0], y2: end[1], arrowStart, arrowEnd });
    if (arrowStart) checkTip(black, start, direction.map(v => -v));
    if (arrowEnd) checkTip(black, end, direction);
  });
}

test('polyline start and end follow different terminal segments', async () => {
  const black = await raster({ type: 'polyline', points: [[60, 60], [140, 60], [140, 140]], arrowStart: true, arrowEnd: true });
  checkTip(black, [60, 60], [-1, 0]);
  checkTip(black, [140, 140], [0, 1]);
});

test('cubic path arrows follow its start and end tangents', async () => {
  const black = await raster({ type: 'path', d: 'M60 60 C60 125 75 140 140 140', arrowStart: true, arrowEnd: true });
  checkTip(black, [60, 60], [0, -1]);
  checkTip(black, [140, 140], [1, 0]);
});

test('quadratic path arrows follow its start and end tangents', async () => {
  const black = await raster({ type: 'path', d: 'M60 140 Q140 140 140 60', arrowStart: true, arrowEnd: true });
  checkTip(black, [60, 140], [-1, 0]);
  checkTip(black, [140, 60], [0, -1]);
});
