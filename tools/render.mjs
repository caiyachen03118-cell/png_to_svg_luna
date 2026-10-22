import { readFile, writeFile, appendFile, mkdir, open, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { normalizeImage, validateScene, compileScene } from '../src/scene.mjs';
import { repairImageCrops } from '../src/crops.mjs';
import { assertEvidenceReady, assertPreviousReviewed, refreshVerificationState } from '../src/evidence.mjs';

const PROTOCOL = 'luna-local-render-v1';
const LEGACY_ATTEMPTS = 3;
const CLOSED_LOOP_ATTEMPTS = 8;
const MAX_ALLOWED_ATTEMPTS = 12;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const save = (path, value) => writeFile(path, value, { flag: 'wx' });

function validateManifest(manifest) {
  const budget = manifest.maxRenderAttempts;
  if (manifest.protocol !== PROTOCOL || !Number.isInteger(budget) || budget < 1 || budget > MAX_ALLOWED_ATTEMPTS
    || (manifest.repairRequired !== undefined && typeof manifest.repairRequired !== 'boolean')
    || (manifest.evidenceRequired !== undefined && typeof manifest.evidenceRequired !== 'boolean')
    || (manifest.reviewProtocol !== undefined && (manifest.reviewProtocol !== 'object-review-v1' || !manifest.repairRequired))
    || (manifest.repairRequired && manifest.evidenceRequired !== true)
    || (!manifest.repairRequired && budget !== LEGACY_ATTEMPTS)) throw new Error('Unsupported run manifest');
  return budget;
}

function validateVersion(version, budget) {
  if (!/^v\d{2}$/.test(version) || Number(version.slice(1)) < 1 || Number(version.slice(1)) > budget) {
    throw new Error(`Version must be v01 through v${String(budget).padStart(2, '0')}`);
  }
}

// Object key order and JSON whitespace are not changes to a scene. Element
// array order remains significant because it controls SVG paint order.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const semanticHash = value => hash(JSON.stringify(canonical(value)));

async function assertChangedProposal(output, proposalValue, events) {
  const proposedHash = semanticHash(proposalValue);
  for (const prior of events.filter(row => row.event === 'success')) {
    const old = JSON.parse(await readFile(join(output, prior.version, 'submitted.json'), 'utf8'));
    if (semanticHash(old) === proposedHash) throw new Error(`Unchanged proposal duplicates ${prior.version}; modify the scene before rendering again`);
  }
  return proposedHash;
}

export async function initializeRun(inputPath, outputPath, options = {}) {
  if (options.evidenceRequired !== undefined && typeof options.evidenceRequired !== 'boolean') throw new Error('evidenceRequired must be boolean');
  if (options.repairRequired !== undefined && typeof options.repairRequired !== 'boolean') throw new Error('repairRequired must be boolean');
  if (options.reviewProtocol !== undefined && (!options.repairRequired || !['legacy', 'object-review-v1'].includes(options.reviewProtocol))) throw new Error('reviewProtocol requires closed-loop mode and must be legacy or object-review-v1');
  if (options.maxRenderAttempts !== undefined && !options.repairRequired) throw new Error('maxRenderAttempts requires repairRequired (CLI: --closed-loop)');
  const budget = options.repairRequired ? (options.maxRenderAttempts === undefined ? CLOSED_LOOP_ATTEMPTS : options.maxRenderAttempts) : LEGACY_ATTEMPTS;
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_ALLOWED_ATTEMPTS) throw new Error('maxRenderAttempts must be an integer from 1 to 12');
  const input = resolve(inputPath), output = resolve(outputPath);
  const original = await readFile(input);
  const normalized = await normalizeImage(input);
  await mkdir(dirname(output), { recursive: true });
  // The final run directory must not exist; init never replaces any run.
  await mkdir(output);
  const manifest = { protocol: PROTOCOL, createdAt: new Date().toISOString(), input,
    inputSha256: hash(original), sourceSha256: hash(normalized.png),
    width: normalized.width, height: normalized.height, sourceInfo: normalized.sourceInfo,
    maxRenderAttempts: budget, ...(options.evidenceRequired || options.repairRequired ? { evidenceRequired: true } : {}),
    ...(options.repairRequired ? { repairRequired: true, ...(options.reviewProtocol === 'legacy' ? {} : { reviewProtocol: 'object-review-v1' }) } : {}) };
  await save(join(output, 'source.png'), normalized.png);
  await save(join(output, 'manifest.json'), json(manifest));
  await save(join(output, 'render-events.jsonl'), '');
  await save(join(output, 'README.md'), `# Local render run\n\n\`source.png\` is the normalized source. \`manifest.json\` records its dimensions and hashes. Each \`vXX/\` is an immutable render attempt. \`render-events.jsonl\` records successes and failures; at most ${budget} attempts are allowed.${options.repairRequired ? ' Closed-loop mode requires review after each successful version before a changed scene can be rendered again. Gate refusals do not consume attempts.' : ''}\n`);
  return { output, source: join(output, 'source.png'), ...manifest };
}

export async function preflightProposal(outputPath, proposalPath, version) {
  const output = resolve(outputPath), proposal = resolve(proposalPath);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const budget = validateManifest(manifest);
  validateVersion(version, budget);
  const versionPath = join(output, version);
  try { await access(versionPath); throw new Error(`Version already exists: ${version}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const previous = (await readFile(join(output, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  const used = previous.filter(row => row.event === 'attempt').length;
  if (used >= budget) throw new Error(`Render limit reached (${budget} attempts, including failed attempts)`);
  const [sourcePng, proposalBytes] = await Promise.all([readFile(join(output, 'source.png')), readFile(proposal)]);
  if (hash(sourcePng) !== manifest.sourceSha256) throw new Error('Normalized source hash changed');
  const submitted = JSON.parse(proposalBytes), scene = validateScene(submitted, { sourcePng, width: manifest.width, height: manifest.height });
  const evidence = manifest.evidenceRequired ? await assertEvidenceReady(output) : null;
  if (manifest.repairRequired) {
    await assertPreviousReviewed(output);
    await assertChangedProposal(output, submitted, previous);
  }
  return { valid: true, version, proposal, sourceSha256: manifest.sourceSha256, proposalSha256: hash(proposalBytes), elements: scene.elements.length,
    usedAttempts: used, remainingAttempts: budget - used, maxRenderAttempts: budget,
    evidenceRequired: Boolean(manifest.evidenceRequired), repairRequired: Boolean(manifest.repairRequired), evidence,
    note: 'Read-only validation; no render attempt is consumed and this does not reserve a version.' };
}

async function cropReview(sourcePng, audit, width, height) {
  const rows = audit.items.filter(item => item.kind === 'icon');
  if (!rows.length) return null;
  const sheetWidth = 660, rowHeight = 180, sheetHeight = 44 + rows.length * rowHeight;
  const overlays = [], labels = [`<text x="12" y="19" font-size="13">Source context: red submitted / green adopted</text>`,
    `<text x="245" y="36" font-size="12">Submitted crop</text><text x="462" y="36" font-size="12">Adopted crop</text>`];
  for (const [index, row] of rows.entries()) {
    const old = row.originalBox, next = row.finalBox, top = 44 + index * rowHeight;
    const union = [Math.min(old[0], next[0]), Math.min(old[1], next[1]), Math.max(old[2], next[2]), Math.max(old[3], next[3])];
    const pad = Math.max(12, Math.round(Math.max(union[2] - union[0], union[3] - union[1]) * .25));
    const context = [Math.max(0, union[0] - pad), Math.max(0, union[1] - pad), Math.min(width, union[2] + pad), Math.min(height, union[3] + pad)];
    labels.push(`<text x="12" y="${top + 17}" font-size="12">${xml(row.id)} — ${xml(row.status)}</text>`);
    for (const [cell, box] of [context, old, next].entries()) {
      const cropWidth = box[2] - box[0], cropHeight = box[3] - box[1];
      const scale = Math.min(200 / cropWidth, 136 / cropHeight);
      const outWidth = Math.max(1, Math.round(cropWidth * scale)), outHeight = Math.max(1, Math.round(cropHeight * scale));
      const left = 10 + cell * 220 + Math.floor((200 - outWidth) / 2), y = top + 27 + Math.floor((136 - outHeight) / 2);
      let buffer = await sharp(sourcePng).extract({ left: box[0], top: box[1], width: cropWidth, height: cropHeight }).resize(outWidth, outHeight).png().toBuffer();
      if (cell === 0) {
        const rectangles = [[old, '#ef4444'], [next, '#16a34a']].map(([b, color]) => `<rect x="${(b[0] - box[0]) * outWidth / cropWidth}" y="${(b[1] - box[1]) * outHeight / cropHeight}" width="${(b[2] - b[0]) * outWidth / cropWidth}" height="${(b[3] - b[1]) * outHeight / cropHeight}" fill="none" stroke="${color}" stroke-width="1.5"/>`).join('');
        buffer = await sharp(buffer).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}">${rectangles}</svg>`) }]).png().toBuffer();
      }
      overlays.push({ input: buffer, left, top: y });
    }
  }
  overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="${sheetHeight}"><g font-family="Arial" fill="#111827">${labels.join('')}</g></svg>`), left: 0, top: 0 });
  return sharp({ create: { width: sheetWidth, height: sheetHeight, channels: 4, background: '#ffffff' } }).composite(overlays).png().toBuffer();
}

export async function renderProposal(outputPath, proposalPath, version) {
  const output = resolve(outputPath), proposal = resolve(proposalPath);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const budget = validateManifest(manifest);
  const lockPath = join(output, '.render.lock');
  const lock = await open(lockPath, 'wx');
  let attempt, versionPath, checkedProposalBytes, createdVersion = false;
  const started = performance.now();
  const event = row => appendFile(join(output, 'render-events.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...row })}\n`);
  try {
    // This gate also applies to direct module callers. Refusals do not spend
    // the expensive render budget and are explicitly separate from attempts.
    if (manifest.evidenceRequired) {
      try { await assertEvidenceReady(output); }
      catch (error) { await event({ event: 'evidence_refusal', version, proposal, error: error.message }); throw error; }
    }
    const previous = (await readFile(join(output, 'render-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (manifest.repairRequired) {
      try { await assertPreviousReviewed(output); }
      catch (error) { await event({ event: 'review_refusal', version, proposal, error: error.message }); throw error; }
      // Invalid/missing proposals remain ordinary failed attempts. Only a
      // successfully parsed but unchanged scene is a free gate refusal.
      let candidate;
      try { checkedProposalBytes = await readFile(proposal); candidate = JSON.parse(checkedProposalBytes.toString('utf8')); } catch {}
      if (candidate !== undefined) {
        try { await assertChangedProposal(output, candidate, previous); }
        catch (error) { await event({ event: 'unchanged_proposal_refusal', version, proposal, error: error.message }); throw error; }
      }
    }
    attempt = previous.filter(row => row.event === 'attempt').length + 1;
    if (attempt > budget) throw new Error(`Render limit reached (${budget} attempts, including failed attempts)`);
    await event({ event: 'attempt', attempt, version, proposal });
    validateVersion(version, budget);
    versionPath = join(output, version);
    await mkdir(versionPath);
    createdVersion = true;
    await save(join(versionPath, 'README.md'), '# Render attempt\n\n`submitted.json` is the model proposal; `scene.json` is the validated scene after conservative icon crop checks. `result.svg` and `preview.png` render the adopted scene. `crop-audit.json` records every crop decision; `crop-review.png`, when present, shows submitted and adopted icon crops at independent display scales. `stats.json` records time, object counts and hashes. A failed attempt has `error.json`.\n');
    const submittedBytes = checkedProposalBytes ?? await readFile(proposal);
    await save(join(versionPath, 'submitted.json'), submittedBytes);
    const submitted = JSON.parse(submittedBytes.toString('utf8'));
    const sourcePng = await readFile(join(output, 'source.png'));
    if (hash(sourcePng) !== manifest.sourceSha256) throw new Error('Normalized source hash changed');
    const source = { sourcePng, width: manifest.width, height: manifest.height };
    const checkedInput = validateScene(submitted, source);
    const repaired = await repairImageCrops(checkedInput, source);
    if (manifest.repairRequired) {
      // In the repair loop the model owns every adopted bounding box. Keep
      // automatic pixel measurements as reviewable suggestions, not hidden
      // edits that could cut off disconnected icon parts after review.
      repaired.scene = checkedInput;
      repaired.audit.adoptionPolicy = 'model-proposal-no-automatic-crop-changes';
      repaired.audit.items = repaired.audit.items.map(item => {
        const changed = item.finalBox.some((value, index) => value !== item.originalBox[index]);
        return { ...item, suggestedBox: [...item.finalBox], automaticSuggestionStatus: item.status,
          automaticSuggestionReason: item.reason, finalBox: [...item.originalBox],
          status: changed ? 'needs_review' : item.status,
          reason: changed ? 'Automatic pixel analysis suggested a different crop. Closed-loop mode retained the submitted box; inspect and submit a changed proposal to adopt or correct the suggestion.' : item.reason,
          evidence: { ...item.evidence, measuredBox: [...item.finalBox], boundaryCheckAppliesTo: 'suggestedBox' } };
      });
      repaired.audit.unresolvedIds = repaired.audit.items.filter(item => item.status === 'needs_review').map(item => item.id);
      repaired.audit.limitations.push('In closed-loop mode automatic results are suggestions only; finalBox always equals the model-submitted box. Measurement boundary checks refer to suggestedBox; review recomputes boundary contacts for the actual adopted box.');
    }
    const scene = validateScene(repaired.scene, source);
    const rendered = await compileScene(scene, source);
    const cropPreview = manifest.reviewProtocol === 'object-review-v1' ? null
      : await cropReview(sourcePng, repaired.audit, source.width, source.height);
    await save(join(versionPath, 'scene.json'), json(scene));
    await save(join(versionPath, 'result.svg'), rendered.svg);
    await save(join(versionPath, 'preview.png'), rendered.png);
    await save(join(versionPath, 'crop-audit.json'), json(repaired.audit));
    if (cropPreview) await save(join(versionPath, 'crop-review.png'), cropPreview);
    const stats = { protocol: PROTOCOL, attempt, version, width: source.width, height: source.height,
      elapsedMs: Math.round(performance.now() - started), ...rendered.stats,
      sourceSha256: hash(sourcePng), proposalSha256: hash(submittedBytes), semanticProposalSha256: semanticHash(submitted), sceneSha256: hash(json(scene)),
      svgSha256: hash(rendered.svg), previewSha256: hash(rendered.png),
      repairedCropIds: repaired.audit.items.filter(item => item.status === 'repaired').map(item => item.id),
      ...(manifest.repairRequired ? { suggestedCropIds: repaired.audit.items.filter(item => item.suggestedBox.some((value, index) => value !== item.finalBox[index])).map(item => item.id), cropAdoptionPolicy: repaired.audit.adoptionPolicy } : {}),
      unresolvedCropIds: repaired.audit.unresolvedIds, apiCalls: 0, modelTokens: 0,
      note: 'Local rendering only; model conversation token usage is recorded separately when available.' };
    await save(join(versionPath, 'stats.json'), json(stats));
    await event({ event: 'success', attempt, version, elapsedMs: stats.elapsedMs, unresolvedCropIds: stats.unresolvedCropIds });
    if (manifest.repairRequired) await refreshVerificationState(output);
    return { ...stats, directory: versionPath, source: join(output, 'source.png'), svg: join(versionPath, 'result.svg'),
      preview: join(versionPath, 'preview.png'), scene: join(versionPath, 'scene.json'),
      cropAudit: join(versionPath, 'crop-audit.json'), cropReview: cropPreview ? join(versionPath, 'crop-review.png') : null,
      remainingAttempts: budget - attempt };
  } catch (error) {
    if (attempt && attempt <= budget) {
      const failure = { event: 'failure', attempt, version, elapsedMs: Math.round(performance.now() - started), error: error.message };
      await event(failure);
      // Never overwrite an existing version's files when a duplicate version was requested.
      if (createdVersion) await save(join(versionPath, 'error.json'), json(failure)).catch(() => {});
    }
    throw error;
  } finally {
    await lock.close();
    const { unlink } = await import('node:fs/promises');
    await unlink(lockPath);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, a, b, c, ...extra] = process.argv.slice(2);
  try {
    const usage = 'Usage: node tools/render.mjs init INPUT OUTPUT_DIR [--evidence | --closed-loop [--max-attempts 1..12]] | render OUTPUT_DIR PROPOSAL_JSON VERSION | preflight OUTPUT_DIR PROPOSAL_JSON VERSION';
    if (!a || !b || !['init', 'render', 'preflight'].includes(command)) throw new Error(usage);
    let result;
    if (command === 'init') {
      const options = {}, flags = [c, ...extra].filter(value => value !== undefined), seen = new Set();
      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
        seen.add(flag);
        if (flag === '--evidence') options.evidenceRequired = true;
        else if (flag === '--closed-loop') options.repairRequired = true;
        else if (flag === '--max-attempts') {
          const value = flags[++i];
          if (!/^\d+$/.test(value ?? '')) throw new Error('--max-attempts must be an integer from 1 to 12');
          options.maxRenderAttempts = Number(value);
        } else throw new Error(usage);
      }
      result = await initializeRun(a, b, options);
    } else {
      if (!c || extra.length) throw new Error(usage);
      result = command === 'render' ? await renderProposal(a, b, c) : await preflightProposal(a, b, c);
    }
    process.stdout.write(json(result));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
