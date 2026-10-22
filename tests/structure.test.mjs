import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStructureInventory, checkStructure } from '../src/structure.mjs';

const ctx = { width: 200, height: 160 };
const inventory = (icons = [], connectors = []) => ({ texts: [], objects: [], icons, connectors,
  structureCoverage: { icons: icons.length ? 'listed' : 'none', connectors: connectors.length ? 'listed' : 'none', note: 'Source was inspected at full resolution, including small icons and heads.' } });
const icon = { id: 'calculator', bbox: [10, 10, 30, 30], description: 'Calculator', representation: 'image' };
const connector = { id: 'flow', from: [40, 50], to: [120, 50], heads: 'end', description: 'Left to right flow' };
const image = { id: 'crop', type: 'image', bbox_px: [9, 9, 31, 31], kind: 'icon' };
const line = { id: 'shaft', type: 'line', x1: 40, y1: 50, x2: 120, y2: 50, arrowEnd: true, stroke: '#000000', strokeWidth: 2 };
const scene = elements => ({ ...ctx, elements });
const iconReview = elementIds => ({ inventoryId: 'calculator', elementIds, status: 'accepted', note: 'Compared the whole calculator and all its buttons in source and final render.' });
const connectorReview = (lineIds = ['shaft'], headIds) => ({ inventoryId: 'flow', lineIds, ...(headIds ? { headIds } : {}), status: 'accepted', note: 'Compared source head position and rendered direction.' });
const codes = result => result.issues.map(i => i.code);
const checkLine = (elements, spec = connector, review = connectorReview()) => checkStructure(inventory([], [spec]), scene(elements), { connectorChecks: [review] }, ctx);

test('source inventory requires explicit categories, coverage and unique source IDs', () => {
  assert.equal(validateStructureInventory(inventory([icon], [connector]), ctx).icons.length, 1);
  assert.throws(() => validateStructureInventory({ texts: [] }, ctx), /structureCoverage/);
  const wrongCoverage = inventory([icon]); wrongCoverage.structureCoverage.icons = 'none';
  assert.throws(() => validateStructureInventory(wrongCoverage, ctx), /disagrees/);
  assert.throws(() => validateStructureInventory({ ...inventory([icon]), texts: [{ id: icon.id }] }, ctx), /duplicate/);
  assert.throws(() => validateStructureInventory(inventory([{ ...icon, id: undefined }]), ctx), /invalid ID/);
  assert.throws(() => validateStructureInventory(inventory([{ ...icon, bbox: [-1, 0, 3, 4] }]), ctx), /in-canvas/);
  assert.throws(() => validateStructureInventory(inventory([], [{ ...connector, tolerance: 100 }]), ctx), /tolerance/);
  assert.throws(() => validateStructureInventory(inventory([], [{ ...connector, to: [40, 50] }]), ctx), /must differ/);
});

test('omitted icon check or empty mapping is incomplete; explicit missing icon and text replacement are defects', () => {
  let result = checkStructure(inventory([icon]), scene([]), {}, ctx);
  assert.equal(result.issues[0].code, 'unchecked'); assert.equal(result.issues[0].incomplete, true);
  result = checkStructure(inventory([icon]), scene([]), { iconChecks: [iconReview([])] }, ctx);
  assert.equal(result.issues.find(i => i.code === 'missing_mapping').incomplete, true);
  result = checkStructure(inventory([icon]), scene([]), { iconChecks: [{ ...iconReview([]), status: 'issue', note: 'Calculator is absent from the render.' }] }, ctx);
  assert.equal(result.issues.find(i => i.code === 'declared_issue').incomplete, false);
  result = checkStructure(inventory([icon]), scene([{ id: 'letters', type: 'text', text: 'Σ x =' }]), { iconChecks: [iconReview(['letters'])] }, ctx);
  assert.ok(codes(result).includes('wrong_representation'));
});

test('pending inspection blocks acceptance without inventing a confirmed defect', () => {
  const result = checkStructure(inventory([icon], [connector]), scene([image, line]), {
    iconChecks: [{ ...iconReview(['crop']), status: 'pending' }], connectorChecks: [{ ...connectorReview(), status: 'pending' }],
  }, ctx);
  assert.equal(result.status, 'issues');
  assert.equal(result.issues.length, 2);
  assert.ok(result.issues.every(i => i.code === 'pending_review' && i.incomplete));
  const wrongId = checkLine([line], connector, connectorReview(['typo-shaft']));
  assert.ok(wrongId.issues.length > 0);
  assert.ok(wrongId.issues.every(i => i.incomplete), 'A misspelled mapping alone must not force a new render');
  const wrongHeadId = checkLine([{ ...line, arrowEnd: false }], connector, connectorReview(['shaft'], { end: ['typo-head'] }));
  assert.ok(wrongHeadId.issues.length > 0);
  assert.ok(wrongHeadId.issues.every(i => i.incomplete), 'A misspelled head mapping alone must not force a new render');
});

test('image crop coverage checks the actual saved bbox, including automatic shrinkage', () => {
  const run = e => checkStructure(inventory([icon]), scene([e]), { iconChecks: [iconReview(['crop'])] }, ctx);
  assert.equal(run(image).status, 'passed');
  assert.ok(codes(run({ ...image, bbox_px: [10, 10, 30, 25] })).includes('crop_clipped'));
  assert.ok(codes(run({ ...image, bbox_px: [0, 0, 80, 80] })).includes('crop_excess_padding'));
  assert.ok(codes(checkStructure(inventory(), scene([image]), {}, ctx)).includes('extra_image'));
});

test('native icon needs actual visible geometry and explicit visual declaration', () => {
  const inv = inventory([{ ...icon, representation: 'vector' }]), rect = { id: 'symbol', type: 'rect', x: 10, y: 10, width: 20, height: 20, fill: '#121212', stroke: 'none' };
  const run = (e, visualMatch) => checkStructure(inv, scene([e]), { iconChecks: [{ ...iconReview(['symbol']), ...(visualMatch !== undefined ? { visualMatch } : {}) }] }, ctx);
  assert.ok(codes(run(rect)).includes('visual_match_unconfirmed'));
  assert.equal(run(rect, true).status, 'passed');
  assert.ok(codes(run({ ...rect, opacity: 0 }, true)).includes('wrong_representation'));
  assert.ok(codes(run({ ...rect, x: 120 }, true)).includes('icon_position_mismatch'));
});

test('native line heads are normalized when geometry is reversed', () => {
  assert.equal(checkLine([line]).status, 'passed');
  const backwards = { ...line, x1: 120, x2: 40, arrowEnd: false, arrowStart: true };
  assert.equal(checkLine([backwards]).status, 'passed');
  const wrong = checkLine([{ ...backwards, arrowStart: false, arrowEnd: true }]);
  assert.ok(codes(wrong).includes('unexpected_start_head'));
  assert.ok(codes(wrong).includes('missing_end_head'));
});

test('missing connector mapping, text arrows and transparent strokes fail deterministically', () => {
  assert.ok(codes(checkLine([], connector, connectorReview([]))).includes('missing_mapping'));
  assert.ok(codes(checkLine([{ id: 'shaft', type: 'text', text: '→' }])).includes('wrong_representation'));
  for (const change of [{ opacity: 0 }, { stroke: '#00000000' }, { stroke: 'none' }, { strokeWidth: 0 }]) {
    assert.ok(codes(checkLine([{ ...line, ...change }])).includes('invisible_connector'));
  }
});

test('polyline and contiguous reversed multi-element chain pass; gaps and interior heads fail', () => {
  assert.equal(checkLine([{ id: 'shaft', type: 'polyline', points: [[40, 50], [70, 80], [120, 50]], arrowEnd: true }]).status, 'passed');
  const pieces = [{ ...line, id: 'a', x2: 80, arrowEnd: false }, { ...line, id: 'b', x1: 120, x2: 80, arrowEnd: false, arrowStart: true }];
  assert.equal(checkLine(pieces, connector, connectorReview(['b', 'a'])).status, 'passed');
  assert.ok(codes(checkLine([{ ...pieces[0], x2: 60 }, pieces[1]], connector, connectorReview(['a', 'b']))).includes('endpoint_or_continuity_mismatch'));
  assert.ok(codes(checkLine([{ ...pieces[0], arrowEnd: true }, pieces[1]], connector, connectorReview(['a', 'b']))).includes('interior_arrowhead'));
});

test('SVG path endpoint parser handles absolute, relative, implicit lines and curve families', () => {
  for (const d of [
    'M40 50 L120 50', 'm40 50 l80 0', 'M40 50 80 50 120 50', 'M40 50 H80 V70 h40 v-20',
    'M40 50 C60 30 100 30 120 50', 'M40 50 Q80 10 120 50', 'M40 50 C55 40 60 40 80 50 S100 70 120 50',
    'M40 50 Q60 20 80 50 T120 50', 'M40 50 A40 20 30 0 1 120 50', 'm40 50 a40 20 0 0 0 80 0',
  ]) assert.equal(checkLine([{ id: 'shaft', type: 'path', d, arrowEnd: true }]).status, 'passed', d);
  for (const d of ['M40 50 L120 50 Z', 'M40 50L70 50 M80 50L120 50', 'M40 50 L50', 'M40 50 R120 50']) {
    assert.ok(codes(checkLine([{ id: 'shaft', type: 'path', d, arrowEnd: true }])).includes('invalid_geometry'), d);
  }
});

test('separate triangle arrow must be visible, nearby and point in the measured direction', () => {
  const shaft = { ...line, arrowEnd: false }, head = { id: 'head', type: 'path', d: 'M120 50 L110 45 L110 55 Z', fill: '#000000', stroke: 'none' };
  const run = e => checkLine([shaft, e], connector, connectorReview(['shaft'], { end: ['head'] }));
  assert.equal(run(head).status, 'passed');
  assert.ok(codes(run({ ...head, d: 'M120 50 L130 45 L130 55 Z' })).includes('head_direction_or_position_mismatch'));
  assert.ok(codes(run({ ...head, d: 'M160 50 L150 45 L150 55 Z' })).includes('head_direction_or_position_mismatch'));
  assert.ok(codes(run({ ...head, opacity: 0 })).includes('invalid_head_geometry'));
  assert.ok(codes(run({ ...head, fill: '#00000000' })).includes('invalid_head_geometry'));
  assert.ok(codes(run({ ...head, d: 'M120 50 C110 45 110 55 120 50 Z' })).includes('invalid_head_geometry'));
});

test('separate start head correctly follows reverse outward tangent on a curved connector', () => {
  const spec = { ...connector, heads: 'both' };
  const curve = { id: 'shaft', type: 'path', d: 'M40 50 C40 80 120 80 120 50', arrowEnd: true };
  const startHead = { id: 'head', type: 'polyline', points: [[40, 50], [35, 60], [45, 60]], fill: '#000000', stroke: 'none' };
  assert.equal(checkLine([curve, startHead], spec, connectorReview(['shaft'], { start: ['head'] })).status, 'passed');
  assert.ok(codes(checkLine([curve, { ...startHead, points: [[40, 50], [35, 40], [45, 40]] }], spec, connectorReview(['shaft'], { start: ['head'] }))).includes('head_direction_or_position_mismatch'));
});

test('review issue cannot be hidden by otherwise passing geometry; local comparison regions cover source', () => {
  const result = checkStructure(inventory([icon], [connector]), scene([image, line]), { iconChecks: [{ ...iconReview(['crop']), status: 'issue', note: 'Robot arms still clipped.' }], connectorChecks: [connectorReview()] }, ctx);
  assert.equal(result.status, 'issues');
  assert.equal(result.icons[0].status, 'issue');
  assert.equal(result.connectors[0].status, 'accepted');
  assert.equal(result.issues.find(i => i.code === 'declared_issue').incomplete, false);
  assert.deepEqual(result.reviewRegions[0].sourceBbox, [10, 10, 30, 30]);
  assert.deepEqual(result.reviewRegions[1].sourceBbox, [28, 38, 132, 62]);
});
