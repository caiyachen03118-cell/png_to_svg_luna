import sharp from 'sharp';

// This is a conservative pixel-boundary check, not icon recognition. The model
// supplies the semantic seed; only a single, isolated nearby silhouette may
// replace it. We never synthesize missing pixels or modify any source pixels.
const VERSION = 1;
const SETTINGS = Object.freeze({ padding: 3, searchRatio: 0.9, minSearch: 24, maxSearch: 160,
  edgeThreshold: 8, maxPixels: 40_000_000, maxSearchPixels: 700_000, maxComponents: 384, ambiguityGap: 0.13 });

function area(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }
function intersect(a, b) { return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]; }
function union(a, b) { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; }
function same(a, b) { return a.every((v, i) => v === b[i]); }
function rounded(value) { return Math.round(value * 1000) / 1000; }
function validBox(b, width, height) {
  return Array.isArray(b) && b.length === 4 && b.every(Number.isInteger) && b[0] >= 0 && b[1] >= 0 && b[2] <= width && b[3] <= height && b[0] < b[2] && b[1] < b[3];
}

function components(mask, width, height) {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length), found = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0, tail = 1, minX = width, minY = height, maxX = 0, maxY = 0;
    queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + 1); maxY = Math.max(maxY, y + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const next = p + dy * width + dx;
        if (mask[next] && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
      }
    }
    if (tail >= 8) found.push({ box: [minX, minY, maxX, maxY], pixels: tail, componentCount: 1 });
  }
  return found;
}

function removeLongRuns(mask, width, height, threshold) {
  const removed = new Uint8Array(mask.length);
  // Remove only uninterrupted lines longer than a plausible icon side. Small
  // frame dashes remain separate candidates and are rejected by aspect ratio.
  for (let y = 0; y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (x < width && mask[y * width + x]) { if (start < 0) start = x; }
      else if (start >= 0) {
        if (x - start >= threshold) for (let p = start; p < x; p++) removed[y * width + p] = 1;
        start = -1;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      if (y < height && mask[y * width + x]) { if (start < 0) start = y; }
      else if (start >= 0) {
        if (y - start >= threshold) for (let p = start; p < y; p++) removed[p * width + x] = 1;
        start = -1;
      }
    }
  }
  for (let i = 0; i < mask.length; i++) if (removed[i]) mask[i] = 0;
  return removed;
}

function hexRgb(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(value)) return null;
  const text = value.length === 4 ? value.slice(1).split('').map(c => c + c).join('') : value.slice(1, 7);
  return [0, 2, 4].map(i => parseInt(text.slice(i, i + 2), 16));
}

function frameColorHints(elements, search, extent, iconArea) {
  const colors = [];
  for (const row of elements) {
    if (row.type !== 'rect' || ![row.x, row.y, row.width, row.height].every(Number.isFinite)) continue;
    if (Math.max(row.width, row.height) < extent * 1.7 || row.width * row.height < iconArea * 1.8) continue;
    if (!area(intersect([row.x, row.y, row.x + row.width, row.y + row.height], search))) continue;
    for (const key of ['fill', 'stroke']) {
      const rgb = hexRgb(row[key]);
      // Never erase dark ink by assuming it belongs to a panel. Colored/light
      // panel hints must also form a measured long distribution in source.
      if (rgb && Math.min(...rgb) >= 95 && Math.max(...rgb) - Math.min(...rgb) >= 16 && !colors.some(c => c.every((v, i) => v === rgb[i]))) colors.push(rgb);
    }
  }
  return colors.slice(0, 20);
}

function edgeMask(rgba, sourceWidth, search, hints = [], extent = 50) {
  const [left, top, right, bottom] = search, width = right - left, height = bottom - top;
  const rgb = new Uint8Array(width * height * 3), alpha = new Uint8Array(width * height);
  let transparentPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, s = ((top + y) * sourceWidth + left + x) * 4, a = rgba[s + 3] / 255;
    alpha[p] = rgba[s + 3];
    if (a < .98) transparentPixels++;
    // Premultiply against a neutral matte so arbitrary RGB behind alpha=0 is
    // not mistaken for content; alpha transitions remain explicit evidence.
    for (let k = 0; k < 3; k++) rgb[p * 3 + k] = Math.round(rgba[s + k] * a + 255 * (1 - a));
  }
  const background = new Uint8Array(width * height), suppressedColors = [];
  for (let p = 0; p < background.length; p++) if (rgb[p * 3] >= 244 && rgb[p * 3 + 1] >= 244 && rgb[p * 3 + 2] >= 244) background[p] = 1;
  for (const hint of hints) {
    const match = new Uint8Array(width * height), rows = new Uint32Array(height), cols = new Uint32Array(width);
    const colors = new Map();
    let matched = 0;
    for (let p = 0; p < match.length; p++) {
      const dr = rgb[p * 3] - hint[0], dg = rgb[p * 3 + 1] - hint[1], db = rgb[p * 3 + 2] - hint[2];
      if (dr * dr + dg * dg + db * db <= 52 ** 2) {
        match[p] = 1; rows[Math.floor(p / width)]++; cols[p % width]++; matched++;
        const key = rgb[p * 3] * 65536 + rgb[p * 3 + 1] * 256 + rgb[p * 3 + 2];
        colors.set(key, (colors.get(key) ?? 0) + 1);
      }
    }
    const longestDistribution = Math.max(...rows, ...cols);
    if (matched < 30 || longestDistribution < Math.max(24, extent * .65)) continue;
    const modes = [...colors].sort((a, b) => b[1] - a[1]);
    // Multiple panels can be close in hue. Prefer the measured frequent color
    // nearest this hint, not the most common neighboring panel's different hue.
    const actualKey = modes.filter(([, count]) => count >= Math.max(12, modes[0][1] * .1)).sort((a, b) => {
      const distance = key => (Math.floor(key / 65536) - hint[0]) ** 2 + (Math.floor(key / 256) % 256 - hint[1]) ** 2 + (key % 256 - hint[2]) ** 2;
      return distance(a[0]) - distance(b[0]);
    })[0]?.[0] ?? modes[0][0];
    const actualRgb = [Math.floor(actualKey / 65536), Math.floor(actualKey / 256) % 256, actualKey % 256];
    const vx = actualRgb[0] - 255, vy = actualRgb[1] - 255, vz = actualRgb[2] - 255, length2 = vx * vx + vy * vy + vz * vz;
    for (let p = 0; p < background.length; p++) {
      // Include antialiased blends of the measured colored frame with white;
      // otherwise its pale outer fringe reconnects the frame to the icon.
      const dx = rgb[p * 3] - 255, dy = rgb[p * 3 + 1] - 255, dz = rgb[p * 3 + 2] - 255;
      const t = Math.max(0, Math.min(1.2, (dx * vx + dy * vy + dz * vz) / Math.max(1, length2)));
      const residual = (dx - t * vx) ** 2 + (dy - t * vy) ** 2 + (dz - t * vz) ** 2;
      if (residual <= 9 ** 2 && t <= 1.2) background[p] = 1;
    }
    suppressedColors.push({ referenceRgb: hint, measuredRgb: actualRgb, matchingSourcePixels: matched, longestRowOrColumnDistribution: longestDistribution });
  }
  const mask = new Uint8Array(width * height), threshold2 = SETTINGS.edgeThreshold ** 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      if (x + dx >= width || y + dy >= height) continue;
      const q = p + dy * width + dx;
      const dr = rgb[p * 3] - rgb[q * 3], dg = rgb[p * 3 + 1] - rgb[q * 3 + 1], db = rgb[p * 3 + 2] - rgb[q * 3 + 2];
      const alphaEdge = Math.abs(alpha[p] - alpha[q]) >= 20;
      if (alphaEdge || !(background[p] && background[q]) && dr * dr + dg * dg + db * db >= threshold2) { mask[p] = 1; mask[q] = 1; }
    }
  }
  return { mask, width, height, transparentPixels, suppressedColors };
}

function groupNestedComponents(rows, expectedWidth, expectedHeight) {
  // Internal colored boundaries, a checkmark on a window, or the two halves
  // of a recycling symbol have overlapping bounding boxes. Separate adjacent
  // objects (e.g. two circles or neighboring letters) are never gap-joined.
  const groups = rows.map(row => ({ ...row, box: [...row.box] }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j], overlap = area(intersect(a.box, b.box)), combined = union(a.box, b.box);
      const overlapFraction = overlap / Math.max(1, Math.min(area(a.box), area(b.box)));
      const comparable = Math.min(a.pixels, b.pixels) >= Math.max(a.pixels, b.pixels) * .25
        && Math.min(area(a.box), area(b.box)) >= Math.max(area(a.box), area(b.box)) * .20;
      // Small details may join when almost contained inside the silhouette.
      // Two similarly sized overlapping halves may form one composite icon.
      // A small glyph or frame dash touching the outside must not enlarge it.
      if (overlapFraction < .70 && !(comparable && overlapFraction >= .12)) continue;
      if (combined[2] - combined[0] > expectedWidth * 2.8 + 8 || combined[3] - combined[1] > expectedHeight * 2.8 + 8) continue;
      groups[i] = { box: combined, pixels: a.pixels + b.pixels, componentCount: a.componentCount + b.componentCount };
      groups.splice(j, 1); changed = true; break outer;
    }
  }
  return groups;
}

function countPixels(mask, width, box) {
  let total = 0;
  for (let y = Math.max(0, box[1]); y < box[3]; y++) for (let x = Math.max(0, box[0]); x < box[2]; x++) total += mask[y * width + x] || 0;
  return total;
}

function inspectIcon(element, rgba, width, height, elements) {
  const original = element.bbox_px, ew = original[2] - original[0], eh = original[3] - original[1], extent = Math.max(ew, eh);
  const radius = Math.min(SETTINGS.maxSearch, Math.max(SETTINGS.minSearch, Math.round(extent * SETTINGS.searchRatio)));
  const search = [Math.max(0, original[0] - radius), Math.max(0, original[1] - radius), Math.min(width, original[2] + radius), Math.min(height, original[3] + radius)];
  const evidence = { checked: true, method: 'local-edge-components', searchBox: search, padding: SETTINGS.padding,
    sourcePixelPolicy: 'unchanged source pixels', semanticSeed: 'model icon classification and approximate box', confidence: 'unresolved' };
  const review = reason => ({ id: element.id, kind: element.kind, status: 'needs_review', originalBox: [...original], finalBox: [...original], reason, evidence });
  if (area(search) > SETTINGS.maxSearchPixels) return review('Search region is too large for conservative icon segmentation; retain the model box for review.');
  const hints = frameColorHints(elements, search, extent, area(original));
  const { mask, width: sw, height: sh, transparentPixels, suppressedColors } = edgeMask(rgba, width, search, hints, extent);
  evidence.transparentSearchPixels = transparentPixels;
  evidence.suppressedMeasuredFrameColors = suppressedColors;
  const removed = removeLongRuns(mask, sw, sh, Math.max(48, Math.round(extent * 1.6)));
  evidence.suppressedStraightEdgePixels = removed.reduce((sum, v) => sum + v, 0);
  const raw = components(mask, sw, sh);
  evidence.rawComponentCount = raw.length;
  evidence.largestRawComponents = [...raw].sort((a, b) => b.pixels - a.pixels).slice(0, 12).map(row => ({
    box: row.box.map((v, i) => v + search[i % 2]), edgePixels: row.pixels }));
  if (raw.length > SETTINGS.maxComponents) return review('Source region is too noisy or fragmented for bounded reliable component grouping.');
  // Suppress fine text glyphs and narrow frame/connector fragments before
  // grouping. A component must occupy meaningful width AND height.
  const candidates = groupNestedComponents(raw, ew, eh).map(row => {
    const local = row.box, b = [local[0] + search[0], local[1] + search[1], local[2] + search[0], local[3] + search[1]];
    const cw = b[2] - b[0], ch = b[3] - b[1], ratio = cw / ch;
    const overlap = area(intersect(b, original)) / area(b);
    const dx = ((b[0] + b[2]) - (original[0] + original[2])) / 2 / extent;
    const dy = ((b[1] + b[3]) - (original[1] + original[3])) / 2 / extent;
    const distance = Math.hypot(dx, dy);
    const similarity = Math.exp(-.65 * (Math.abs(Math.log(cw / ew)) + Math.abs(Math.log(ch / eh))));
    const score = .45 * similarity + .25 * Math.min(1, overlap) + .30 * Math.max(0, 1 - distance / 1.5);
    return { ...row, local, box: b, cw, ch, ratio, overlap, distance, similarity, score,
      touchesSearch: local[0] <= 1 || local[1] <= 1 || local[2] >= sw - 1 || local[3] >= sh - 1 };
  }).filter(row => row.pixels >= 20 && row.cw >= Math.max(8, ew * .24) && row.ch >= Math.max(8, eh * .24)
    && Math.max(row.cw, row.ch) >= extent * .44 && row.cw <= ew * 2.8 + 8 && row.ch <= eh * 2.8 + 8
    && row.ratio >= .18 && row.ratio <= 5.5 && row.distance <= 1.55)
    .sort((a, b) => b.score - a.score);
  evidence.candidates = candidates.slice(0, 8).map(({ box, pixels, componentCount, score, overlap, distance, touchesSearch }) =>
    ({ box, edgePixels: pixels, componentCount, score: rounded(score), seedOverlap: rounded(overlap), normalizedDistance: rounded(distance), touchesSearch }));
  if (!candidates.length) return review('No sufficiently sized isolated silhouette was found near the proposed icon. Empty or flat pixels are not treated as an icon.');
  const best = candidates[0], second = candidates[1];
  if (best.touchesSearch) return review('The best silhouette reaches the search or source boundary; complete boundaries cannot be verified.');
  if (best.score < .57 || best.similarity < .40) return review('The nearby silhouette is too different in size or too far from the proposed box to repair confidently.');
  if (second && (best.score - second.score < SETTINGS.ambiguityGap ||
      second.overlap >= .20 && best.overlap >= .20 && second.score >= best.score * .80 && area(second.box) >= area(best.box) * .50)) {
    return review('Multiple nearby silhouettes are similarly plausible; retain the original box instead of choosing or merging different targets.');
  }
  const padding = SETTINGS.padding;
  const final = [Math.max(0, best.box[0] - padding), Math.max(0, best.box[1] - padding), Math.min(width, best.box[2] + padding), Math.min(height, best.box[3] + padding)];
  if (final[0] < search[0] || final[1] < search[1] || final[2] > search[2] || final[3] > search[3]) return review('The padded crop leaves the measured search region; its final boundary cannot be checked safely.');
  if (final[0] === 0 || final[1] === 0 || final[2] === width || final[3] === height) return review('The measured silhouette cannot retain antialiasing padding before the source edge.');
  if (area(final) > width * height * .15 || area(final) > area(original) * 5.0) return review('Measured bounds would expand into too much of the diagram; semantic review is required.');
  // Significant separate foreground enclosed by the rectangular result is a
  // warning: bounding boxes cannot remove neighboring text or an intersecting
  // panel border. No content-aware erasure is attempted.
  const contamination = raw.filter(row => {
    const b = row.box.map((v, i) => v + search[i % 2]);
    return area(intersect(b, final)) > 0 && area(intersect(b, best.box)) === 0 && row.pixels >= 10;
  });
  evidence.separateComponentsInPadding = contamination.length;
  if (contamination.some(row => row.pixels > best.pixels * .08)) return review('Padding would include a separate nearby object; boundaries need review.');
  const discarded = raw.filter(row => {
    const b = row.box.map((v, i) => v + search[i % 2]);
    return row.pixels >= Math.max(12, best.pixels * .015) && area(intersect(b, original)) >= area(b) * .75 && !area(intersect(b, final));
  });
  evidence.discardedOriginalComponents = discarded.map(row => ({ box: row.box.map((v, i) => v + search[i % 2]), edgePixels: row.pixels }));
  if (discarded.length) return review('Tightening would discard separate foreground already contained in the original icon box; it may be a disconnected icon part.');
  const localOriginal = [Math.max(0, original[0] - search[0]), Math.max(0, original[1] - search[1]), original[2] - search[0], original[3] - search[1]];
  evidence.originalEdgePixels = countPixels(mask, sw, localOriginal);
  evidence.targetBox = best.box;
  evidence.targetEdgePixels = best.pixels;
  evidence.originalContainsMeasuredTarget = original[0] <= best.box[0] && original[1] <= best.box[1] && original[2] >= best.box[2] && original[3] >= best.box[3];
  // Recheck the actual filtered source edge mask along all four proposed crop
  // boundaries. A measured target bbox plus padding alone cannot detect a
  // neighboring glyph or frame fragment that would be cut by the result.
  const localFinal = final.map((v, i) => v - search[i % 2]);
  const boundaryEdges = { left: 0, top: 0, right: 0, bottom: 0 };
  for (let y = localFinal[1]; y < localFinal[3]; y++) {
    boundaryEdges.left += mask[y * sw + localFinal[0]] || 0;
    boundaryEdges.right += mask[y * sw + localFinal[2] - 1] || 0;
  }
  for (let x = localFinal[0]; x < localFinal[2]; x++) {
    boundaryEdges.top += mask[localFinal[1] * sw + x] || 0;
    boundaryEdges.bottom += mask[(localFinal[3] - 1) * sw + x] || 0;
  }
  const touches = Object.values(boundaryEdges).some(count => count > 0);
  evidence.boundaryCheck = { sourceEdgePixelsOnFinalBoundary: boundaryEdges, foregroundTouchesFinalCrop: touches,
    targetTouchesSearch: false, retainedPadding: padding, note: 'Actual source-edge mask after disclosed frame-color/straight-line suppression; semantic completeness remains uncertain.' };
  if (touches) return review('The proposed crop still cuts foreground edge pixels on a boundary; retain the original box for review.');
  evidence.confidence = 'high-local-boundary-confidence';
  return { id: element.id, kind: element.kind, status: same(final, original) ? 'unchanged' : 'repaired', originalBox: [...original], finalBox: final,
    reason: same(final, original) ? 'The measured isolated silhouette already has the expected antialiasing padding.'
      : 'Adjusted the source crop to the single nearby measured silhouette with antialiasing padding; the source pixels and native objects are unchanged.', evidence };
}

export async function repairImageCrops(scene, { sourcePng, width, height }) {
  if (!scene || !Array.isArray(scene.elements)) throw new Error('Crop repair requires a scene with elements');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > SETTINGS.maxPixels) {
    throw new Error('Crop repair requires bounded positive source dimensions');
  }
  if (!Buffer.isBuffer(sourcePng) && !(sourcePng instanceof Uint8Array)) throw new Error('Crop repair sourcePng must be PNG/JPEG image bytes');
  const output = structuredClone(scene);
  const { data: rgba, info } = await sharp(sourcePng, { failOn: 'error', limitInputPixels: SETTINGS.maxPixels }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 4) throw new Error('Crop repair image dimensions do not match the normalized scene');
  const items = [];
  for (const element of output.elements) {
    if (element.type !== 'image') continue;
    if (!validBox(element.bbox_px, width, height)) throw new Error(`Crop repair received an invalid bbox_px for ${element.id}`);
    if (element.kind !== 'icon') {
      items.push({ id: element.id, kind: element.kind, status: 'unchanged', originalBox: [...element.bbox_px], finalBox: [...element.bbox_px],
        reason: 'Chart/illustration crops can contain separate labels and marks; automatic icon-boundary repair is intentionally skipped.',
        evidence: { checked: false, method: 'semantic-kind-skip' } });
      continue;
    }
    const item = inspectIcon(element, rgba, width, height, output.elements);
    items.push(item);
    element.bbox_px = [...item.finalBox];
  }
  return { scene: output, audit: { version: VERSION, method: 'conservative-local-pixel-boundaries', settings: SETTINGS, items,
    unresolvedIds: items.filter(item => item.status === 'needs_review').map(item => item.id),
    limitations: ['Pixel connectivity cannot establish icon semantics or distinguish every touching label/frame.',
      'Automatic repairs require a single local silhouette; unclear boundaries retain the original crop for model/user review.',
      'Charts and illustrations are not automatically expanded; neither perfect completeness nor 100% accuracy is claimed.'] } };
}
