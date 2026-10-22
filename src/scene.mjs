import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';

const MAX_PIXELS = 40_000_000;
const STYLE_KEYS = ['fill', 'stroke', 'strokeWidth', 'opacity', 'dash', 'linecap', 'linejoin'];
const GEOMETRY_KEYS = {
  rect: ['x', 'y', 'width', 'height', 'rx'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2', 'arrowStart', 'arrowEnd'],
  polyline: ['points', 'arrowStart', 'arrowEnd'],
  path: ['d', 'arrowStart', 'arrowEnd'],
  text: ['x', 'y', 'text', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textAnchor', 'letterSpacing', 'rotation'],
  image: ['bbox_px', 'kind', 'reason'],
};
const XML_TEXT = /^[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

function fail(message) { throw new Error(`Invalid scene: ${message}`); }
function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}.${key} is not supported`);
}
function number(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isInteger(value))) fail(`${label} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
  return value;
}
function choice(value, label, choices) {
  if (!choices.includes(value)) fail(`${label} must be one of ${choices.join(', ')}`);
  return value;
}
function color(value, label) {
  if (typeof value !== 'string' || !/^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|none)$/i.test(value)) {
    fail(`${label} must be a hex color or none`);
  }
  return value.toLowerCase();
}
function text(value, label, max = 5000) {
  if (typeof value !== 'string' || !value.length || value.length > max || !XML_TEXT.test(value)) fail(`${label} is invalid text`);
  return value;
}
function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

// Validate the restricted SVG path language before passing it to the renderer.
function pathData(value, limit, label) {
  text(value, label, 20_000);
  const tokens = [];
  const re = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  let previous = 0;
  for (const match of value.matchAll(re)) {
    if (!/^[\s,]*$/.test(value.slice(previous, match.index))) fail(`${label} contains invalid path syntax`);
    tokens.push(match[0]);
    previous = match.index + match[0].length;
  }
  if (!/^[\s,]*$/.test(value.slice(previous)) || !/^[Mm]$/.test(tokens[0] ?? '') || tokens.length > 5000) {
    fail(`${label} must be a bounded SVG path starting with M`);
  }
  const arities = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++].toUpperCase();
    if (!(command in arities)) fail(`${label} requires a path command`);
    const args = [];
    while (index < tokens.length && !/^[A-Za-z]$/.test(tokens[index])) args.push(number(Number(tokens[index++]), label, -limit, limit));
    const size = arities[command];
    if (size === 0 ? args.length !== 0 : (!args.length || args.length % size !== 0)) fail(`${label} has invalid ${command} arguments`);
    if (command === 'A') {
      for (let offset = 0; offset < args.length; offset += size) {
        if (args[offset] < 0 || args[offset + 1] < 0 || ![0, 1].includes(args[offset + 3]) || ![0, 1].includes(args[offset + 4])) {
          fail(`${label} has invalid arc radii or flags`);
        }
      }
    }
  }
  return value;
}

function unionArea(boxes) {
  const xs = [...new Set(boxes.flatMap(box => [box[0], box[2]]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const intervals = boxes.filter(b => b[0] < xs[i] && b[2] > xs[i - 1]).map(b => [b[1], b[3]]).sort((a, b) => a[0] - b[0]);
    let total = 0, end = -Infinity;
    for (const [top, bottom] of intervals) {
      total += Math.max(0, bottom - Math.max(top, end));
      end = Math.max(end, bottom);
    }
    area += (xs[i] - xs[i - 1]) * total;
  }
  return area;
}

export async function normalizeImage(inputPath) {
  const input = sharp(inputPath, { failOn: 'error', limitInputPixels: MAX_PIXELS });
  const metadata = await input.metadata();
  if (!['png', 'jpeg'].includes(metadata.format)) throw new Error('Input must be a PNG or JPEG image');
  if ((metadata.pages ?? 1) > 1) throw new Error('Animated or multipage inputs are not supported');
  if (metadata.width > 20_000 || metadata.height > 20_000) throw new Error('Input dimensions must not exceed 20000 pixels per side');
  // sharp applies the embedded ICC transform to sRGB and strips metadata by default.
  const { data, info } = await input.rotate().toColourspace('srgb').ensureAlpha().png().toBuffer({ resolveWithObject: true });
  return {
    png: data, width: info.width, height: info.height,
    sourceInfo: { format: metadata.format, width: metadata.width, height: metadata.height,
      orientation: metadata.orientation ?? 1, hadIccProfile: Boolean(metadata.icc), normalizedColourspace: 'srgb' },
  };
}

export function validateScene(scene, { width, height }) {
  number(width, 'source width', 1, 20_000, true);
  number(height, 'source height', 1, 20_000, true);
  if (width * height > MAX_PIXELS) fail(`canvas exceeds ${MAX_PIXELS} pixels`);
  object(scene, 'scene', ['width', 'height', 'background', 'elements']);
  if (scene.width !== width || scene.height !== height) fail('scene dimensions must match the normalized source');
  if (!Array.isArray(scene.elements) || !scene.elements.length || scene.elements.length > 400) fail('elements must contain 1–400 objects');
  const result = { width, height, background: color(scene.background ?? '#ffffff', 'background'), elements: [] };
  const ids = new Set(), boxes = [];
  for (const [index, element] of scene.elements.entries()) {
    const label = `elements[${index}]`;
    if (!element || !Object.hasOwn(GEOMETRY_KEYS, element.type)) fail(`${label}.type is unsupported`);
    object(element, label, ['id', 'type', ...GEOMETRY_KEYS[element.type], ...(element.type === 'image' ? [] : STYLE_KEYS)]);
    if (typeof element.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(element.id) || ids.has(element.id)) fail(`${label}.id must be unique and use letters, digits, _ or -`);
    ids.add(element.id);
    const out = { ...element };
    const num = (key, min, max, integer = false) => number(element[key], `${label}.${key}`, min, max, integer);
    if (element.type === 'image') {
      if (!Array.isArray(element.bbox_px) || element.bbox_px.length !== 4) fail(`${label}.bbox_px must be [x1,y1,x2,y2]`);
      const box = element.bbox_px.map((v, i) => number(v, `${label}.bbox_px[${i}]`, 0, i % 2 ? height : width, true));
      if (box[0] >= box[2] || box[1] >= box[3]) fail(`${label}.bbox_px must have positive area`);
      if ((box[2] - box[0]) * (box[3] - box[1]) > width * height * 0.4) fail(`${label} crop exceeds 40% of the canvas`);
      out.bbox_px = box;
      choice(element.kind, `${label}.kind`, ['icon', 'chart', 'illustration']);
      text(element.reason, `${label}.reason`, 500);
      boxes.push(box);
    } else {
      out.fill = color(element.fill ?? (element.type === 'text' ? '#000000' : 'none'), `${label}.fill`);
      out.stroke = color(element.stroke ?? (element.type === 'text' ? 'none' : '#000000'), `${label}.stroke`);
      out.strokeWidth = number(element.strokeWidth ?? 1, `${label}.strokeWidth`, 0, 100);
      out.opacity = number(element.opacity ?? 1, `${label}.opacity`, 0, 1);
      if (element.dash !== undefined) {
        if (!Array.isArray(element.dash) || !element.dash.length || element.dash.length > 32) fail(`${label}.dash is invalid`);
        out.dash = element.dash.map(v => number(v, `${label}.dash`, 0, 1000));
        if (!out.dash.some(v => v > 0)) fail(`${label}.dash must contain a positive length`);
      }
      if (element.linecap !== undefined) choice(element.linecap, `${label}.linecap`, ['butt', 'round', 'square']);
      if (element.linejoin !== undefined) choice(element.linejoin, `${label}.linejoin`, ['miter', 'round', 'bevel']);
      for (const key of ['arrowStart', 'arrowEnd']) {
        if (element[key] !== undefined && typeof element[key] !== 'boolean') fail(`${label}.${key} must be boolean`);
      }
      if (element.arrowStart || element.arrowEnd) {
        if (out.stroke === 'none' || out.strokeWidth <= 0) fail(`${label} arrows require a visible stroke`);
      }
      if (['rect', 'text'].includes(element.type)) { num('x', -width, width * 2); num('y', -height, height * 2); }
      if (element.type === 'rect') {
        num('width', Number.EPSILON, width * 2); num('height', Number.EPSILON, height * 2);
        if (element.rx !== undefined) num('rx', 0, Math.min(element.width, element.height) / 2);
      } else if (element.type === 'ellipse') {
        num('cx', -width, width * 2); num('cy', -height, height * 2);
        num('rx', Number.EPSILON, width); num('ry', Number.EPSILON, height);
      } else if (element.type === 'line') {
        for (const key of ['x1', 'x2']) num(key, -width, width * 2);
        for (const key of ['y1', 'y2']) num(key, -height, height * 2);
      } else if (element.type === 'polyline') {
        if (!Array.isArray(element.points) || element.points.length < 2 || element.points.length > 1000) fail(`${label}.points needs 2–1000 [x,y] points`);
        out.points = element.points.map(point => {
          if (!Array.isArray(point) || point.length !== 2) fail(`${label}.points must contain [x,y] pairs`);
          return [number(point[0], `${label}.points.x`, -width, width * 2), number(point[1], `${label}.points.y`, -height, height * 2)];
        });
      } else if (element.type === 'path') {
        pathData(element.d, Math.max(width, height) * 8, `${label}.d`);
      } else if (element.type === 'text') {
        text(element.text, `${label}.text`);
        if (/[\r\n]/.test(element.text)) fail(`${label}.text must be one line; use separate objects for each baseline`);
        out.fontFamily = element.fontFamily ?? 'Arial';
        if (typeof out.fontFamily !== 'string' || out.fontFamily.length > 120 || !/^[\p{L}\p{M}\p{N} ,_-]+$/u.test(out.fontFamily)) fail(`${label}.fontFamily is invalid`);
        out.fontSize = number(element.fontSize, `${label}.fontSize`, 1, 1000);
        out.fontWeight = number(element.fontWeight ?? 400, `${label}.fontWeight`, 100, 900, true);
        out.fontStyle = choice(element.fontStyle ?? 'normal', `${label}.fontStyle`, ['normal', 'italic', 'oblique']);
        out.textAnchor = choice(element.textAnchor ?? 'start', `${label}.textAnchor`, ['start', 'middle', 'end']);
        if (element.letterSpacing !== undefined) num('letterSpacing', -100, 100);
        if (element.rotation !== undefined) num('rotation', -360, 360);
      }
    }
    result.elements.push(out);
  }
  if (boxes.length > 32) fail('no more than 32 crop regions are allowed');
  if (unionArea(boxes) > width * height * 0.7) fail('combined crop area exceeds 70% of the canvas');
  return result;
}

function styleAttributes(element) {
  const values = { fill: element.fill, stroke: element.stroke, 'stroke-width': element.strokeWidth, opacity: element.opacity,
    'stroke-dasharray': element.dash?.join(' '), 'stroke-linecap': element.linecap, 'stroke-linejoin': element.linejoin };
  return Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}="${xml(value)}"`).join(' ');
}

export async function compileScene(scene, { sourcePng, width, height }) {
  const valid = validateScene(scene, { width, height });
  if (!Buffer.isBuffer(sourcePng)) throw new Error('sourcePng must be a normalized PNG Buffer');
  const metadata = await sharp(sourcePng, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
  if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height || (metadata.pages ?? 1) > 1) {
    throw new Error('sourcePng must be a single PNG matching the scene dimensions');
  }
  const body = [], definitions = [];
  for (const element of valid.elements) {
    const attr = [`id="${element.id}"`];
    if (element.type === 'image') {
      const [x1, y1, x2, y2] = element.bbox_px;
      const crop = await sharp(sourcePng).extract({ left: x1, top: y1, width: x2 - x1, height: y2 - y1 }).png().toBuffer();
      body.push(`<image ${attr.join(' ')} x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" href="data:image/png;base64,${crop.toString('base64')}"/>`);
      continue;
    }
    attr.push(styleAttributes(element));
    for (const [key, position] of [['arrowStart', 'start'], ['arrowEnd', 'end']]) {
      if (element[key]) {
        const id = `_arrow-${element.id}-${position}`;
        // resvg 2.6.2 does not correctly honor auto-start-reverse. Use auto
        // orientation and an explicitly mirrored start marker; each tip stays
        // on its declared path endpoint in both SVG browsers and PNG previews.
        const start = position === 'start';
        definitions.push(`<marker id="${id}" markerWidth="8" markerHeight="8" refX="${start ? 0 : 8}" refY="4" orient="auto" markerUnits="strokeWidth"><path d="${start ? 'M8 0 L0 4 L8 8 Z' : 'M0 0 L8 4 L0 8 Z'}" fill="${element.stroke}"/></marker>`);
        attr.push(`marker-${position}="url(#${id})"`);
      }
    }
    let content = '', keys = [];
    if (element.type === 'rect') keys = ['x', 'y', 'width', 'height', 'rx'];
    if (element.type === 'ellipse') keys = ['cx', 'cy', 'rx', 'ry'];
    if (element.type === 'line') keys = ['x1', 'y1', 'x2', 'y2'];
    if (element.type === 'path') keys = ['d'];
    if (element.type === 'polyline') attr.push(`points="${element.points.map(p => p.join(',')).join(' ')}"`);
    if (element.type === 'text') {
      keys = ['x', 'y'];
      const fonts = { 'font-family': element.fontFamily, 'font-size': element.fontSize, 'font-weight': element.fontWeight,
        'font-style': element.fontStyle, 'text-anchor': element.textAnchor, 'letter-spacing': element.letterSpacing, 'xml:space': 'preserve' };
      for (const [key, value] of Object.entries(fonts)) if (value !== undefined) attr.push(`${key}="${xml(value)}"`);
      // The declared baseline anchor stays fixed; positive SVG angles turn clockwise.
      if (element.rotation !== undefined) attr.push(`transform="rotate(${element.rotation} ${element.x} ${element.y})"`);
      content = xml(element.text);
    }
    for (const key of keys) if (element[key] !== undefined) attr.push(`${key}="${xml(element[key])}"`);
    body.push(`<${element.type} ${attr.join(' ')}>${content}</${element.type}>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n<defs>${definitions.join('')}</defs>\n<rect id="_background" width="${width}" height="${height}" fill="${valid.background}"/>\n${body.join('\n')}\n</svg>\n`;
  const png = Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng());
  const boxes = valid.elements.filter(element => element.type === 'image').map(element => element.bbox_px);
  return { svg, png, stats: { elements: valid.elements.length,
    texts: valid.elements.filter(element => element.type === 'text').length,
    images: boxes.length, bitmapFraction: unionArea(boxes) / (width * height) } };
}
