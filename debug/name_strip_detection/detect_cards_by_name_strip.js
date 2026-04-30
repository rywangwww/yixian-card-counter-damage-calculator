#!/usr/bin/env node
'use strict';

// detect_cards_by_name_strip.js
//
// Searches calibration_capture.png for the 8 known calibration slot cards
// using only the left-side name strip (reviewRectOverride from
// name_strip_config.json) instead of full-card template matching.
//
// Detection mirrors debug_card_detection.js / calibrator.js in structure:
//   Phase 1 — multi-scale strip search on the seed slot to lock scale + y.
//   Phase 2 — single-scale strip search on all remaining slots, constrained
//              to a tight y-band around the seed row.
//
// All 8 cards are sect or side-job; side-job cards use the same strip rect.
//
// Output: outputs/calibration_capture_name_strip.png

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng, buildImageIndex, findCardImagePath } = require(path.join(ROOT, 'calibrator'));
const { encodePng, drawRect, drawTextBg } = require(path.join(ROOT, 'calibration_debug_draw'));

const CONFIG_PATH = path.join(__dirname, 'name_strip_config.json');
const SS_PATH     = path.join(__dirname, '..', 'calibration', 'calibration_capture.png');
const OUT_PATH    = path.join(__dirname, 'outputs', 'calibration_capture_name_strip.png');
const IMAGES_DIR  = path.join(ROOT, 'images');

const SLOT_CARDS = {
  1: '云剑•闪风1',
  2: '云剑•飞刺3',
  3: '运笔如飞1',
  4: '云剑•汇灵2',
  5: '破气剑1',
  6: '巨鹏灵剑2',
  7: '水月剑阵2',
  8: '镜花剑阵2',
};

const STRIP_TARGET_H = 192;
const DS             = 4;
const NCC_THRESHOLD  = 0.45;

// Reference geometry — same constants as calibrator.js
const SLOT_BASE_H   = 1080;
const SLOT_CONFIG_H = 343;
const Y_MIN_FRAC    = 0.10;
const Y_MAX_FRAC    = 0.88;

const SLOT_COLORS = [
  [255,  80,  80], [255, 165,   0], [255, 255,   0], [ 80, 255,  80],
  [  0, 200, 255], [ 80,  80, 255], [255,  80, 255], [255, 255, 255],
];

// ── Image utilities ──────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function bilinearSample(src, sw, sh, x, y) {
  const x0 = clamp(Math.floor(x), 0, sw - 1);
  const y0 = clamp(Math.floor(y), 0, sh - 1);
  const x1 = Math.min(x0 + 1, sw - 1);
  const y1 = Math.min(y0 + 1, sh - 1);
  const wx = x - x0, wy = y - y0;
  return (1-wx)*(1-wy)*src[y0*sw+x0] + wx*(1-wy)*src[y0*sw+x1] +
         (1-wx)*wy   *src[y1*sw+x0] + wx*wy    *src[y1*sw+x1];
}

function resizeGray(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y += 1)
    for (let x = 0; x < dw; x += 1)
      out[y*dw+x] = bilinearSample(src, sw, sh, (x+0.5)*sw/dw - 0.5, (y+0.5)*sh/dh - 0.5);
  return out;
}

function downsampleNN(gray, w, h, ds) {
  const dw = Math.floor(w/ds), dh = Math.floor(h/ds);
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y += 1)
    for (let x = 0; x < dw; x += 1)
      out[y*dw+x] = gray[y*ds*w + x*ds];
  return { gray: out, w: dw, h: dh };
}

function znccAt(img, iw, sx, sy, tmpl, tw, th) {
  const n = tw * th;
  let sumI = 0, sumT = 0;
  for (let ty = 0; ty < th; ty += 1)
    for (let tx = 0; tx < tw; tx += 1) {
      sumI += img[(sy+ty)*iw + sx+tx];
      sumT += tmpl[ty*tw+tx];
    }
  const mI = sumI/n, mT = sumT/n;
  let num = 0, dI = 0, dT = 0;
  for (let ty = 0; ty < th; ty += 1)
    for (let tx = 0; tx < tw; tx += 1) {
      const di = img[(sy+ty)*iw + sx+tx] - mI;
      const dt = tmpl[ty*tw+tx] - mT;
      num += di*dt; dI += di*di; dT += dt*dt;
    }
  const denom = Math.sqrt(dI * dT);
  return denom < 1 ? 0 : num / denom;
}

// ── Strip extraction ─────────────────────────────────────────────────────────

function extractStripGray(rgba, imgW, imgH, rect) {
  const cx = clamp(Math.round(rect.x * imgW), 0, imgW - 1);
  const cy = clamp(Math.round(rect.y * imgH), 0, imgH - 1);
  const cw = Math.max(1, Math.min(imgW - cx, Math.round(rect.width  * imgW)));
  const ch = Math.max(1, Math.min(imgH - cy, Math.round(rect.height * imgH)));
  const raw = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y += 1)
    for (let x = 0; x < cw; x += 1) {
      const i = ((cy+y)*imgW + (cx+x)) * 4;
      raw[y*cw+x] = 0.299*rgba[i] + 0.587*rgba[i+1] + 0.114*rgba[i+2];
    }
  const canonH = STRIP_TARGET_H;
  const canonW = Math.max(24, Math.round((rect.width / rect.height) * canonH));
  return { gray: resizeGray(raw, cw, ch, canonW, canonH), w: canonW, h: canonH };
}

// ── Coarse multi-scale strip search (phase 1 — finds scale) ─────────────────

function coarseMultiScale(ss4, ssW, ssH, canonGray, canonW, canonH, tmplW, tmplH, rect, yMin, yMax) {
  const baseScale = (ssH / SLOT_BASE_H) * (SLOT_CONFIG_H / tmplH);
  const cy0 = Math.max(0, Math.floor(yMin / DS));
  const cy1cap = Math.floor(yMax / DS);
  let best = { ncc: -Infinity, x: 0, y: 0, sw: 0, sh: 0, scale: baseScale };

  for (let mult = 0.70; mult <= 1.30 + 1e-9; mult += 0.05) {
    const s      = baseScale * mult;
    const stripH = Math.max(1, Math.round(rect.height * tmplH * s));
    const stripW = Math.max(1, Math.round(rect.width  * tmplW * s));
    if (stripH >= ssH || stripW >= ssW) continue;

    const sh4 = Math.max(1, Math.floor(stripH / DS));
    const sw4 = Math.max(1, Math.floor(stripW / DS));
    const tm4 = resizeGray(canonGray, canonW, canonH, sw4, sh4);

    const cx1 = ss4.w - sw4;
    const cy1 = Math.min(ss4.h - sh4, cy1cap);
    for (let y = cy0; y <= cy1; y += 1)
      for (let x = 0; x <= cx1; x += 1) {
        const score = znccAt(ss4.gray, ss4.w, x, y, tm4, sw4, sh4);
        if (score > best.ncc)
          best = { ncc: score, x: x*DS, y: y*DS, sw: stripW, sh: stripH, scale: s };
      }
  }
  return best;
}

// ── Single-scale coarse search (phase 2 — scale already locked) ─────────────
//
// The y-band here is only a few dozen pixels tall (locked from the seed row),
// so scanning the full-resolution image at a stride of DS is both fast and far
// more reliable than downsampling the template to 7×51 px, which produces
// misleading NCC values for some cards.

function coarseAtScale(ssGray, ssW, ssH, canonGray, canonW, canonH, tmplW, tmplH, rect, scale, yMin, yMax) {
  const stripH = Math.max(1, Math.round(rect.height * tmplH * scale));
  const stripW = Math.max(1, Math.round(rect.width  * tmplW * scale));
  if (stripH >= ssH || stripW >= ssW) return null;

  const tmplFull = resizeGray(canonGray, canonW, canonH, stripW, stripH);

  const cx1 = ssW - stripW;
  const cy0 = Math.max(0, yMin);
  const cy1 = Math.min(ssH - stripH, yMax);

  let best = { ncc: -Infinity, x: 0, y: 0, sw: stripW, sh: stripH };
  for (let y = cy0; y <= cy1; y += DS)
    for (let x = 0; x <= cx1; x += DS) {
      const score = znccAt(ssGray, ssW, x, y, tmplFull, stripW, stripH);
      if (score > best.ncc)
        best = { ncc: score, x, y, sw: stripW, sh: stripH };
    }
  return best;
}

// ── Full-resolution fine refine ──────────────────────────────────────────────

function fineRefine(ssGray, ssW, ssH, canonGray, canonW, canonH, coarse, yMin) {
  const tmplFull = resizeGray(canonGray, canonW, canonH, coarse.sw, coarse.sh);
  const margin   = DS * 3;
  const fx0 = Math.max(0,    coarse.x - margin);
  const fy0 = Math.max(yMin, coarse.y - margin);
  const fx1 = Math.min(ssW - coarse.sw, coarse.x + margin);
  const fy1 = Math.min(ssH - coarse.sh, coarse.y + margin);

  let best = -Infinity, bx = coarse.x, by = coarse.y;
  for (let y = fy0; y <= fy1; y += 1)
    for (let x = fx0; x <= fx1; x += 1) {
      const score = znccAt(ssGray, ssW, x, y, tmplFull, coarse.sw, coarse.sh);
      if (score > best) { best = score; bx = x; by = y; }
    }
  return { ...coarse, ncc: best, x: bx, y: by };
}

// ── Full card box recovery ────────────────────────────────────────────────────

function fullCardBox(strip, rect) {
  const cardW = Math.round(strip.sw / rect.width);
  const cardH = Math.round(strip.sh / rect.height);
  const cardX = Math.round(strip.x - rect.x * cardW);
  const cardY = Math.round(strip.y - rect.y * cardH);
  return { x: cardX, y: cardY, w: cardW, h: cardH };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const rect   = config.classes.sect.reviewRectOverride;

  const imageIndex = buildImageIndex(IMAGES_DIR);

  const ssImg = decodePng(SS_PATH);
  const { data: ssRgba, width: ssW, height: ssH } = ssImg;

  const ssGray = new Float32Array(ssW * ssH);
  for (let i = 0; i < ssW * ssH; i += 1)
    ssGray[i] = 0.299*ssRgba[i*4] + 0.587*ssRgba[i*4+1] + 0.114*ssRgba[i*4+2];
  const ss4 = downsampleNN(ssGray, ssW, ssH, DS);

  const yMin  = Math.floor(ssH * Y_MIN_FRAC);
  const yMax  = Math.floor(ssH * Y_MAX_FRAC);

  // Load all strip templates up front
  const templates = {};
  for (const [slotStr, cardName] of Object.entries(SLOT_CARDS)) {
    const slot    = Number(slotStr);
    const imgPath = findCardImagePath(cardName, imageIndex);
    if (!imgPath) { console.log(`slot${slot}: ${cardName} — image NOT FOUND`); continue; }
    const { data: rgba, width: tw, height: th } = decodePng(imgPath);
    const { gray: canonGray, w: canonW, h: canonH } = extractStripGray(rgba, tw, th, rect);
    templates[slot] = { cardName, tmplW: tw, tmplH: th, canonGray, canonW, canonH };
  }

  const slots = Object.keys(templates).map(Number).sort((a, b) => a - b);

  // Phase 1 — multi-scale search on the seed slot to lock scale + y-row
  const seedSlot = slots[0];
  const seedT    = templates[seedSlot];

  process.stdout.write(`slot${seedSlot}: ${seedT.cardName} [seed, multi-scale] ... `);
  const seedCoarse = coarseMultiScale(ss4, ssW, ssH,
    seedT.canonGray, seedT.canonW, seedT.canonH, seedT.tmplW, seedT.tmplH, rect, yMin, yMax);
  const seedFine = fineRefine(ssGray, ssW, ssH,
    seedT.canonGray, seedT.canonW, seedT.canonH, seedCoarse, yMin);

  const lockedScale = seedCoarse.scale;
  const rowY        = seedFine.y;
  const yBand       = Math.max(20, Math.floor(ssH * 0.03));
  const yMinFast    = Math.max(yMin, rowY - yBand);
  const yMaxFast    = Math.min(yMax, rowY + seedFine.sh + yBand);

  const results = {};
  results[seedSlot] = seedFine;

  const seedBox = fullCardBox(seedFine, rect);
  console.log(`ncc=${seedFine.ncc.toFixed(3)}  strip=(${seedFine.x},${seedFine.y} ${seedFine.sw}×${seedFine.sh})  card=(${seedBox.x},${seedBox.y} ${seedBox.w}×${seedBox.h})  scale=${lockedScale.toFixed(4)}`);

  // Phase 2 — locked-scale search for all remaining slots in the narrow y-band
  for (const slot of slots) {
    if (slot === seedSlot) continue;
    const t = templates[slot];
    process.stdout.write(`slot${slot}: ${t.cardName} [locked scale] ... `);
    const coarse = coarseAtScale(ssGray, ssW, ssH,
      t.canonGray, t.canonW, t.canonH, t.tmplW, t.tmplH, rect, lockedScale, yMinFast, yMaxFast);
    if (!coarse) { console.log('skip (strip too large)'); continue; }
    const fine = fineRefine(ssGray, ssW, ssH,
      t.canonGray, t.canonW, t.canonH, coarse, yMinFast);
    results[slot] = fine;
    const box = fullCardBox(fine, rect);
    console.log(`ncc=${fine.ncc.toFixed(3)}  strip=(${fine.x},${fine.y} ${fine.sw}×${fine.sh})  card=(${box.x},${box.y} ${box.w}×${box.h})`);
  }

  // Draw output
  const out = new Uint8Array(ssW * ssH * 4);
  out.set(ssRgba);
  for (let i = 0; i < ssW * ssH; i += 1) out[i*4+3] = 255;

  const found = [];
  for (const [slotStr, fine] of Object.entries(results)) {
    const slot = Number(slotStr);
    if (fine.ncc < NCC_THRESHOLD) continue;
    const box = fullCardBox(fine, rect);
    found.push({ slot, box, ncc: fine.ncc });
    const [r, g, b] = SLOT_COLORS[(slot-1) % SLOT_COLORS.length];
    drawRect(out, ssW, ssH, box.x, box.y, box.w, box.h, r, g, b, 3);
    drawRect(out, ssW, ssH, fine.x, fine.y, fine.sw, fine.sh, 255, 255, 255, 1);
    drawTextBg(out, ssW, ssH, `S${slot} ${fine.ncc.toFixed(2)}`, box.x+4, box.y+4, 2);
  }

  // Summary
  found.sort((a, b) => a.slot - b.slot);
  if (found.length >= 2) {
    const avgY = Math.round(found.reduce((s, f) => s + f.box.y, 0) / found.length);
    const avgW = Math.round(found.reduce((s, f) => s + f.box.w, 0) / found.length);
    const avgH = Math.round(found.reduce((s, f) => s + f.box.h, 0) / found.length);
    console.log(`\nFound ${found.length}/8 slots  avg card: ${avgW}×${avgH}  slotY=${avgY}`);
    console.log(`X positions: [${found.map((f) => f.box.x).join(', ')}]`);
  } else {
    console.log(`\nFound only ${found.length}/8 slots above NCC ${NCC_THRESHOLD}`);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, encodePng(out, ssW, ssH));
  console.log(`\nWrote ${path.relative(ROOT, OUT_PATH)}`);
}

main();
