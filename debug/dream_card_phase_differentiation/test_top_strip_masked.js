#!/usr/bin/env node
'use strict';

// Like inspect_phase_differences but ONLY computes the top-20%-of-strip
// chromaticity / raw RGB / combined distance, AND applies the dream alpha
// mask (from seasonal/cloud-spirit/梦·灵气灌注1.png) to exclude transparent
// background pixels before averaging. Hypothesis: the previous top-10%
// experiment failed because the strip's top edge captured the screenshot
// background (which is dark blue) — biasing every crop's chromaticity.
//
// Region: x∈[0.0608, 0.20], y∈[0, 0.12] of the dream slot rect.
//
// Run: node debug/dream_card_phase_differentiation/test_top_strip_masked.js

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

const DEFAULT_DREAM_RATIO    = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;

// Top 20% of dream name strip (strip is y∈[0, 0.6] of card).
const TOP_STRIP_REGION = { x: 0.0608, y: 0.00, width: 0.1392, height: 0.12 };

// Dream alpha mask source.
const DREAM_MASK_FILE = path.join(ROOT, 'images', 'seasonal', 'cloud-spirit', '梦·灵气灌注1.png');

const CASES = [
  { ss: 'fengxuround6.png',  card: '梦•轰雷掣电',  slot: 6, truth: 'P2', cal: 'fengxu' },
  { ss: 'fengxuround7.png',  card: '梦•星轨推衍',  slot: 3, truth: 'P2', cal: 'fengxu' },
  { ss: 'fengxuround7.png',  card: '梦•乾卦',     slot: 0, truth: 'P3', cal: 'fengxu' },
  { ss: 'fengxuround7.png',  card: '梦•轰雷掣电',  slot: 2, truth: 'P3', cal: 'fengxu' },
  { ss: 'fengxuround15.png', card: '梦•两仪阵',   slot: 0, truth: 'P5', cal: 'fengxu' },
  { ss: 'fengxuround15.png', card: '梦•蜻蜓点水', slot: 4, truth: 'P5', cal: 'fengxu' },
  { ss: 'fengxuround15.png', card: '梦•星轨推衍', slot: 5, truth: 'P5', cal: 'fengxu' },
  { ss: 'fengxuround15.png', card: '梦•星弈挡',   slot: 7, truth: 'P5', cal: 'fengxu' },
  // Regression case: 混元碎击 in check1.png (Mac calibration, different resolution).
  { ss: '../name_strip_detection_check/check1.png', card: '梦•混元碎击', slot: 0, truth: 'P1', cal: 'mac' },
];

const CAL_FENGXU = path.join(__dirname, 'calibration.json');
const CAL_MAC    = path.join(process.env.HOME || '', 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const IMAGES_DIR = path.join(ROOT, 'images');

function normalizeCardName(n) { return (n || '').replace(/[·•]/g, '•').trim(); }

function buildAlphaMask(filePath) {
  const { data, width, height } = decodePng(filePath);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = data[i * 4 + 3] === 0 ? 0 : 1;
  }
  return { mask, width, height };
}

function resizeMaskNN(srcMask, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH);
  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(srcH - 1, Math.floor(dy * srcH / dstH));
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(srcW - 1, Math.floor(dx * srcW / dstW));
      out[dy * dstW + dx] = srcMask[sy * srcW + sx];
    }
  }
  return out;
}

function bilinearResizeRgba(srcRgba, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  const rx = srcW / dstW, ry = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const fx = dx * rx, fy = dy * ry;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, srcW - 1), y1 = Math.min(y0 + 1, srcH - 1);
      const wx = fx - x0, wy = fy - y0;
      const di = (dy * dstW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        const v00 = srcRgba[(y0*srcW+x0)*4+c];
        const v01 = srcRgba[(y0*srcW+x1)*4+c];
        const v10 = srcRgba[(y1*srcW+x0)*4+c];
        const v11 = srcRgba[(y1*srcW+x1)*4+c];
        out[di+c] = Math.round((1-wx)*(1-wy)*v00 + wx*(1-wy)*v01 + (1-wx)*wy*v10 + wx*wy*v11);
      }
    }
  }
  return out;
}

// Crop a region from a screenshot, return RGBA at slot dims.
function cropRgba(srcRgba, srcW, srcH, x, y, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const sx = x + i, sy = y + j;
      if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
        const si = (sy * srcW + sx) * 4;
        const di = (j * w + i) * 4;
        out[di]   = srcRgba[si];
        out[di+1] = srcRgba[si+1];
        out[di+2] = srcRgba[si+2];
        out[di+3] = srcRgba[si+3];
      }
    }
  }
  return out;
}

// Compute mean RGB over a region with optional binary mask.
function meanRgbInRegion(rgba, w, h, region, mask) {
  const x0 = Math.max(0, Math.floor(region.x * w));
  const y0 = Math.max(0, Math.floor(region.y * h));
  const x1 = Math.min(w, Math.ceil((region.x + region.width)  * w));
  const y1 = Math.min(h, Math.ceil((region.y + region.height) * h));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * w + x;
      if (mask && mask[idx] === 0) continue;
      r += rgba[idx*4];
      g += rgba[idx*4+1];
      b += rgba[idx*4+2];
      n += 1;
    }
  }
  return n ? { r: r/n, g: g/n, b: b/n, n } : null;
}

function chromaticity(avg) {
  if (!avg) return null;
  const sum = avg.r + avg.g + avg.b;
  return sum < 1 ? null : { r: avg.r/sum, g: avg.g/sum, b: avg.b/sum };
}

// Find phase templates for a given dream card name.
function findPhaseTemplates(cardName) {
  const target = normalizeCardName(cardName);
  const out = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.toLowerCase().endsWith('.png')) {
        const m = path.basename(e.name, '.png').match(/^(.*?)(\d+)$/u);
        if (!m) continue;
        if (normalizeCardName(m[1]) !== target) continue;
        out.push({ phase: parseInt(m[2], 10), filePath: f });
      }
    }
  }
  walk(path.join(IMAGES_DIR, 'seasonal'));
  out.sort((a, b) => a.phase - b.phase);
  return out;
}

// ── Setup ────────────────────────────────────────────────────────────────

const dreamMaskFull = buildAlphaMask(DREAM_MASK_FILE);
console.log(`Dream alpha mask: ${dreamMaskFull.width}×${dreamMaskFull.height} (1=card, 0=transparent)`);

const calFengxu = JSON.parse(fs.readFileSync(CAL_FENGXU, 'utf8'));
const calMac    = fs.existsSync(CAL_MAC) ? JSON.parse(fs.readFileSync(CAL_MAC, 'utf8')) : null;

function buildDreamGeo(cal) {
  const normal = cal.slots;
  const ratio = (normal.dreamSlotRatio && (normal.dreamSlotRatio.width !== 1 || normal.dreamSlotRatio.height !== 1))
    ? normal.dreamSlotRatio : DEFAULT_DREAM_RATIO;
  const xOff = typeof normal.dreamXOffset === 'number' ? normal.dreamXOffset : DEFAULT_DREAM_X_OFFSET;
  return {
    ...normal,
    slotXPositions: normal.slotXPositions.map(x => x + xOff),
    slotWidth:  Math.max(1, Math.round(normal.slotWidth  * ratio.width)),
    slotHeight: Math.max(1, Math.round(normal.slotHeight * ratio.height))
  };
}

const dreamGeoFengxu = buildDreamGeo(calFengxu);
const dreamGeoMac    = calMac ? buildDreamGeo(calMac) : null;

// ── Main loop ────────────────────────────────────────────────────────────

const RAW_RGB_WEIGHT = 0.3; // same as production
let correctRaw = 0, correctChrom = 0, correctCombined = 0;

console.log('\nResults (region = top 20% of dream name strip, with alpha mask applied):\n');

for (const c of CASES) {
  const ssPath = path.join(__dirname, c.ss);
  if (!fs.existsSync(ssPath)) { console.log(`skip ${c.card}: ${c.ss} missing`); continue; }
  const ss = decodePng(ssPath);

  const dreamGeo = c.cal === 'mac' ? dreamGeoMac : dreamGeoFengxu;
  if (!dreamGeo) { console.log(`skip ${c.card}: ${c.cal} calibration missing`); continue; }
  const sx = ss.width / dreamGeo.baseScreenWidth;
  const sy = ss.height / dreamGeo.baseScreenHeight;
  const slotX = Math.round(dreamGeo.slotXPositions[c.slot] * sx);
  const slotY = Math.round(dreamGeo.slotY * sy);
  const slotW = Math.max(1, Math.round(dreamGeo.slotWidth  * sx));
  const slotH = Math.max(1, Math.round(dreamGeo.slotHeight * sy));

  // Crop slot from screenshot.
  const cropRgbaArr = cropRgba(ss.data, ss.width, ss.height, slotX, slotY, slotW, slotH);

  // Resize the dream mask to slot dimensions.
  const slotMask = resizeMaskNN(dreamMaskFull.mask, dreamMaskFull.width, dreamMaskFull.height, slotW, slotH);

  // Crop's masked top-20% mean RGB.
  const cropAvg = meanRgbInRegion(cropRgbaArr, slotW, slotH, TOP_STRIP_REGION, slotMask);
  if (!cropAvg) {
    console.log(`${c.card} slot ${c.slot}: no valid masked pixels`);
    continue;
  }
  const cropChroma = chromaticity(cropAvg);

  // Per-phase templates (resized to slot dims, masked).
  const phases = findPhaseTemplates(c.card);
  const phaseScores = phases.map((p) => {
    const tmpl = decodePng(p.filePath);
    const tmplResized = bilinearResizeRgba(tmpl.data, tmpl.width, tmpl.height, slotW, slotH);
    const tmplAvg = meanRgbInRegion(tmplResized, slotW, slotH, TOP_STRIP_REGION, slotMask);
    const tmplChroma = chromaticity(tmplAvg);
    if (!tmplAvg) return { phase: p.phase, rawDist: Infinity, chromDist: Infinity, combined: Infinity };
    const dr = cropAvg.r - tmplAvg.r, dg = cropAvg.g - tmplAvg.g, db = cropAvg.b - tmplAvg.b;
    const rawDist = Math.sqrt(dr*dr + dg*dg + db*db);
    const cdr = cropChroma.r - tmplChroma.r,
          cdg = cropChroma.g - tmplChroma.g,
          cdb = cropChroma.b - tmplChroma.b;
    const chromDist = Math.sqrt(cdr*cdr + cdg*cdg + cdb*cdb);
    const combined = chromDist + rawDist / 255 * RAW_RGB_WEIGHT;
    return { phase: p.phase, tmpl: tmplAvg, chroma: tmplChroma, rawDist, chromDist, combined };
  });

  const winRaw      = [...phaseScores].sort((a,b) => a.rawDist  - b.rawDist )[0];
  const winChrom    = [...phaseScores].sort((a,b) => a.chromDist- b.chromDist)[0];
  const winCombined = [...phaseScores].sort((a,b) => a.combined - b.combined)[0];

  const rawOk      = `P${winRaw.phase}` === c.truth      ? '✓' : '✗';
  const chromOk    = `P${winChrom.phase}` === c.truth    ? '✓' : '✗';
  const combinedOk = `P${winCombined.phase}` === c.truth ? '✓' : '✗';
  if (rawOk      === '✓') correctRaw++;
  if (chromOk    === '✓') correctChrom++;
  if (combinedOk === '✓') correctCombined++;

  console.log(
    `${c.card.padEnd(14)} (${c.ss.replace('.png','').replace('fengxu','f')} s${c.slot} truth=${c.truth})  ` +
    `mask=${cropAvg.n}px  ` +
    `crop chrom=(${cropChroma.r.toFixed(3)}, ${cropChroma.g.toFixed(3)}, ${cropChroma.b.toFixed(3)})  ` +
    `→ raw=P${winRaw.phase}${rawOk}  chrom=P${winChrom.phase}${chromOk}  combined=P${winCombined.phase}${combinedOk}`
  );
}

console.log(`\nAccuracy:  raw=${correctRaw}/${CASES.length}  chrom=${correctChrom}/${CASES.length}  combined=${correctCombined}/${CASES.length}`);
