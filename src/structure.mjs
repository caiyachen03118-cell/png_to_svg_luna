// Deterministic checks against a model-authored source inventory. The inventory
// itself and visual declarations are candidates for review, not ground truth.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = v => { const n = Math.hypot(...v); return n ? v.map(x => x / n) : [0, 0]; };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const paint = value => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value) && (value.length !== 9 || parseInt(value.slice(7), 16) > 0);
const strokeVisible = e => (e.opacity ?? 1) > 0 && paint(e.stroke ?? '#000000') && (e.strokeWidth ?? 1) > 0;
const visible = e => (e.opacity ?? 1) > 0 && (paint(e.fill ?? 'none') || strokeVisible(e));
const boxOf = points => [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
const unionBox = boxes => boxOf(boxes.flatMap(b => [[b[0], b[1]], [b[2], b[3]]]));
const check = (condition, message) => { if (!condition) throw new Error(`Invalid structure inventory: ${message}`); };

export function validateStructureInventory(inventory, { width, height }) {
  check(inventory && typeof inventory === 'object', 'object required');
  check(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, 'source dimensions required');
  const ids = new Set();
  for (const row of [...(inventory.texts ?? []), ...(inventory.objects ?? [])]) {
    check(row && validId(row.id) && !ids.has(row.id), `duplicate or invalid ID ${row?.id}`); ids.add(row.id);
  }
  const point = (p, label) => check(Array.isArray(p) && p.length === 2 && p.every((v, i) => finite(v) && v >= 0 && v <= (i ? height : width)), `${label} must be an in-canvas [x,y] point`);
  const coverage = inventory.structureCoverage;
  check(coverage && nonempty(coverage.note), 'structureCoverage requires a nonempty note');
  for (const kind of ['icons', 'connectors']) {
    check(Array.isArray(inventory[kind]) && inventory[kind].length <= 1000, `${kind} must be an explicit array (maximum 1000)`);
    check(['listed', 'none'].includes(coverage[kind]), `structureCoverage.${kind} must be listed or none`);
    check(coverage[kind] === 'listed' ? inventory[kind].length > 0 : inventory[kind].length === 0, `${kind} array disagrees with structureCoverage.${kind}`);
    for (const row of inventory[kind]) {
      check(row && validId(row.id) && !ids.has(row.id), `duplicate or invalid ID ${row?.id}`); ids.add(row.id);
      check(nonempty(row.description), `${row.id} requires description`);
      if (kind === 'icons') {
        check(Array.isArray(row.bbox) && row.bbox.length === 4 && row.bbox.every(Number.isInteger), `${row.id} bbox must contain four integers`);
        point(row.bbox.slice(0, 2), `${row.id} bbox start`); point(row.bbox.slice(2), `${row.id} bbox end`);
        check(row.bbox[2] > row.bbox[0] && row.bbox[3] > row.bbox[1], `${row.id} bbox must have positive area`);
        check(['image', 'vector'].includes(row.representation), `${row.id} representation must be image or vector`);
      } else {
        point(row.from, `${row.id}.from`); point(row.to, `${row.id}.to`);
        check(distance(row.from, row.to) > 0, `${row.id} from/to must differ`);
        check(['start', 'end', 'both', 'none'].includes(row.heads), `${row.id}.heads is invalid`);
        if (row.tolerance !== undefined) check(finite(row.tolerance) && row.tolerance >= 1 && row.tolerance <= 30, `${row.id}.tolerance must be in [1,30]`);
      }
    }
  }
  return inventory;
}

// Paths are parsed only to establish geometry, not rendered or evaluated as code.
// Curves retain endpoint tangents; multiple subpaths are intentionally rejected
// for a connector because their continuity cannot be inferred from one ID.
function parsePath(d) {
  if (typeof d !== 'string') throw new Error('path d is missing');
  const tokens = [], re = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  let last = 0;
  for (const match of d.matchAll(re)) {
    if (!/^[\s,]*$/.test(d.slice(last, match.index))) throw new Error('invalid path syntax');
    tokens.push(match[0]); last = match.index + match[0].length;
  }
  if (!/^[\s,]*$/.test(d.slice(last)) || !/^[Mm]$/.test(tokens[0] ?? '')) throw new Error('path must start with M');
  const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let i = 0, current = [0, 0], sub, previous, control;
  const paths = [], allPoints = [];
  const add = (end, startControl = end, endControl = current, straight = false) => {
    const start = [...current], st = subtract(startControl, start), et = subtract(end, endControl);
    sub.segments.push({ start, end: [...end], startTangent: Math.hypot(...st) ? st : subtract(end, start), endTangent: Math.hypot(...et) ? et : subtract(end, start) });
    sub.vertices.push([...end]); sub.straight &&= straight; allPoints.push(startControl, endControl, end); current = [...end];
  };
  while (i < tokens.length) {
    const command = tokens[i++], upper = command.toUpperCase(), relative = command !== upper;
    if (!(upper in arity)) throw new Error('path requires command');
    const args = [];
    while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) { const value = Number(tokens[i++]); if (!finite(value)) throw new Error('nonfinite path coordinate'); args.push(value); }
    if (upper === 'Z') {
      if (args.length || !sub) throw new Error('invalid close command');
      if (distance(current, sub.start) > 0) add(sub.start, sub.start, current, true);
      sub.closed = true; current = [...sub.start]; previous = 'Z'; control = null; continue;
    }
    if (!args.length || args.length % arity[upper]) throw new Error('invalid path arity');
    for (let offset = 0; offset < args.length; offset += arity[upper]) {
      const a = args.slice(offset, offset + arity[upper]), cmd = upper === 'M' && offset ? 'L' : upper;
      const p = (x, y) => [x + (relative ? current[0] : 0), y + (relative ? current[1] : 0)];
      if (cmd === 'M') {
        current = p(a[0], a[1]); sub = { start: [...current], vertices: [[...current]], segments: [], closed: false, straight: true }; paths.push(sub); allPoints.push(current);
      } else if (!sub) throw new Error('missing subpath');
      else if (cmd === 'L') add(p(a[0], a[1]), p(a[0], a[1]), current, true);
      else if (cmd === 'H') { const end = [a[0] + (relative ? current[0] : 0), current[1]]; add(end, end, current, true); }
      else if (cmd === 'V') { const end = [current[0], a[0] + (relative ? current[1] : 0)]; add(end, end, current, true); }
      else if (cmd === 'C') { const c1 = p(a[0], a[1]), c2 = p(a[2], a[3]), end = p(a[4], a[5]); add(end, c1, c2); control = c2; }
      else if (cmd === 'S') { const c1 = ['C', 'S'].includes(previous) && control ? [2 * current[0] - control[0], 2 * current[1] - control[1]] : current; const c2 = p(a[0], a[1]), end = p(a[2], a[3]); add(end, c1, c2); control = c2; }
      else if (cmd === 'Q') { const c = p(a[0], a[1]), end = p(a[2], a[3]); add(end, c, c); control = c; }
      else if (cmd === 'T') { const c = ['Q', 'T'].includes(previous) && control ? [2 * current[0] - control[0], 2 * current[1] - control[1]] : current; add(p(a[0], a[1]), c, c); control = c; }
      else if (cmd === 'A') {
        if (a[0] < 0 || a[1] < 0 || ![0, 1].includes(a[3]) || ![0, 1].includes(a[4])) throw new Error('invalid arc flags');
        const end = p(a[5], a[6]), tangents = arcTangents(current, end, a);
        add(end, [current[0] + tangents[0][0], current[1] + tangents[0][1]], [end[0] - tangents[1][0], end[1] - tangents[1][1]]);
      }
      if (!['C', 'S', 'Q', 'T'].includes(cmd)) control = null;
      previous = cmd;
    }
  }
  return { paths, allPoints };
}

function arcTangents(start, end, [rx0, ry0, degrees, large, sweep]) {
  const fallback = subtract(end, start);
  if (!rx0 || !ry0 || !Math.hypot(...fallback)) return [fallback, fallback];
  const phi = degrees * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi);
  const xp = c * (start[0] - end[0]) / 2 + s * (start[1] - end[1]) / 2, yp = -s * (start[0] - end[0]) / 2 + c * (start[1] - end[1]) / 2;
  const scale = Math.max(1, Math.sqrt(xp * xp / (rx0 * rx0) + yp * yp / (ry0 * ry0))), rx = rx0 * scale, ry = ry0 * scale;
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp), denominator = rx * rx * yp * yp + ry * ry * xp * xp;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(numerator / denominator), cx = factor * rx * yp / ry, cy = -factor * ry * xp / rx;
  const tangent = (x, y) => { const dx = -rx * y, dy = ry * x, sign = sweep ? 1 : -1; return [sign * (c * dx - s * dy), sign * (s * dx + c * dy)]; };
  return [tangent((xp - cx) / rx, (yp - cy) / ry), tangent((-xp - cx) / rx, (-yp - cy) / ry)];
}

function geometry(e) {
  let path;
  if (e.type === 'line') path = { start: [e.x1, e.y1], vertices: [[e.x1, e.y1], [e.x2, e.y2]], closed: false, straight: true };
  else if (e.type === 'polyline') path = { start: e.points[0], vertices: e.points, closed: distance(e.points[0], e.points.at(-1)) < 1e-6, straight: true };
  else if (e.type === 'path') {
    const parsed = parsePath(e.d); if (parsed.paths.length !== 1) throw new Error('connector has multiple subpaths'); path = parsed.paths[0];
  } else throw new Error('connector requires line, polyline or path');
  const points = path.vertices, start = path.start, end = points.at(-1);
  if (!points.every(p => p.length === 2 && p.every(finite)) || path.closed || distance(start, end) < 1e-6) throw new Error('connector needs a single open nonzero path');
  const first = path.segments?.find(s => distance(s.start, s.end) > 0), last = path.segments?.findLast(s => distance(s.start, s.end) > 0);
  const next = points.find(p => distance(p, start) > 0), prior = [...points].reverse().find(p => distance(p, end) > 0);
  return { id: e.id, start, end, startTangent: first?.startTangent ?? subtract(next, start), endTangent: last?.endTangent ?? subtract(end, prior), arrowStart: !!e.arrowStart, arrowEnd: !!e.arrowEnd };
}

function chainGeometry(edges, from, to, tolerance) {
  let visits = 0, best = null;
  const walk = (current, remaining, chain, error) => {
    if (++visits > 4096) return;
    if (!remaining.length) { const endError = distance(current, to); if (endError <= tolerance && (!best || error + endError < best.error)) best = { chain, error: error + endError }; return; }
    const candidates = [];
    remaining.forEach((edge, i) => { for (const reverse of [false, true]) { const d = distance(current, reverse ? edge.end : edge.start); if (d <= (chain.length ? Math.min(tolerance, 3) : tolerance)) candidates.push({ edge, i, reverse, d }); } });
    candidates.sort((a, b) => a.d - b.d);
    for (const { edge, i, reverse, d } of candidates) {
      const oriented = reverse ? { ...edge, start: edge.end, end: edge.start, startTangent: edge.endTangent.map(v => -v), endTangent: edge.startTangent.map(v => -v), arrowStart: edge.arrowEnd, arrowEnd: edge.arrowStart, reversed: true } : { ...edge, reversed: false };
      walk(oriented.end, remaining.filter((_, j) => i !== j), [...chain, oriented], error + d);
    }
  };
  walk(from, edges, [], 0);
  return best?.chain ?? null;
}

function elementBounds(e) {
  if (e.type === 'image') return e.bbox_px;
  if (e.type === 'rect') return [e.x, e.y, e.x + e.width, e.y + e.height];
  if (e.type === 'ellipse') return [e.cx - e.rx, e.cy - e.ry, e.cx + e.rx, e.cy + e.ry];
  if (e.type === 'line') return boxOf([[e.x1, e.y1], [e.x2, e.y2]]);
  if (e.type === 'polyline') return boxOf(e.points);
  if (e.type === 'path') return boxOf(parsePath(e.d).allPoints);
  return null;
}

function trianglePoints(e) {
  let points;
  if (!visible(e)) throw new Error('arrowhead is invisible');
  if (e.type === 'path') { const p = parsePath(e.d); if (p.paths.length !== 1 || !p.paths[0].straight || !p.paths[0].closed) throw new Error('head must be a closed straight triangle'); points = p.paths[0].vertices; }
  else if (e.type === 'polyline' && e.points.length >= 3) { points = e.points; if (!paint(e.fill ?? 'none') && distance(points[0], points.at(-1)) > 1e-6) throw new Error('unfilled head must be closed'); }
  else throw new Error('head must be a triangle path or polyline');
  const unique = points.filter((p, i) => !points.slice(0, i).some(q => distance(p, q) < 1e-6));
  if (unique.length !== 3) throw new Error('head must have exactly three vertices');
  const [a, b, c] = unique;
  if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1) throw new Error('head triangle is degenerate');
  return unique;
}

function correctTriangle(e, endpoint, expectedDirection, tolerance) {
  const points = trianglePoints(e), direction = unit(expectedDirection), normal = [-direction[1], direction[0]];
  if (!Math.hypot(...direction)) return false;
  return points.some((tip, index) => {
    if (distance(tip, endpoint) > tolerance) return false;
    const base = points.filter((_, j) => j !== index).map(p => subtract(p, tip));
    // Both base corners must be behind the tip and straddle the tangent axis.
    // Existence/centroid alone would accept a reversed triangle at this endpoint.
    return base.every(v => dot(v, direction) < -0.1) && dot(base[0], normal) * dot(base[1], normal) <= 0;
  });
}

export function checkStructure(inventory, scene, review = {}, ctx) {
  validateStructureInventory(inventory, ctx);
  const elements = new Map(scene.elements.map(e => [e.id, e])), issues = [], icons = [], connectors = [], reviewRegions = [], usedImages = new Set();
  const issue = (kind, inventoryId, code, message, elementIds = [], incomplete = false) => {
    const row = { id: `structure-${inventoryId}-${code}`, kind, inventoryId, code, message, elementIds, incomplete };
    if (!issues.some(x => x.id === row.id)) issues.push(row);
  };
  const rows = (key, expected) => {
    const map = new Map(), input = review[key];
    if (input !== undefined && !Array.isArray(input)) issue('inventory', key, 'invalid_checks', `${key} must be an array`, [], true);
    for (const row of Array.isArray(input) ? input : []) {
      if (!row || !expected.some(x => x.id === row.inventoryId)) { issue('inventory', key, 'unknown_check', `Unknown ${key} inventory ID`, [], true); continue; }
      if (map.has(row.inventoryId)) issue(key === 'iconChecks' ? 'icon' : 'connector', row.inventoryId, 'duplicate_check', 'Duplicate review entry', [], true);
      else map.set(row.inventoryId, row);
    }
    return map;
  };
  const iconRows = rows('iconChecks', inventory.icons), connectorRows = rows('connectorChecks', inventory.connectors);
  const startRow = (kind, item, row) => {
    if (!row) { issue(kind, item.id, 'unchecked', 'Source item has no review entry', [], true); return false; }
    if (!['accepted', 'issue', 'pending'].includes(row.status) || !nonempty(row.note)) issue(kind, item.id, 'incomplete_review', 'Review needs accepted/issue/pending status and a nonempty note', [], true);
    if (row.status === 'pending') issue(kind, item.id, 'pending_review', 'Source/preview inspection is pending', [], true);
    return true;
  };
  const declaredIssue = (kind, item, row, elementIds) => {
    // Bind declared defects to the validated mapping, just like geometry
    // diagnostics. Closure needs the actual discovery elements/crop footprint.
    if (row?.status === 'issue') issue(kind, item.id, 'declared_issue', row.note || 'Reviewer reports an issue', elementIds);
  };
  const idList = (kind, item, value, label) => {
    if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length) {
      issue(kind, item.id, 'missing_mapping', `Source item requires distinct ${label}`, [], true); return [];
    }
    for (const id of value) if (!elements.has(id)) issue(kind, item.id, 'missing_element', `Mapped scene element ${id} is missing; correct the mapping or explicitly report a missing object`, value, true);
    return value;
  };
  for (const item of inventory.icons) {
    const row = iconRows.get(item.id);
    startRow('icon', item, row);
    const ids = row ? idList('icon', item, row.elementIds, 'elementIds') : [], mapped = ids.map(id => elements.get(id)).filter(Boolean);
    declaredIssue('icon', item, row, ids);
    mapped.filter(e => e.type === 'image').forEach(e => usedImages.add(e.id));
    if (mapped.length) {
      if (item.representation === 'image') {
        const images = mapped.filter(e => e.type === 'image');
        if (!images.length) issue('icon', item.id, 'wrong_representation', 'Image inventory item needs an actual image element; text is not an icon', ids);
        else {
          const [l, t, r, b] = item.bbox;
          const covering = images.filter(e => { const box = e.bbox_px; return box[0] <= l && box[1] <= t && box[2] >= r && box[3] >= b; });
          if (!covering.length) issue('icon', item.id, 'crop_clipped', 'No actual saved image crop encloses the complete source icon bbox', ids);
          else if (!covering.some(e => e.bbox_px.every((v, i) => Math.abs(v - item.bbox[i]) <= 20))) issue('icon', item.id, 'crop_excess_padding', 'Covering crop extends more than 20 pixels beyond its source icon inventory bbox', ids);
        }
      } else {
        const native = mapped.filter(e => !['image', 'text'].includes(e.type) && visible(e));
        if (!native.length) issue('icon', item.id, 'wrong_representation', 'Vector icon requires visible native geometry; text or an image alone does not qualify', ids);
        if (row.visualMatch !== true) issue('icon', item.id, 'visual_match_unconfirmed', 'Vector reconstruction requires visualMatch:true after local source/preview inspection', ids, true);
        if (native.length) {
          try {
            const bounds = unionBox(native.map(elementBounds)), [l, t, r, b] = item.bbox;
            const intersection = Math.max(0, Math.min(r, bounds[2]) - Math.max(l, bounds[0])) * Math.max(0, Math.min(b, bounds[3]) - Math.max(t, bounds[1]));
            if (intersection < (r - l) * (b - t) * .25) issue('icon', item.id, 'icon_position_mismatch', 'Visible native geometry covers less than one quarter of the source icon bbox', ids);
          } catch (error) { issue('icon', item.id, 'invalid_geometry', error.message, ids); }
        }
      }
    }
    const itemIssues = issues.filter(x => x.inventoryId === item.id);
    icons.push({ inventoryId: item.id, status: itemIssues.length ? 'issue' : 'accepted', elementIds: ids, issues: itemIssues.map(x => x.code) });
    reviewRegions.push({ inventoryId: item.id, kind: 'icon', sourceBbox: [...item.bbox], elementIds: ids });
  }
  for (const item of inventory.connectors) {
    const row = connectorRows.get(item.id); startRow('connector', item, row);
    const ids = row ? idList('connector', item, row.lineIds, 'lineIds') : [], mapped = ids.map(id => elements.get(id)).filter(Boolean), edges = [], tolerance = item.tolerance ?? 8;
    for (const element of mapped) {
      if (!['line', 'polyline', 'path'].includes(element.type)) { issue('connector', item.id, 'wrong_representation', 'Connector requires native line/polyline/path, not text or bitmap', ids); continue; }
      if (!strokeVisible(element)) { issue('connector', item.id, 'invisible_connector', 'Connector has no visible stroke', ids); continue; }
      try { edges.push(geometry(element)); } catch (error) { issue('connector', item.id, 'invalid_geometry', error.message, ids); }
    }
    const allGeometryPresent = edges.length === ids.length && ids.length > 0;
    const chain = allGeometryPresent ? chainGeometry(edges, item.from, item.to, tolerance) : null;
    if (allGeometryPresent && !chain) issue('connector', item.id, 'endpoint_or_continuity_mismatch', 'Mapped geometry does not form one continuous chain from source from to source to', ids);
    const headIds = row?.headIds ?? {}, allHeadIds = [], present = { start: false, end: false }, pendingHeadPositions = new Set();
    if (!headIds || typeof headIds !== 'object' || Array.isArray(headIds) || Object.keys(headIds).some(key => !['start', 'end'].includes(key))) {
      issue('connector', item.id, 'invalid_head_mapping', 'headIds must contain only start/end ID arrays', ids, true);
      pendingHeadPositions.add('start'); pendingHeadPositions.add('end');
    }
    for (const position of ['start', 'end']) {
      const values = headIds[position] ?? [];
      if (!Array.isArray(values) || values.some(id => typeof id !== 'string') || new Set(values).size !== values.length) { issue('connector', item.id, 'invalid_head_mapping', 'headIds entries must be distinct ID arrays', ids, true); pendingHeadPositions.add(position); continue; }
      for (const id of values) {
        allHeadIds.push(id);
        const e = elements.get(id);
        if (!e || ids.includes(id)) { issue('connector', item.id, 'invalid_head_mapping', `Separate arrowhead ${id} is missing or also used as the shaft`, [id], true); pendingHeadPositions.add(position); continue; }
        if (!chain) continue;
        const tangent = position === 'start' ? chain[0].startTangent.map(v => -v) : chain.at(-1).endTangent, endpoint = position === 'start' ? item.from : item.to;
        try {
          if (correctTriangle(e, endpoint, tangent, tolerance)) present[position] = true;
          else issue('connector', item.id, 'head_direction_or_position_mismatch', `Separate ${position} arrowhead ${id} points away from its required tip or is misplaced`, [id]);
        } catch (error) { issue('connector', item.id, 'invalid_head_geometry', `${id}: ${error.message}`, [id]); }
      }
    }
    if (new Set(allHeadIds).size !== allHeadIds.length) issue('connector', item.id, 'duplicate_head_mapping', 'One separate head cannot represent both connector ends', allHeadIds, true);
    if (chain) {
      chain.forEach((part, i) => {
        if (part.arrowStart) { if (i === 0) present.start = true; else issue('connector', item.id, 'interior_arrowhead', `Unexpected native start head inside connector at ${part.id}`, ids); }
        if (part.arrowEnd) { if (i === chain.length - 1) present.end = true; else issue('connector', item.id, 'interior_arrowhead', `Unexpected native end head inside connector at ${part.id}`, ids); }
      });
      for (const position of ['start', 'end']) {
        const expected = item.heads === 'both' || item.heads === position;
        if (expected !== present[position] && !(expected && pendingHeadPositions.has(position))) issue('connector', item.id, expected ? `missing_${position}_head` : `unexpected_${position}_head`, `${position} arrowhead ${expected ? 'is missing' : 'is present but not in the source inventory'}`, [...ids, ...allHeadIds]);
      }
    }
    const elementIds = [...new Set([...ids, ...allHeadIds])];
    declaredIssue('connector', item, row, elementIds);
    const itemIssues = issues.filter(x => x.inventoryId === item.id);
    connectors.push({ inventoryId: item.id, status: itemIssues.length ? 'issue' : 'accepted', elementIds, lineIds: ids, issues: itemIssues.map(x => x.code), normalizedChain: chain?.map(p => ({ id: p.id, reversed: p.reversed, start: p.start, end: p.end })) ?? null });
    const points = [item.from, item.to];
    for (const e of mapped) { try { const b = elementBounds(e); if (b) points.push([b[0], b[1]], [b[2], b[3]]); } catch {} }
    const box = boxOf(points);
    reviewRegions.push({ inventoryId: item.id, kind: 'connector', sourceBbox: [Math.max(0, Math.floor(box[0] - 12)), Math.max(0, Math.floor(box[1] - 12)), Math.min(ctx.width, Math.ceil(box[2] + 12)), Math.min(ctx.height, Math.ceil(box[3] + 12))], elementIds });
  }
  const extraImages = scene.elements.filter(e => e.type === 'image' && !usedImages.has(e.id)).map(e => e.id);
  for (const id of extraImages) issue('inventory', id, 'extra_image', 'Saved image is not mapped to a source icon inventory item; account for this crop', [id], true);
  return { status: issues.length ? 'issues' : 'passed', issues, icons, connectors, extras: { imageIds: extraImages }, reviewRegions,
    limitations: 'Source inventory completeness and visualMatch are reviewer declarations. Geometry checks do not establish pixel equivalence, contrast, layering or semantic correctness.' };
}
