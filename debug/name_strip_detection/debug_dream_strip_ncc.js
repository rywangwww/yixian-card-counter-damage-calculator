#!/usr/bin/env node
'use strict';

// debug_dream_strip_ncc.js
//
// DEPRECATED — hardcodes CALIBRATION_TOP_CORRECTION=0.079 which was removed
// from name_strip_detector.js. Output no longer reflects live detector behavior.
//
// Standalone (no Electron) script that checks why dream card name-strip NCC
// fails.  Loads board.png from dream_card_phase_differentiation, extracts the
// dream slot strip at the position name_strip_detector.js would use, and
// compares it against the canonical template strip.
//
// Run from repo root:
//   node debug/name_strip_detection/debug_dream_strip_ncc.js

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));
const { encodePng } = require(path.join(ROOT, 'calibration_debug_draw'));

const CALIBRATION_PATH = path.join(
  process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json'
);
const BOARD_PATH   = path.join(__dirname, '..', 'dream_card_phase_differentiation', 'board.png');
const TEMPLATE_DIR = path.join(ROOT, 'images', 'seasonal', 'heptastar');
const OUT_DIR      = path.join(__dirname, 'outputs');

// Must match name_strip_detector.js
const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  dream:    { x: 0.0608, y: 0, width: 0.1392, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};
const STRIP_CANONICAL_H    = 192;
const DEFAULT_DREAM_RATIO  = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_XOFF   = 8;

// ── Image helpers ─────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function bilinearSample(gray, w, h, x, y) {
  const x0 = clamp(Math.floor(x), 0, w - 1);
  const y0 = clamp(Math.floor(y), 0, h - 1);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const wx = x - x0, wy = y - y0;
  return (1-wx)*(1-wy)*gray[y0*w+x0] + wx*(1-wy)*gray[y0*w+x1]
       + (1-wx)*wy   *gray[y1*w+x0] + wx*wy    *gray[y1*w+x1];
}

function resizeGray(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      out[y*dw+x] = bilinearSample(src, sw, sh, (x+0.5)*sw/dw - 0.5, (y+0.5)*sh/dh - 0.5);
    }
  }
  return out;
}

function rgbaToGray(rgba, w, h) {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // PNG is RGBA
    gray[i] = 0.299 * rgba[i*4] + 0.587 * rgba[i*4+1] + 0.114 * rgba[i*4+2];
  }
  return gray;
}

function zncc(a, b, n) {
  let sA = 0, sB = 0;
  for (let i = 0; i < n; i++) { sA += a[i]; sB += b[i]; }
  const mA = sA / n, mB = sB / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom < 1 ? 0 : num / denom;
}

function cropGray(gray, srcW, x, y, w, h) {
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      out[j*w+i] = gray[(y+j)*srcW + (x+i)];
    }
  }
  return out;
}

function grayToRgba(gray, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(clamp(gray[i], 0, 255));
    out[i*4] = v; out[i*4+1] = v; out[i*4+2] = v; out[i*4+3] = 255;
  }
  return out;
}

function saveGray(gray, w, h, outPath) {
  const rgba = grayToRgba(gray, w, h);
  fs.writeFileSync(outPath, encodePng(rgba, w, h));
  console.log(`  saved: ${path.relative(ROOT, outPath)} (${w}x${h})`);
}

// ── Slot geometry ─────────────────────────────────────────────────────────────

function scaledDreamSlotRect(slotIndex, ssW, ssH, cal) {
  const n = cal.slots;
  const ratio = (n.dreamSlotRatio && (n.dreamSlotRatio.width !== 1 || n.dreamSlotRatio.height !== 1))
    ? n.dreamSlotRatio : DEFAULT_DREAM_RATIO;
  const xOff = typeof n.dreamXOffset === 'number' ? n.dreamXOffset : DEFAULT_DREAM_XOFF;

  const dreamSW = Math.max(1, Math.round(n.slotWidth  * ratio.width));
  const dreamSH = Math.max(1, Math.round(n.slotHeight * ratio.height));
  const dreamX  = n.slotXPositions[slotIndex] + xOff;

  const scaleX = ssW / n.baseScreenWidth;
  const scaleY = ssH / n.baseScreenHeight;
  return {
    x:      Math.round(dreamX   * scaleX),
    y:      Math.round(n.slotY  * scaleY),
    width:  Math.max(1, Math.round(dreamSW * scaleX)),
    height: Math.max(1, Math.round(dreamSH * scaleY)),
  };
}

function scaledNormalSlotRect(slotIndex, ssW, ssH, cal) {
  const n = cal.slots;
  const scaleX = ssW / n.baseScreenWidth;
  const scaleY = ssH / n.baseScreenHeight;
  return {
    x:      Math.round(n.slotXPositions[slotIndex] * scaleX),
    y:      Math.round(n.slotY  * scaleY),
    width:  Math.max(1, Math.round(n.slotWidth  * scaleX)),
    height: Math.max(1, Math.round(n.slotHeight * scaleY)),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(CALIBRATION_PATH)) {
    console.error('calibration.json not found at', CALIBRATION_PATH);
    process.exit(1);
  }
  const cal = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));

  const board = decodePng(BOARD_PATH);
  const { data: ssRgba, width: ssW, height: ssH } = board;
  const ssGray = rgbaToGray(ssRgba, ssW, ssH);
  console.log(`Board: ${ssW}x${ssH}`);
  console.log(`Calibration base: ${cal.slots.baseScreenWidth}x${cal.slots.baseScreenHeight}`);

  const SLOT = 0;
  const dreamRect  = scaledDreamSlotRect(SLOT, ssW, ssH, cal);
  const normalRect = scaledNormalSlotRect(SLOT, ssW, ssH, cal);
  console.log(`\nSlot 1 normal rect: x=${normalRect.x} y=${normalRect.y} ${normalRect.width}x${normalRect.height}`);
  console.log(`Slot 1 dream  rect: x=${dreamRect.x}  y=${dreamRect.y}  ${dreamRect.width}x${dreamRect.height}`);

  // Find dream card templates for 梦•蜻蜓点水
  const templates = [];
  for (const f of fs.readdirSync(TEMPLATE_DIR)) {
    if (!f.toLowerCase().endsWith('.png')) continue;
    const name = path.basename(f, '.png').replace(/[·•]/g, '•');
    const m = name.match(/^(.*?)(\d+)$/u);
    if (!m) continue;
    if (m[1] === '梦•蜻蜓点水') templates.push({ phase: parseInt(m[2], 10), file: path.join(TEMPLATE_DIR, f) });
  }
  templates.sort((a, b) => a.phase - b.phase);
  console.log(`\nFound ${templates.length} template phases for 梦•蜻蜓点水`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const strip = STRIP_RECT.dream;

  const CALIBRATION_TOP_CORRECTION = 0.079;

  // Extract screenshot strips (raw calibration position, corrected position, or normal rect)
  function extractScreenStripGray(slotRect, applyCorrection) {
    let effH = slotRect.height;
    let effY = slotRect.y;
    if (applyCorrection) {
      effH = slotRect.height / (1 - CALIBRATION_TOP_CORRECTION);
      effY = slotRect.y - CALIBRATION_TOP_CORRECTION * effH;
    }
    const sx = Math.round(slotRect.x + strip.x * slotRect.width);
    const sy = Math.round(effY + strip.y * effH);
    const sw = Math.max(1, Math.round(strip.width  * slotRect.width));
    const sh = Math.max(1, Math.round(strip.height * effH));
    console.log(`  Strip region: x=${sx} y=${sy} w=${sw} h=${sh}`);
    const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
    const x1 = Math.min(ssW, sx+sw), y1 = Math.min(ssH, sy+sh);
    const aw = x1-x0, ah = y1-y0;
    return { gray: cropGray(ssGray, ssW, x0, y0, aw, ah), w: aw, h: ah };
  }

  console.log('\nExtracting dream strip from DREAM rect (raw):');
  const dreamStrip = extractScreenStripGray(dreamRect, false);
  console.log('\nExtracting dream strip from DREAM rect (corrected):');
  const dreamStripCorrected = extractScreenStripGray(dreamRect, true);
  console.log('\nExtracting dream strip from NORMAL rect (raw):');
  const normalStrip = extractScreenStripGray(normalRect, false);

  const canonH = STRIP_CANONICAL_H;
  // Derive canonW from the screenshot strip's ACTUAL pixel AR (cw/ch), not the
  // rect fraction ratio (strip.width/strip.height).  Using rect fractions assumes
  // a square card; for a ~0.6-AR card the two differ by ~40%, causing template and
  // screenshot to be distorted in opposite directions and killing NCC.
  const canonW = Math.max(24, Math.round((dreamStripCorrected.w / dreamStripCorrected.h) * canonH));
  console.log(`\nCanonical strip size: ${canonW}x${canonH} (derived from actual strip AR ${dreamStripCorrected.w}/${dreamStripCorrected.h}=${(dreamStripCorrected.w/dreamStripCorrected.h).toFixed(3)})`);

  const dreamStripCanon           = resizeGray(dreamStrip.gray,          dreamStrip.w,          dreamStrip.h,          canonW, canonH);
  const dreamStripCorrectedCanon  = resizeGray(dreamStripCorrected.gray, dreamStripCorrected.w, dreamStripCorrected.h, canonW, canonH);
  const normalStripCanon          = resizeGray(normalStrip.gray,         normalStrip.w,         normalStrip.h,         canonW, canonH);

  saveGray(dreamStripCanon,          canonW, canonH, path.join(OUT_DIR, 'debug_dream_ss_strip_dreamrect.png'));
  saveGray(dreamStripCorrectedCanon, canonW, canonH, path.join(OUT_DIR, 'debug_dream_ss_strip_dreamrect_corrected.png'));
  saveGray(normalStripCanon,         canonW, canonH, path.join(OUT_DIR, 'debug_dream_ss_strip_normalrect.png'));

  // Process each template
  console.log('\n--- NCC scores ---');
  for (const tmpl of templates) {
    const img  = decodePng(tmpl.file);
    const gray = rgbaToGray(img.data, img.width, img.height);
    console.log(`  Template P${tmpl.phase}: ${img.width}x${img.height}`);

    const cx = Math.max(0, Math.round(strip.x * img.width));
    const cy = 0;
    const cw = Math.max(1, Math.min(img.width - cx, Math.round(strip.width  * img.width)));
    const ch = Math.max(1, Math.min(img.height,      Math.round(strip.height * img.height)));

    console.log(`    Template strip: x=${cx} y=${cy} w=${cw} h=${ch}`);
    const tmplCrop  = cropGray(gray, img.width, cx, cy, cw, ch);
    const tmplCanon = resizeGray(tmplCrop, cw, ch, canonW, canonH);

    if (tmpl.phase === 1) {
      saveGray(tmplCanon, canonW, canonH, path.join(OUT_DIR, 'debug_dream_tmpl_strip_p1.png'));
    }

    const nccDream      = zncc(dreamStripCanon,          tmplCanon, canonW * canonH);
    const nccDreamCorr  = zncc(dreamStripCorrectedCanon, tmplCanon, canonW * canonH);
    const nccNormal     = zncc(normalStripCanon,         tmplCanon, canonW * canonH);
    console.log(`    NCC (dream rect raw):       ${nccDream.toFixed(4)}`);
    console.log(`    NCC (dream rect corrected): ${nccDreamCorr.toFixed(4)}`);
    console.log(`    NCC (normal rect raw):      ${nccNormal.toFixed(4)}`);

    if (tmpl.phase === 1) {
      // Fine y-scan: try strip start positions from y=250 to y=310 to find best NCC
      const sw = Math.max(1, Math.round(strip.width  * dreamRect.width));
      let bestNcc = -1, bestY = -1, bestSH = -1;
      for (let testY = 250; testY <= 310; testY += 1) {
        for (let totalHMult = 0.85; totalHMult <= 1.20; totalHMult += 0.05) {
          const totalH = Math.round(dreamRect.height / (1 - CALIBRATION_TOP_CORRECTION) * totalHMult);
          const sh = Math.max(1, Math.round(strip.height * totalH));
          if (testY + sh > ssH) continue;
          const ssStrip = cropGray(ssGray, ssW, Math.max(0, Math.round(dreamRect.x + strip.x * dreamRect.width)), testY, sw, sh);
          const ssCanon = resizeGray(ssStrip, sw, sh, canonW, canonH);
          const score = zncc(ssCanon, tmplCanon, canonW * canonH);
          if (score > bestNcc) { bestNcc = score; bestY = testY; bestSH = sh; }
        }
      }
      console.log(`    Best NCC from y-scan: ${bestNcc.toFixed(4)} at y=${bestY} sh=${bestSH}`);
      // Fine scan y=268..282 to show the NCC landscape
      console.log(`    y-scan detail (sh=197):`);
      for (let testY = 268; testY <= 282; testY += 1) {
        const sh = 197;
        const ssStrip = cropGray(ssGray, ssW, Math.round(dreamRect.x + strip.x * dreamRect.width), testY, sw, sh);
        const ssCanon = resizeGray(ssStrip, sw, sh, canonW, canonH);
        const score = zncc(ssCanon, tmplCanon, canonW * canonH);
        console.log(`      y=${testY}: NCC=${score.toFixed(4)}`);
      }
    }
  }

  // Also save full slot crops for visual inspection
  function saveSlotCrop(slotRect, label) {
    const x0 = Math.max(0, slotRect.x), y0 = Math.max(0, slotRect.y);
    const x1 = Math.min(ssW, slotRect.x + slotRect.width);
    const y1 = Math.min(ssH, slotRect.y + slotRect.height);
    const w = x1-x0, h = y1-y0;
    const out = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const si = ((y0+j)*ssW + (x0+i)) * 4;
        const di = (j*w+i) * 4;
        out[di]   = ssRgba[si];
        out[di+1] = ssRgba[si+1];
        out[di+2] = ssRgba[si+2];
        out[di+3] = 255;
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, `debug_dream_slot1_${label}.png`), encodePng(out, w, h));
    console.log(`  saved slot crop ${label}: ${w}x${h} @ (${x0},${y0})`);
  }

  // Also save a corrected dream rect (extended upward by CALIBRATION_TOP_CORRECTION)
  const correctedDreamH = dreamRect.height / (1 - CALIBRATION_TOP_CORRECTION);
  const correctedDreamY = dreamRect.y - CALIBRATION_TOP_CORRECTION * correctedDreamH;
  const correctedDreamRect = {
    x: dreamRect.x, y: Math.round(correctedDreamY),
    width: dreamRect.width, height: Math.round(correctedDreamH),
  };

  console.log('\nSaving slot crops:');
  saveSlotCrop(dreamRect,          'dream');
  saveSlotCrop(correctedDreamRect, 'dream_corrected');
  saveSlotCrop(normalRect,         'normal');
}

main();
