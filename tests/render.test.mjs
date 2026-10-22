import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { initializeRun, renderProposal } from '../tools/render.mjs';

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'luna-render-test-'));
  try { await fn(directory); } finally {
    const target = resolve(directory), boundary = `${resolve(tmpdir())}${sep}`;
    if (!target.startsWith(boundary) || !target.includes('luna-render-test-')) throw new Error('Unexpected temporary cleanup target');
    await rm(target, { recursive: true, force: true });
  }
}
const basicScene = { width: 200, height: 160, background: '#ffffff', elements: [
  { id: 'box', type: 'rect', x: 20, y: 20, width: 50, height: 50, fill: '#ff0000', stroke: 'none' },
] };
async function white(path) { await sharp({ create: { width: 200, height: 160, channels: 4, background: '#fff' } }).png().toFile(path); }

test('init creates normalized source and refuses to overwrite existing run', async () => fixture(async directory => {
  const input = join(directory, 'input.png'), run = join(directory, 'run');
  await white(input);
  const result = await initializeRun(input, run);
  assert.equal(result.width, 200);
  assert.equal(result.height, 160);
  assert.equal(result.sourceSha256.length, 64);
  await assert.rejects(initializeRun(input, run), /EEXIST/);
  assert.equal(await readFile(join(run, 'render-events.jsonl'), 'utf8'), '');
}));

test('render preserves versions and counts failed proposals toward the three-attempt limit', async () => fixture(async directory => {
  const input = join(directory, 'input.png'), run = join(directory, 'run'), proposal = join(directory, 'proposal.json');
  await white(input);
  await initializeRun(input, run);
  await writeFile(proposal, JSON.stringify(basicScene));
  const first = await renderProposal(run, proposal, 'v01');
  assert.equal(first.attempt, 1);
  const firstFiles = await readdir(join(run, 'v01'));
  const svgBefore = await readFile(first.svg);
  await assert.rejects(renderProposal(run, proposal, 'v01'), /EEXIST/);
  assert.deepEqual(await readdir(join(run, 'v01')), firstFiles);
  assert.deepEqual(await readFile(first.svg), svgBefore);
  await writeFile(proposal, '{invalid json');
  await assert.rejects(renderProposal(run, proposal, 'v03'), /JSON|property|Expected/);
  await assert.rejects(renderProposal(run, proposal, 'v02'), /limit reached/);
  const events = (await readFile(join(run, 'render-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'attempt').length, 3);
  assert.equal(events.filter(e => e.event === 'success').length, 1);
  assert.equal(events.filter(e => e.event === 'failure').length, 2);
  assert.equal(events[3].version, 'v01');
  assert.match(await readFile(join(run, 'v03', 'error.json'), 'utf8'), /failure/);
}));

test('render records submitted and adopted icon boxes plus actual raster feedback', async () => fixture(async directory => {
  const input = join(directory, 'input.png'), run = join(directory, 'run'), proposal = join(directory, 'proposal.json');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="260" height="180"><rect width="260" height="180" fill="white"/><rect x="70" y="45" width="60" height="65" rx="6" fill="#ecf2fa" stroke="#23334c" stroke-width="4"/><circle cx="100" cy="72" r="10" fill="#4285b4"/><path d="M85 94 H115" stroke="#23334c" stroke-width="4"/></svg>')).png().toFile(input);
  await initializeRun(input, run);
  const scene = { width: 260, height: 180, background: '#fff', elements: [{ id: 'device', type: 'image', kind: 'icon', bbox_px: [78, 48, 118, 103], reason: 'Complex icon.' }] };
  await writeFile(proposal, JSON.stringify(scene));
  const result = await renderProposal(run, proposal, 'v01');
  const submitted = JSON.parse(await readFile(join(run, 'v01', 'submitted.json'), 'utf8'));
  const adopted = JSON.parse(await readFile(result.scene, 'utf8'));
  const audit = JSON.parse(await readFile(result.cropAudit, 'utf8'));
  assert.deepEqual(submitted, scene);
  assert.deepEqual(adopted.elements[0].bbox_px, audit.items[0].finalBox);
  assert.notDeepEqual(adopted.elements[0].bbox_px, scene.elements[0].bbox_px);
  assert.deepEqual(result.repairedCropIds, ['device']);
  assert.equal((await sharp(result.cropReview).metadata()).width, 660);
  assert.equal((await sharp(result.preview).metadata()).width, 260);
  assert.equal(result.apiCalls, 0);
}));

test('render rejects changed normalized source and leaves recorded failed attempt', async () => fixture(async directory => {
  const input = join(directory, 'input.png'), run = join(directory, 'run'), proposal = join(directory, 'proposal.json');
  await white(input);
  await initializeRun(input, run);
  await writeFile(proposal, JSON.stringify(basicScene));
  await writeFile(join(run, 'source.png'), 'changed');
  await assert.rejects(renderProposal(run, proposal, 'v01'), /hash changed/);
  assert.match(await readFile(join(run, 'render-events.jsonl'), 'utf8'), /failure/);
}));
